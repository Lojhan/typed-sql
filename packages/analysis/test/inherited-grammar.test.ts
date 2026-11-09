import { postgresServerEvidence } from "@typed-sql/postgres/analysis";
import { describe, it, strict } from "poku";
import { inheritedPostgres } from "./helpers/inherited-postgres.js";

const schema = {
  formatVersion: 1,
  dialect: "postgres",
  server: postgresServerEvidence("18.3"),
  tables: {},
} as const;

await describe("contributed grammar inherits public base mechanisms", async () => {
  await it("owns snapshot identity while delegating offline syntax, policy and parameter mapping", () => {
    const owner = inheritedPostgres(schema);
    strict.equal(owner.snapshot.dialect, owner.profile.id);
    strict.equal(owner.snapshot.dialectVersion, owner.profile.grammarVersion);
    strict.throws(() => owner.profile.validateSnapshot(schema), /identity/u);
    strict.throws(() => owner.profile.validateSnapshot({ ...owner.snapshot, dialectVersion: "other" }), /identity/u);
    strict.throws(() => inheritedPostgres({ ...schema, server: postgresServerEvidence("17.0") }), /18/u);
    const text = "SELECT COALESCE($1::bigint, $2::bigint) AS value";
    const result = owner.analyzer.analyze(text, owner.snapshot);
    strict.deepEqual(result.diagnostics, []);
    strict.equal(result.columns[0]!.tsType, "bigint");
    strict.equal(result.columns[0]!.nullable, true);
    strict.deepEqual(
      result.parameters.map(({ index, tsType }) => [index, tsType]),
      [
        [1, "bigint"],
        [2, "bigint"],
      ],
    );
    strict.deepEqual(
      owner.profile.parameterOccurrences!(text, owner.snapshot).map(({ index }) => index),
      [1, 2],
    );
    strict.equal(owner.profile.placeholder(2), "$2");
    strict.equal(owner.profile.quoteIdentifier('a"b'), '"a""b"');
    strict.ok(
      owner.analyzer
        .analyze("SELECT vendor_long_tail($1::bigint) AS value", owner.snapshot)
        .diagnostics.some(({ code }) => code === "TSQ408"),
    );
    strict.equal(owner.contribution.grammar.id, owner.profile.id);
  });
  await it("inherits native statement restrictions without opening services or transferring reusable permissions", () => {
    let connections = 0;
    const owner = inheritedPostgres(schema);
    const adapter = owner.native({
      pool: {
        async connect() {
          connections++;
          throw Error("Must remain cold");
        },
      },
    });
    strict.equal(connections, 0);
    strict.equal(adapter.grammar.id, owner.profile.id);
    strict.equal(adapter.projectCatalogOwner, undefined);
    strict.equal(adapter.accept({ sql: "DELETE FROM items", parameterOccurrences: [] }).accepted, false);
    strict.equal(
      adapter.accept({ sql: "SELECT $1::bigint AS value", parameterOccurrences: [{ index: 1, start: 7, end: 9 }] })
        .accepted,
      true,
    );
    strict.equal(connections, 0);
  });
});
