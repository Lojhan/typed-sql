import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Query, QueryValueError } from "@typed-sql/core";
import { Pool } from "pg";
import { strict } from "poku";
import { compileSource } from "../../packages/compiler/src/index.js";
import { postgres } from "../../packages/postgres/src/analysis.js";
import { adaptPgPool, pg } from "../../packages/postgres/src/pg.js";
import { createPostgresDatabase } from "../../packages/postgres/src/runtime.js";
import { defaultPostgresTypePolicy } from "../../packages/postgres/src/type-policy.js";

interface Factories {
  select(id: bigint, state: string): Query<Record<string, unknown>>;
  insert(id: bigint, state: string, states: readonly (string | null)[]): Query<Record<string, unknown>>;
  changed(): Query<Record<string, unknown>>;
  conditional(): Query<Record<string, unknown>>;
}

/** Real schema metadata -> compiled factories -> actual enum/enum-array parameter and row codecs. */
export async function assertPostgresEnumCodecs(connectionString: string, workspace: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  const namespace = `typed_sql_enum_${randomBytes(8).toString("hex")}`;
  let created = false;
  const directory = await mkdtemp(join(workspace, ".typed-sql-enum-codecs-"));
  try {
    await pool.query(`CREATE SCHEMA ${namespace}`);
    created = true;
    await pool.query(`CREATE TYPE ${namespace}.mood AS ENUM ('happy','sad');
      CREATE TABLE ${namespace}.records(id bigint PRIMARY KEY,state ${namespace}.mood NOT NULL,optional ${namespace}.mood,states ${namespace}.mood[] NOT NULL);
      INSERT INTO ${namespace}.records VALUES(1,'happy',NULL,ARRAY['happy'::${namespace}.mood,NULL]);`);
    const variants: { readonly enums: "string" | "string-union"; readonly factories: Factories }[] = [];
    for (const enums of ["string-union", "string"] as const) {
      const typePolicy = { ...defaultPostgresTypePolicy, enums };
      const schema = await pg({ connectionString, schemas: [namespace], typePolicy }).introspect();
      const scalar = enums === "string" ? "string" : '"happy"|"sad"';
      const source = [
        'import {sql} from "@typed-sql/postgres";',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Application source compiled before importing it.
        "export const select=(id:bigint,state:ENUM)=>sql`SELECT id,state,optional,states FROM NAMESPACE.records WHERE id=${id} AND state=${state}`;",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Application source compiled before importing it.
        "export const insert=(id:bigint,state:ENUM,states:readonly(ENUM|null)[])=>sql`INSERT INTO NAMESPACE.records(id,state,states) VALUES(${id},${state},${states}) RETURNING state,states`;",
        "export const changed=()=>sql`SELECT CASE WHEN id=99 THEN state ELSE NULL END AS state FROM NAMESPACE.records WHERE id=99`;",
        "export const conditional=()=>sql`SELECT CASE WHEN id=1 THEN state ELSE NULL END AS state, CASE WHEN id=1 THEN states ELSE NULL END AS states FROM NAMESPACE.records WHERE id=1`;",
      ]
        .join("\n")
        .replaceAll("NAMESPACE", namespace)
        .replaceAll("ENUM", scalar);
      const compiled = compileSource({ source, schema, dialect: postgres({ typePolicy }), runtimeMetadata: true });
      strict.deepEqual(compiled.diagnostics, []);
      strict.equal(compiled.queries.length, 4);
      strict.ok(compiled.queries.every((query) => query.valuePlan?.columns.every(({ type }) => type !== "unknown")));
      const file = join(directory, `${enums}.mts`);
      await writeFile(file, compiled.transformedSource);
      const factories = (await import(pathToFileURL(file).href)) as Factories;
      variants.push({ enums, factories });
      const database = createPostgresDatabase({
        pool: adaptPgPool(new Pool({ connectionString, max: 1 })),
        ownsPool: true,
        typePolicy,
      });
      try {
        strict.deepEqual(await database.all(factories.select(1n, "happy")), [
          { id: 1n, state: "happy", optional: null, states: ["happy", null] },
        ]);
        strict.deepEqual(await database.all(factories.conditional()), [{ state: "happy", states: ["happy", null] }]);
        strict.deepEqual(await database.all(factories.insert(enums === "string" ? 3n : 2n, "sad", ["sad", null])), [
          { state: "sad", states: ["sad", null] },
        ]);
        if (enums === "string-union") {
          await strict.rejects(
            database.all(factories.select(1n, "not-declared")),
            (error) => error instanceof QueryValueError,
          );
          await strict.rejects(
            database.all(factories.insert(4n, "happy", ["not-declared"])),
            (error) => error instanceof QueryValueError,
          );
        }
      } finally {
        await database.close();
      }
    }
    // The factories retain the original schema's labels. Strict decoding must reject an unseen
    // server label; the explicitly selected string policy deliberately accepts string values.
    await pool.query(`ALTER TYPE ${namespace}.mood ADD VALUE 'future'`);
    await pool.query(`INSERT INTO ${namespace}.records VALUES(99,'future',NULL,ARRAY['future'::${namespace}.mood])`);
    for (const { enums, factories } of variants) {
      const typePolicy = { ...defaultPostgresTypePolicy, enums };
      const database = createPostgresDatabase({
        pool: adaptPgPool(new Pool({ connectionString, max: 1 })),
        ownsPool: true,
        typePolicy,
      });
      try {
        if (enums === "string") strict.deepEqual(await database.all(factories.changed()), [{ state: "future" }]);
        else await strict.rejects(database.all(factories.changed()), (error) => error instanceof QueryValueError);
      } finally {
        await database.close();
      }
    }
  } finally {
    try {
      if (created) await pool.query(`DROP SCHEMA ${namespace} CASCADE`);
    } finally {
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
