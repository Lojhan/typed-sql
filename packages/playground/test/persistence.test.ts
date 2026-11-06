import { readFile, writeFile } from "node:fs/promises";
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
      const source = "select id, name from public.accounts;\n";
      try {
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
        const state = await (
          await fetch(`${host.origin}/api/state`, { headers: { "x-typed-sql-session": host.token } })
        ).json();
        strict.ok(state.files.includes("playground/reports/customers.sql"));
        strict.ok(!state.files.includes("playground/reports/accounts.sql"));
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
