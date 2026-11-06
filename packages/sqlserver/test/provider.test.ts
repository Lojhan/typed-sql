import { parseSchemaSnapshot, serializeSchemaSnapshot } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { sqlserver } from "../src/browser.js";
import { sqlServerCatalogQueries as queries, SqlServerSchemaProvider } from "../src/provider.js";

import { fixture } from "./helpers/catalog-fixture.js";

await describe("SQL Server complete catalog snapshots", async () => {
  await it("captures v2 native identities, generated columns, collations, constraints, indexes and routines", async () => {
    const state = fixture(),
      snapshot = await new SqlServerSchemaProvider({ client: state.client, includeSchemas: ["dbo"] }).introspect({});
    strict.equal(snapshot.server.version, "17.0.5035.5");
    strict.equal(snapshot.types["dbo.OrderId"]?.databaseType, "bigint");
    const relation = snapshot.relations["dbo.orders"]!;
    strict.equal(relation.columns.id?.identity, "always");
    strict.equal(relation.columns.id?.insertable, false);
    strict.equal(relation.columns.label?.generated, "stored");
    strict.equal(relation.columns.label?.position, 2);
    strict.equal(relation.columns.status?.collation, "SQL_Latin1_General_CP1_CI_AS");
    strict.equal(relation.capabilities?.outputWithoutInto, false);
    strict.equal(relation.extension?.attributes.temporalType, 2);
    strict.equal(relation.constraints[0]?.kind, "primary-key");
    strict.equal(relation.constraints[1]?.extension?.attributes.trusted, false);
    strict.deepEqual(relation.indexes[0]?.includedColumns, ["status"]);
    strict.equal(relation.indexes[0]?.predicate, "present");
    strict.equal(snapshot.routines["dbo.findOrder"]?.[0]?.arguments[0]?.typeIdentity, "dbo.OrderId");
    strict.equal(snapshot.routines["dbo.findOrder"]?.[0]?.nullInput, "strict");
    const json = serializeSchemaSnapshot(snapshot);
    strict.ok(!json.includes("N'deleted'"));
    strict.ok(!json.includes("N'new'"));
    strict.equal(parseSchemaSnapshot(JSON.parse(json)).formatVersion, 2);
    strict.equal(state.calls.length, 10);
  });
  await it("fails closed on permission denial, hidden requested schemas and inconsistent native references", async () => {
    const state = fixture();
    state.data.set(queries.server, [{ ...state.data.get(queries.server)![0], can_view_definition: 0 }]);
    await strict.rejects(new SqlServerSchemaProvider({ client: state.client }).introspect({}), /VIEW DEFINITION/);
    strict.equal(state.calls.length, 2);
    const missing = fixture();
    await strict.rejects(
      new SqlServerSchemaProvider({ client: missing.client, includeSchemas: ["missing"] }).introspect({}),
      /not visible/,
    );
    const invalid = fixture();
    invalid.data.set(queries.columns, [{ ...invalid.data.get(queries.columns)![0], user_type_id: 999 }]);
    await strict.rejects(new SqlServerSchemaProvider({ client: invalid.client }).introspect({}), /invisible type/);
    await strict.rejects(new SqlServerSchemaProvider().introspect({}), /injected/);
  });
  await it("gates unknown future engine syntax even for SELECT literals", async () => {
    const state = fixture();
    state.data.set(queries.server, [
      { ...state.data.get(queries.server)![0], version: "18.0.1.1", compatibility_level: 180 },
    ]);
    const snapshot = await new SqlServerSchemaProvider({ client: state.client }).introspect({});
    const result = sqlserver().analyze("SELECT 1 AS n", snapshot);
    strict.ok(result.diagnostics.some((d) => d.code === "TSQ402"));
  });
});
