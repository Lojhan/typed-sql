import { defineConfig } from "@typed-sql/core";
import { mysql, typePolicy } from "@typed-sql/mysql";
import { createMySql2LiveVerifier, createMySql2PlanInspector, mysql2 } from "@typed-sql/mysql/mysql2";

const dialect = mysql({ typePolicy });
const connectionUri = () => {
  const port = process.env.TYPED_SQL_MYSQL_E2E_PORT ?? "53306";
  return `mysql://typed_sql:typed_sql_e2e@127.0.0.1:${port}/typed_sql_e2e`;
};

export default defineConfig({
  dialect,
  schema: {
    file: "./generated/db/schema.json",
    provider: mysql2({
      connectionUri,
      schemas: ["typed_sql_e2e"],
      typePolicy,
    }),
  },
  outDir: "./generated/db",
  projects: ["./tsconfig.json"],
  typePolicy,
  manifest: { outFile: ".typed-sql/queries.json" },
  verification: {
    live: createMySql2LiveVerifier({ connectionUri, typePolicy }),
    proofFile: ".typed-sql/verification.json",
    concurrency: 2,
  },
  plans: {
    live: createMySql2PlanInspector({ connectionUri }),
    sampleValues(request) {
      return {
        identity: "e2e-representative-v1",
        values: request.parameters.map((parameter) => (parameter.tsType === "bigint" ? 1n : 1)),
      };
    },
    artifactFile: ".typed-sql/plans.json",
    reportFile: ".typed-sql/plan-review.json",
    concurrency: 2,
    failOn: "uncertainty",
    budgets: { defaults: { maximumTotalCost: 10_000 } },
  },
});
