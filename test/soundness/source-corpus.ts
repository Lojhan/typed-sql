export type SourceSoundnessExpectation =
  | {
      readonly kind: "exact";
      readonly rowType: string;
      readonly parameterType: string;
    }
  | {
      readonly kind: "structural";
      readonly rowIncludes: readonly string[];
      readonly fragmentParameterTypes: readonly string[];
    }
  | {
      readonly kind: "diagnostic";
      readonly codes: readonly string[];
      readonly sourceTarget: string;
    }
  | { readonly kind: "dynamic" };

export interface SourceSoundnessCase {
  readonly id: string;
  readonly source: string;
  readonly expectation: SourceSoundnessExpectation;
}

export function sourceForDialect(testCase: SourceSoundnessCase, dialect: "postgres" | "mysql" | "sqlite"): string {
  return testCase.source
    .replace("@typed-sql/postgres", `@typed-sql/${dialect}`)
    .replace("@typed-sql/__other__", dialect === "postgres" ? "@typed-sql/mysql" : "@typed-sql/postgres");
}

const moduleImport = 'import { sql } from "@typed-sql/postgres";';
const interpolation = (expression: string): string => `\${${expression}}`;

export const sourceSoundnessCorpus: readonly SourceSoundnessCase[] = [
  {
    id: "exact-row-and-ordered-parameters",
    source: [
      moduleImport,
      'const status: "active" | "suspended" = "active";',
      "const minimumId = 1n;",
      `export const query = sql\`SELECT users.id, users.email, users.status FROM users WHERE users.status = ${interpolation("status")} AND users.id >= ${interpolation("minimumId")}\`;`,
    ].join("\n"),
    expectation: {
      kind: "exact",
      rowType: '{ "id": bigint; "email": string; "status": "active" | "suspended"; }',
      parameterType: 'readonly ["active" | "suspended", bigint]',
    },
  },
  {
    id: "conditional-projection-and-filters",
    source: [
      moduleImport,
      'interface Filters { readonly status?: "active" | "suspended" | null; readonly minimumId?: bigint | null }',
      "interface AccountSelect { readonly status: boolean }",
      "export function accounts<const Select extends AccountSelect>(filters: Filters, select: Select) {",
      "  return sql`",
      "    SELECT users.id, users.email",
      `      ${interpolation("select.status ? sql.fragment`, users.status` : sql.empty")}`,
      "    FROM users",
      "    WHERE 1 = 1",
      `      ${interpolation(
        `filters.status == null ? sql.empty : sql.fragment\`AND users.status = ${interpolation("filters.status")}\``,
      )}`,
      `      ${interpolation(
        `filters.minimumId == null ? sql.empty : sql.fragment\`AND users.id >= ${interpolation("filters.minimumId")}\``,
      )}`,
      "  `;",
      "}",
    ].join("\n"),
    expectation: {
      kind: "structural",
      rowIncludes: ['Select["status"] extends true', '"id": bigint', '"email": string', '"status": "active"'],
      fragmentParameterTypes: ['readonly ["active" | "suspended"]', "readonly [bigint]"],
    },
  },
  {
    id: "mapped-fragment-diagnostic",
    source: [
      moduleImport,
      "const cutoff = new Date();",
      `export const query = sql\`SELECT users.id FROM users WHERE 1 = 1 ${interpolation(
        `sql.fragment\`AND deleted_at >= ${interpolation("cutoff")}\``,
      )}\`;`,
    ].join("\n"),
    expectation: { kind: "diagnostic", codes: ["TSQ101"], sourceTarget: "deleted_at" },
  },
  {
    id: "homogeneous-fragment-list-keeps-dynamic-cardinality-honest",
    source: [
      moduleImport,
      "declare const rows: readonly { readonly id: bigint }[];",
      `export const query = sql\`SELECT users.id FROM users WHERE users.id IN (${interpolation(
        `rows.map((row) => sql.fragment\`${interpolation("row.id")}\`)`,
      )})\`;`,
    ].join("\n"),
    expectation: { kind: "exact", rowType: '{ "id": bigint; }', parameterType: "readonly unknown[]" },
  },
  {
    id: "wrong-grammar-fragment-list-diagnostic",
    source: [
      moduleImport,
      'import { sql as otherSql } from "@typed-sql/__other__";',
      "declare const rows: readonly { readonly id: bigint }[];",
      `export const query = sql\`SELECT ${interpolation(
        `rows.map((row) => otherSql.fragment\`${interpolation("row.id")}\`)`,
      )}\`;`,
    ].join("\n"),
    expectation: { kind: "diagnostic", codes: ["TSQ014"], sourceTarget: "otherSql.fragment" },
  },
  {
    id: "untagged-structural-template-diagnostic",
    source: [
      moduleImport,
      'const hostile = "\' OR TRUE --";',
      "interface Selection { readonly status: boolean }",
      'interface Filters { readonly status?: "active" | "suspended" | null }',
      "export function accounts(select: Selection, filters: Filters) {",
      "  return sql`SELECT users.id, users.email",
      `    ${interpolation("select.status ? `, users.status` : sql.empty")}`,
      `    FROM users WHERE users.email <> ${interpolation("hostile")}`,
      `    ${interpolation(
        `filters.status == null ? sql.empty : \`AND users.status = ${interpolation("filters.status")}\``,
      )}\`;`,
      "}",
    ].join("\n"),
    expectation: { kind: "diagnostic", codes: ["TSQ004"], sourceTarget: ", users.status" },
  },
  {
    id: "incompatible-structural-parameter-context",
    source: [
      moduleImport,
      "declare const fromUsers: boolean;",
      "declare const value: string | bigint;",
      "export const query = sql`SELECT account.value FROM",
      `  ${interpolation(
        "fromUsers ? sql.fragment`(SELECT users.status AS value FROM users) AS account` : sql.fragment`(SELECT projects.owner_id AS value FROM projects) AS account`",
      )}`,
      `  WHERE 1 = 1 ${interpolation(`sql.fragment\`AND account.value = ${interpolation("value")}\``)}\`;`,
    ].join("\n"),
    expectation: { kind: "diagnostic", codes: ["TSQ205"], sourceTarget: "value" },
  },
  {
    id: "malformed-structural-fragment",
    source: [
      moduleImport,
      `export const query = sql\`SELECT users.id FROM users ${interpolation(
        `sql.fragment\`AND users.id > ${interpolation("1n")}\``,
      )}\`;`,
    ].join("\n"),
    expectation: { kind: "diagnostic", codes: ["TSQ001"], sourceTarget: "AND" },
  },
  {
    id: "dynamic-query-remains-unknown",
    source: [moduleImport, "declare const text: string;", "export const query = sql.dynamic(text);"].join("\n"),
    expectation: { kind: "dynamic" },
  },
] as const;
