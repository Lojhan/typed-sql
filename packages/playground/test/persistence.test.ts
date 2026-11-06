import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { startPlayground } from "../src/server.js";
import { fixture } from "./helpers/fixture.js";

await describe("repository-backed query persistence", async () => {
  await it("retains nested query files across host sessions and protects external edits", async () =>
    fixture(async (directory) => {
      const config = join(directory, "typed-sql.config.mjs");
      let host = await startPlayground({ config });
      const post = async (path: string, body: unknown) =>
        fetch(`${host.origin}/api/${path}`, {
          method: "POST",
          headers: { "x-typed-sql-session": host.token, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const state = async () => {
        const response = await fetch(`${host.origin}/api/state`, { headers: { "x-typed-sql-session": host.token } });
        return { response, value: await response.json() };
      };
      const source = "select id, name from public.accounts;\n";
      try {
        const before = await state();
        const empty = await post("folder", { folder: "playground/reports/empty" });
        strict.equal(empty.status, 201);
        strict.deepEqual(await empty.json(), { folder: "playground/reports/empty" });
        strict.equal((await stat(join(directory, "playground/reports/empty"))).isDirectory(), true);
        strict.deepEqual(await readdir(join(directory, "playground/reports/empty")), []);
        strict.equal((await post("folder", { folder: "playground/reports/empty" })).status, 409);
        strict.equal((await post("folder", { folder: "../outside" })).status, 400);
        const after = await state();
        strict.notEqual(after.response.headers.get("etag"), before.response.headers.get("etag"));
        strict.ok(after.value.folders.includes("playground/reports/empty"));
        strict.ok(!after.value.files.includes("playground/reports/empty"));
        const created = await post("save", { file: "playground/reports/accounts.sql", source, revision: null });
        strict.equal(created.status, 200);
        const saved = await created.json();
        const moved = await post("move", {
          file: "playground/reports/accounts.sql",
          to: "playground/reports/customers.sql",
          revision: saved.revision,
        });
        strict.equal(moved.status, 200);
        const oldToken = host.token;
        await host.close();
        host = await startPlayground({ config });
        strict.notEqual(host.token, oldToken);
        const reopenedState = await (
          await fetch(`${host.origin}/api/state`, { headers: { "x-typed-sql-session": host.token } })
        ).json();
        strict.ok(reopenedState.files.includes("playground/reports/customers.sql"));
        strict.ok(!reopenedState.files.includes("playground/reports/accounts.sql"));
        strict.ok(
          reopenedState.folders.includes("playground/reports/empty"),
          "empty folders survive a new host session",
        );
        strict.deepEqual(await readdir(join(directory, "playground/reports/empty")), []);
        const nested = await post("save", {
          file: "playground/reports/empty/nested/query.sql",
          source: "select 42;",
          revision: null,
        });
        strict.equal(nested.status, 200);
        strict.equal(
          await readFile(join(directory, "playground/reports/empty/nested/query.sql"), "utf8"),
          "select 42;",
        );
        strict.ok((await state()).value.folders.includes("playground/reports/empty/nested"));
        const reopened = await post("file", { file: "playground/reports/customers.sql" });
        strict.equal(reopened.status, 200);
        const current = await reopened.json();
        strict.equal(current.source, source);
        strict.equal(await readFile(join(directory, "playground/reports/customers.sql"), "utf8"), source);
        const external = "select id from public.accounts order by id;\n";
        await writeFile(join(directory, "playground/reports/customers.sql"), external);
        const stale = await post("save", {
          file: "playground/reports/customers.sql",
          source: "select name from public.accounts;\n",
          revision: current.revision,
        });
        strict.equal(stale.status, 409);
        strict.equal(await readFile(join(directory, "playground/reports/customers.sql"), "utf8"), external);
        strict.equal(
          (await (await post("file", { file: "playground/reports/customers.sql" })).json()).source,
          external,
        );
      } finally {
        await host.close();
      }
    }));
});
