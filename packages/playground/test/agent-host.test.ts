import { join } from "node:path";
import { describe, it, strict } from "poku";
import { startPlayground } from "../src/server.js";
import { fixture } from "./helpers/fixture.js";

await describe("local agent host integration", async () => {
  await it("authenticates routes, requires trust and restores project conversations across sessions", async () =>
    fixture(async (directory) => {
      const previous = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = join(directory, "user-config");
      let host = await startPlayground({ config: join(directory, "typed-sql.config.mjs") });
      const get = (path: string) =>
        fetch(`${host.origin}/api/${path}`, { headers: { "x-typed-sql-session": host.token } });
      const post = (path: string, body: unknown) =>
        fetch(`${host.origin}/api/${path}`, {
          method: "POST",
          headers: { "x-typed-sql-session": host.token, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const profile = {
        id: "local",
        name: "Local test",
        command: process.execPath,
        args: ["private-arg"],
        protocol: "acp",
      };
      try {
        strict.equal((await fetch(`${host.origin}/api/agents`)).status, 403);
        strict.equal((await get("agents/configure")).status, 405);
        strict.equal((await post("agents/configure", { profile })).status, 403);
        strict.equal((await post("trust", { enable: true })).status, 200);
        strict.equal((await post("agents/configure", { profile })).status, 200);
        const listing = await (await get("agents")).json();
        strict.equal(listing.profiles[0].name, "Local test");
        strict.equal(listing.profiles[0].args, undefined);
        const created = await post("agents/new", { profileId: "local" });
        strict.equal(created.status, 200);
        const conversation = await created.json();
        await host.close();
        host = await startPlayground({ config: join(directory, "typed-sql.config.mjs") });
        const restored = await (await get("agents")).json();
        strict.equal(restored.profiles[0].id, "local");
        strict.ok(restored.conversations.some((item: { id: string }) => item.id === conversation.id));
        strict.equal((await get(`agents/conversation?id=${conversation.id}`)).status, 403);
        await post("trust", { enable: true });
        const opened = await get(`agents/conversation?id=${conversation.id}`);
        strict.equal(opened.status, 200);
        strict.equal((await opened.json()).id, conversation.id);
      } finally {
        await host.close();
        if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previous;
      }
    }));
});
