import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { SchemaSnapshot } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { postgresServerEvidence } from "../src/capabilities.js";
import { postgresCatalogProvider } from "../src/catalog/index.js";
import { createPostgresCatalogProvider } from "../src/catalog/provider.js";
import { resolvePostgresExtensionManifests } from "../src/extension-resolution.js";
import { POSTGRES_SUPPORT_POLICY } from "../src/support.js";
import { createPostgresTypeResolver } from "../src/type-resolution-factory.js";

const esbuild = createRequire(new URL("../../build/package.json", import.meta.url))("esbuild");
const majors = [...POSTGRES_SUPPORT_POLICY.stableMajors, POSTGRES_SUPPORT_POLICY.canary.major];
const schema = (major: number): SchemaSnapshot => ({
  formatVersion: 1,
  dialect: "postgres",
  version: `${major}.0`,
  tables: {},
});

await describe("PostgreSQL catalog ownership", async () => {
  for (const major of majors) {
    await it(`retains ${major} facts independently of every other supported major`, () => {
      const original = postgresCatalogProvider.catalog(major)!;
      const selected = createPostgresCatalogProvider([original], major);
      const snapshot = schema(major);
      strict.deepEqual(selected.catalog(major), original);
      strict.notStrictEqual(selected.catalog(major), original);
      strict.strictEqual(selected.forSchema(snapshot), selected.catalog(major));
      for (const other of majors) if (other !== major) strict.strictEqual(selected.catalog(other), undefined);
      for (const type of original.types)
        for (const alias of [type.name, ...type.aliases]) {
          strict.deepEqual(selected.type(alias, snapshot), postgresCatalogProvider.type(alias, snapshot));
          strict.strictEqual(
            selected.typeMapping(alias, snapshot),
            postgresCatalogProvider.typeMapping(alias, snapshot),
          );
        }
      for (const cast of original.casts) {
        strict.deepEqual(
          selected.cast(cast.source, cast.target, snapshot),
          postgresCatalogProvider.cast(cast.source, cast.target, snapshot),
        );
        for (const context of ["implicit", "assignment", "explicit"] as const)
          strict.strictEqual(
            selected.canCast(cast.source, cast.target, context, snapshot),
            postgresCatalogProvider.canCast(cast.source, cast.target, context, snapshot),
          );
      }
      for (const family of original.operators)
        for (const name of family.operators)
          strict.strictEqual(
            selected.operatorRule(name, snapshot),
            postgresCatalogProvider.operatorRule(name, snapshot),
          );
      for (const family of original.routines)
        for (const name of family.routines)
          strict.strictEqual(selected.routineRule(name, snapshot), postgresCatalogProvider.routineRule(name, snapshot));
      for (const family of original.tableRoutines)
        for (const name of family.routines)
          strict.strictEqual(
            selected.tableRoutineRule(name, snapshot),
            postgresCatalogProvider.tableRoutineRule(name, snapshot),
          );
    });
  }

  await it("keeps explicit fallback policy and server evidence precedence", () => {
    const input = [postgresCatalogProvider.catalog(17)!, postgresCatalogProvider.catalog(18)!];
    const provider = createPostgresCatalogProvider(input, 17);
    strict.strictEqual(provider.forSchema().major, 17);
    strict.strictEqual(provider.forSchema(schema(999)).major, 17);
    strict.strictEqual(provider.forSchema({ ...schema(18), version: "unknown" }).major, 17);
    const server = {
      product: "postgres",
      version: "18.6",
      versionKey: "18",
      settings: {},
      features: [],
    } as const;
    strict.strictEqual(provider.forSchema({ ...schema(17), server }).major, 18);
    strict.strictEqual(provider.canCast("integer", "bytea", "explicit", schema(17)), false);
    strict.strictEqual(provider.canCast("integer", "bytea", "explicit", { ...schema(17), server }), true);
    strict.strictEqual(provider.canCast("int4", "integer", "implicit"), true);
    strict.strictEqual(provider.cast("not_a_type", "integer"), undefined);
    strict.strictEqual(provider.canCast("not_a_type", "integer", "explicit"), false);
    strict.strictEqual(provider.typeMapping("interval day to second"), "string");
    strict.throws(() => createPostgresCatalogProvider(input, 16), /Missing PostgreSQL fallback catalog 16/u);
    strict.throws(() => createPostgresCatalogProvider([input[0]!, input[0]!], 17), /Duplicate PostgreSQL catalog 17/u);
  });

  await it("owns nested input and isolates indexes between providers with the same major", () => {
    const original = postgresCatalogProvider.catalog(18)!;
    const before = structuredClone(original);
    const input = {
      ...structuredClone(original),
      types: original.types.map((type) => ({ ...type, aliases: [...type.aliases] })),
    };
    // Deliberately conflicting owners exercise index isolation under the same schema identity.
    const changed = {
      ...input,
      casts: input.casts.filter((cast) => !(cast.source === "integer" && cast.target === "bytea")),
      routines: input.routines.filter((family) => !family.routines.includes("COUNT")),
    };
    const first = createPostgresCatalogProvider([input], 18);
    const second = createPostgresCatalogProvider([changed], 18);
    const snapshot = schema(18);
    strict.strictEqual(first.canCast("integer", "bytea", "explicit", snapshot), true);
    strict.strictEqual(second.canCast("integer", "bytea", "explicit", snapshot), false);
    strict.strictEqual(first.routineRule("COUNT", snapshot), "count");
    strict.strictEqual(second.routineRule("COUNT", snapshot), undefined);
    const callerTypes = input.types;
    const ownedName = callerTypes[0]!.name;
    callerTypes[0]!.name = "caller_mutation";
    strict.ok(first.type(ownedName, snapshot));
    strict.strictEqual(first.type("caller_mutation", snapshot), undefined);
    strict.ok(Object.isFrozen(first));
    strict.ok(Object.isFrozen(first.catalog(18)?.types[0]));
    strict.ok(Object.isFrozen(first.catalog(18)?.types[0]?.aliases));
    strict.ok(Object.isFrozen(first.catalog(18)?.casts));
    strict.strictEqual(first.canCast("integer", "bytea", "explicit", snapshot), true);
    strict.deepEqual(postgresCatalogProvider.catalog(18), before);
  });

  await it("keeps coercion and operator caches with their catalog owner, even for the same snapshot", () => {
    const original = postgresCatalogProvider.catalog(18)!;
    const restricted = {
      ...original,
      casts: original.casts.filter((cast) => !(cast.source === "integer" && cast.target === "bytea")),
      operators: original.operators.map((family) => ({
        ...family,
        operators: family.operators.filter((name) => name !== "+"),
      })),
    };
    const first = createPostgresTypeResolver(createPostgresCatalogProvider([original], 18));
    const second = createPostgresTypeResolver(createPostgresCatalogProvider([restricted], 18));
    // Exercise both snapshot-indexed caches and the schema-free default cache in both orders.
    for (const snapshot of [schema(18), undefined]) {
      strict.strictEqual(first.postgresCanCoerce("integer", "bytea", "explicit", snapshot), true);
      strict.strictEqual(second.postgresCanCoerce("integer", "bytea", "explicit", snapshot), false);
      const result = first.resolvePostgresOperator("+", "integer", "integer", snapshot);
      strict.strictEqual(result.kind, "selected");
      if (result.kind === "selected") strict.strictEqual(result.resultType, "integer");
      strict.strictEqual(second.resolvePostgresOperator("+", "integer", "integer", snapshot).kind, "none");
      strict.deepEqual(first.resolvePostgresOperator("+", "integer", "integer", snapshot), result);
      strict.strictEqual(second.resolvePostgresOperator("+", "integer", "integer", snapshot).kind, "none");
    }
  });

  await it("checks extension cast collisions against the supplied major rather than the global registry", () => {
    const older = createPostgresCatalogProvider([postgresCatalogProvider.catalog(17)!], 17);
    const newer = createPostgresCatalogProvider([postgresCatalogProvider.catalog(18)!], 18);
    const snapshot = { ...schema(18), server: postgresServerEvidence("18.6", ["owner_test:1"]) };
    const manifest = {
      formatVersion: 1,
      name: "owner_test",
      revision: "1",
      supportedVersions: ["1"],
      casts: [{ sourceType: "integer", targetType: "bytea", context: "explicit" }],
    } as const;
    strict.deepEqual(resolvePostgresExtensionManifests(snapshot, [manifest], older).issues, []);
    const rejected = resolvePostgresExtensionManifests(snapshot, [manifest], newer);
    strict.strictEqual(rejected.issues.length, 1);
    strict.match(rejected.issues[0]!.message, /conflicts with existing cast evidence/u);
  });

  await it("can load catalog mechanics without any generated catalog, registry, or driver", async () => {
    for (const relative of ["catalog/provider", "type-resolution-factory", "extension-resolution"]) {
      const entry = fileURLToPath(new URL(`../src/${relative}.ts`, import.meta.url));
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        metafile: true,
      });
      const inputs = Object.keys(result.metafile.inputs);
      strict.ok(inputs.some((input) => input.endsWith(`${relative}.ts`)));
      strict.ok(!inputs.some((input) => /catalog\/(?:generated\/|index\.ts$)/u.test(input)));
      strict.ok(!inputs.some((input) => /node_modules\/(?:pg|pg-native|pg-pool)\//u.test(input)));
    }
  });
});
