import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { exportQueryContracts } from "../../analysis/src/index.js";
import { context, execute, fixture } from "./helpers/contract-fixture.js";

await describe("frozen CLI project checking", async () => {
  await it("keeps registered live factories cold for offline/frozen overrides and invalid source", async () => {
    await fixture(async (directory) => {
      const path = join(directory, "typed-sql.config.mjs");
      const original = await readFile(path, "utf8");
      await writeFile(
        path,
        original.replace(
          'analysis:{mode:"frozen",',
          `analysis:{mode:"live",live:{adapter(){throw Error("native factory must remain cold")}},cache:${JSON.stringify({ connectionContext: context.databaseContextHash, adapter: { id: "vendor/native", version: "1" } })},`,
        ),
      );
      strict.match((await execute(directory, ["--offline"])).stdout, /Offline checked/u);
      strict.match((await execute(directory, ["--frozen"])).stdout, /Frozen checked/u);
      await writeFile(
        join(directory, "src/query.ts"),
        'import {sql} from "@typed-sql/postgres/tag";sql.dynamic(input);',
      );
      await strict.rejects(execute(directory, ["--live"]), (error: unknown) => {
        const stderr = (error as { stderr: string }).stderr;
        strict.match(stderr, /TSQ005/u);
        strict.ok(!stderr.includes("factory must remain cold"));
        strict.ok(!stderr.includes("analyzer must remain cold"));
        return true;
      });
    });
  });
  await it("preserves ordinary offline checking for configurations without query-contract settings", async () => {
    await fixture(async (directory) => {
      const path = join(directory, "typed-sql.config.mjs");
      const original = await readFile(path, "utf8");
      const legacy = `${original.slice(0, original.indexOf("analysis:"))}});`.replace(
        'loadAnalyzer(){throw new Error("analyzer must remain cold")}',
        'loadAnalyzer:async()=>(await import("@typed-sql/postgres")).postgres()',
      );
      await writeFile(path, legacy);
      strict.match((await execute(directory, ["--offline"])).stdout, /Checked 1 project/u);
    });
  });
  await it("uses durable contracts offline and loads the analyzer only for uncovered hybrid queries", async () => {
    await fixture(async (directory) => {
      strict.match((await execute(directory, ["--offline"])).stdout, /Offline checked 1 project/u);
      const configPath = join(directory, "typed-sql.config.mjs");
      const original = await readFile(configPath, "utf8");
      await writeFile(configPath, original.replace('mode:"frozen"', 'mode:"live"'));
      strict.match((await execute(directory, ["--offline"])).stdout, /Offline checked 1 project/u);
      await strict.rejects(execute(directory, ["--live"]), (error: unknown) => {
        strict.match((error as { stderr: string }).stderr, /analysis.live.adapter/u);
        return true;
      });
      await writeFile(
        configPath,
        original
          .replace('mode:"frozen"', 'mode:"offline"')
          .replace(
            'loadAnalyzer(){throw new Error("analyzer must remain cold")}',
            'loadAnalyzer:async()=>(await import("@typed-sql/postgres")).postgres()',
          ),
      );
      await exportQueryContracts(join(directory, "generated/contracts"), []);
      strict.match((await execute(directory)).stdout, /Offline checked 1 project/u);
      await writeFile(
        configPath,
        original.replace('mode:"frozen"', 'mode:"offline"').replace('mode:"hybrid"', 'mode:"native-required"'),
      );
      await strict.rejects(execute(directory), (error: unknown) => {
        const failure = (error as { stderr: string }).stderr;
        strict.match(failure, /TSQ406/u);
        strict.ok(!failure.includes("analyzer must remain cold"));
        return true;
      });
    });
  });
  await it("checks TypeScript and SQL assets from durable inputs while ignoring disposable state and cold factories", async () => {
    await fixture(async (directory) => {
      await writeFile(join(directory, "src/value.sql"), "SELECT :id::bigint AS value");
      await writeFile(
        join(directory, "src/asset.ts"),
        'import query from "./value.sql"; export const value = query({id:1n});',
      );
      const initial = await execute(directory, ["--frozen", "--show-types"]);
      strict.match(initial.stdout, /Frozen checked 1 project/u);
      strict.match(initial.stdout, /bigint/u);
      const cache = join(directory, ".typed-sql/cache/analysis/v1");
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, "ownership.json"), "corrupt disposable state");
      const repeated = await execute(directory, ["--show-types"]);
      strict.equal(repeated.stdout, initial.stdout);
      strict.equal(await readFile(join(cache, "ownership.json"), "utf8"), "corrupt disposable state");
      const single = await execute(directory, ["--frozen", "--file", "src/query.ts"]);
      strict.match(single.stdout, /Frozen checked 1 project/u);
    });
  });
  await it("does not fall back to an analyzer or orphan/cache objects when contracts are missing", async () => {
    await fixture(async (directory) => {
      await exportQueryContracts(join(directory, "generated/contracts"), []);
      await strict.rejects(
        () => execute(directory, ["--frozen"]),
        (error: unknown) => {
          const failure = error as { stderr: string };
          strict.match(failure.stderr, /TSQ406/u);
          strict.ok(!failure.stderr.includes("analyzer must remain cold"));
          return true;
        },
      );
      await writeFile(
        join(directory, "src/query.ts"),
        'import {sql} from "@typed-sql/postgres/tag"; sql.dynamic(userSql);',
      );
      await strict.rejects(
        () => execute(directory, ["--frozen"]),
        (error: unknown) => {
          strict.match((error as { stderr: string }).stderr, /TSQ005/u);
          return true;
        },
      );
    });
  });
  await it("rejects TypeScript parameter errors and conflicting activation flags", async () => {
    await fixture(async (directory) => {
      await writeFile(
        join(directory, "src/query.ts"),
        'import {sql} from "@typed-sql/postgres/tag"; export function query(value:string){return sql`SELECT ${value}::bigint AS value`;}',
      );
      await strict.rejects(
        () => execute(directory, ["--frozen"]),
        (error: unknown) => {
          const failure = error as { stderr: string };
          strict.match(failure.stderr, /not assignable/u);
          return true;
        },
      );
      await strict.rejects(
        () => execute(directory, ["--frozen", "--live"]),
        (error: unknown) => {
          strict.match((error as { stderr: string }).stderr, /cannot be combined/u);
          return true;
        },
      );
      for (const flag of ["--frozen=false", "--live=false"])
        await strict.rejects(
          () => execute(directory, [flag]),
          (error: unknown) => {
            strict.match((error as { stderr: string }).stderr, /boolean check option/u);
            return true;
          },
        );
    });
  });
});
