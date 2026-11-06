import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { startPlayground } from "../src/server.js";
import { decodeValue, encodeValue } from "../src/values.js";
import { fixture } from "./helpers/fixture.js";

await describe("local playground protocol and project files", async () => {
  await it("is lazy, offline-capable, authenticated and confined to loopback", async () =>
    fixture(async (directory) => {
      const server = await startPlayground({ config: join(directory, "typed-sql.config.mjs") });
      try {
        strict.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
        strict.equal((await fetch(`${server.origin}/api/state`)).status, 403);
        strict.equal(
          (
            await fetch(`${server.origin}/api/state`, {
              headers: { "x-typed-sql-session": server.token, origin: "https://attacker.example" },
            })
          ).status,
          403,
        );
        strict.equal(
          await new Promise<number>((resolve) => {
            const request = httpRequest(
              `${server.origin}/api/state`,
              { headers: { "x-typed-sql-session": server.token, host: "attacker.example" } },
              (response) => {
                response.resume();
                resolve(response.statusCode!);
              },
            );
            request.end();
          }),
          403,
        );
        const response = await fetch(`${server.origin}/api/state`, {
          headers: { "x-typed-sql-session": server.token },
        });
        const state = await response.json();
        strict.equal(state.connection.state, "offline");
        strict.equal(state.board.tables[0].name, "accounts");
        strict.equal(state.board.capturedRelationships, false);
        strict.equal(state.trusted, false);
        strict.equal(
          (
            await fetch(`${server.origin}/api/state`, {
              headers: { "x-typed-sql-session": server.token, "if-none-match": response.headers.get("etag")! },
            })
          ).status,
          304,
        );
        const html = await fetch(server.origin);
        strict.match(html.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
        strict.match(await html.text(), /typed-sql/);
        const post = async (path: string, body: unknown) =>
          fetch(`${server.origin}/api/${path}`, {
            method: "POST",
            headers: { "x-typed-sql-session": server.token, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        strict.equal((await post("save", { file: "../outside.ts", source: "", revision: null })).status, 400);
        strict.equal((await post("save", { file: "schema.json", source: "", revision: null })).status, 403);
        strict.equal(
          (await post("save", { file: "playground/new.ts", source: "export const value=1;", revision: null })).status,
          200,
        );
        strict.equal(
          (await post("save", { file: "playground/new.ts", source: "overwrite", revision: null })).status,
          409,
        );
        strict.equal(await readFile(join(directory, "playground/new.ts"), "utf8"), "export const value=1;");
        const analyzed = await (
          await post("analyze", { file: "playground/new.ts", source: "export async function run(){return [];}" })
        ).json();
        strict.deepEqual(analyzed.exports, ["run"]);
        strict.equal(
          (
            await post("run", {
              requestId: "offline-run-123",
              file: "playground/new.ts",
              revision: "old",
              mode: "file",
            })
          ).status,
          403,
        );
      } finally {
        await server.close();
      }
    }));
  await it("generates real grammar-qualified query files and a pinned runtime helper", async () =>
    fixture(async (directory) => {
      const server = await startPlayground({ config: join(directory, "typed-sql.config.mjs"), target: "local" });
      try {
        const response = await fetch(`${server.origin}/api/create-query`, {
          method: "POST",
          headers: { "x-typed-sql-session": server.token, "content-type": "application/json" },
          body: JSON.stringify({ table: "public.accounts", file: "playground/accounts.ts" }),
        });
        strict.equal(response.status, 200);
        strict.match(await readFile(join(directory, "playground/accounts.ts"), "utf8"), /from "public"\."accounts"/);
        strict.match(await readFile(join(directory, "playground/db.ts"), "utf8"), /databaseForRun/);
        const state = await (
          await fetch(`${server.origin}/api/state`, { headers: { "x-typed-sql-session": server.token } })
        ).json();
        strict.deepEqual(state.files, ["playground/accounts.ts", "playground/db.ts"]);
        const catalog = await (
          await fetch(`${server.origin}/api/state?catalog=${state.schemaHash}`, {
            headers: { "x-typed-sql-session": server.token },
          })
        ).json();
        strict.equal(catalog.board, undefined);
      } finally {
        await server.close();
      }
    }));
  await it("roundtrips typed values without key collisions, precision loss or unsafe coercion", () => {
    const original = {
      kind: "bigint",
      value: "an ordinary object",
      id: 9007199254740993n,
      null: null,
      missing: undefined,
      bytes: new Uint8Array([1, 2]),
      date: new Date("2026-11-06T12:00:00Z"),
    };
    const decoded = decodeValue(JSON.parse(JSON.stringify(encodeValue(original))));
    strict.deepEqual(decoded, { ...original, bytes: Buffer.from([1, 2]) });
    const circular: unknown[] = [];
    circular.push(circular);
    strict.throws(() => encodeValue(circular), /Cyclic/);
    strict.throws(() => encodeValue(() => undefined), /functions/);
  });
});

await describe("SQL declaration and read-only file workflows", async () => {
  await it("generates only explicitly requested SQL declarations and refuses application-owned files", async () =>
    fixture(async (directory) => {
      await writeFile(join(directory, "playground/query.sql"), "select id from public.accounts where id=:id");
      const server = await startPlayground({ config: join(directory, "typed-sql.config.mjs"), target: "local" });
      const post = async (path: string, body: unknown) =>
        fetch(`${server.origin}/api/${path}`, {
          method: "POST",
          headers: { "x-typed-sql-session": server.token, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      try {
        const file = await (await post("file", { file: "playground/query.sql" })).json();
        const generated = await post("sql-types", { file: "playground/query.sql", revision: file.revision });
        strict.equal(generated.status, 200);
        strict.match(
          await readFile(join(directory, "playground/query.d.sql.ts"), "utf8"),
          /Generated by @typed-sql\/build/,
        );
        await writeFile(join(directory, "playground/query.d.sql.ts"), "// application owned\nexport default 42;");
        strict.equal((await post("sql-types", { file: "playground/query.sql", revision: file.revision })).status, 409);
        strict.equal(
          await readFile(join(directory, "playground/query.d.sql.ts"), "utf8"),
          "// application owned\nexport default 42;",
        );
        strict.equal((await post("sql-types", { file: "playground/query.sql", revision: "stale" })).status, 409);
      } finally {
        await server.close();
      }
    }));
});

await describe("untyped configuration validation", async () => {
  await it("rejects malformed target policy before any lazy connection factory is called", async () =>
    fixture(async (directory) => {
      const config = join(directory, "typed-sql.config.mjs");
      await writeFile(
        config,
        (await readFile(config, "utf8"))
          .replace("classification:'development'", "classification:'prod'")
          .replace("connect:()=>({", 'connect:()=>{throw new Error("factory must not execute");return ({')
          .replace("close:async()=>{}})}}}};", "close:async()=>{}});}}}}};"),
      );
      await strict.rejects(
        startPlayground({ config, target: "local" }),
        /classification must be development, test, or production/,
      );
    }));
});
