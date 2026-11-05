import ts from "@typed-sql/browser-typescript";
import { type SchemaBrands, withSchemaBrands } from "../../../../packages/schema/src/brands.js";
import type { SchemaSnapshotV2 } from "../../../../packages/schema/src/model.js";
import type { WorkspaceFiles } from "./workspace.js";

export const BRANDS_FILE = "schema/brands.ts";

/** Read data only: a playground workspace never executes application configuration. */
export function applyWorkspaceBrands(snapshot: SchemaSnapshotV2, files: WorkspaceFiles): SchemaSnapshotV2 {
  const content = files[BRANDS_FILE];
  if (content === undefined) return snapshot;
  const source = ts.createSourceFile(BRANDS_FILE, content, ts.ScriptTarget.ES2024, true);
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
      ? unwrap(node.expression)
      : node;
  const object = (expression: ts.Expression): Readonly<Record<string, ts.Expression>> => {
    const node = unwrap(expression);
    if (!ts.isObjectLiteralExpression(node)) throw new TypeError("Brand configuration uses literal objects only.");
    const properties: Record<string, ts.Expression> = Object.create(null);
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
        throw new TypeError(
          "Brand configuration requires named properties; computed values and spreads are unsupported.",
        );
      const name = property.name.text;
      if (Object.hasOwn(properties, name)) throw new TypeError(`Duplicate brand configuration property ${name}.`);
      properties[name] = property.initializer;
    }
    return properties;
  };
  const labels = (expression: ts.Expression): Readonly<Record<string, string>> =>
    Object.fromEntries(
      Object.entries(object(expression)).map(([key, value]) => {
        const node = unwrap(value);
        if (!ts.isStringLiteral(node)) throw new TypeError("Brand names must be string literals.");
        return [key, node.text];
      }),
    );
  const declarations = source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? statement.declarationList.declarations.filter(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "brands",
        )
      : [],
  );
  if (declarations.length !== 1 || declarations[0]!.initializer === undefined)
    throw new TypeError("Export one literal object named brands from schema/brands.ts.");
  const fields = object(declarations[0]!.initializer);
  if (Object.keys(fields).some((key) => key !== "columns" && key !== "domains"))
    throw new TypeError("Brand configuration accepts columns and domains only.");
  const brands: SchemaBrands = {
    ...(fields.columns === undefined
      ? {}
      : {
          columns: Object.fromEntries(
            Object.entries(object(fields.columns)).map(([key, value]) => [key, labels(value)]),
          ),
        }),
    ...(fields.domains === undefined ? {} : { domains: labels(fields.domains) }),
  };
  return withSchemaBrands(snapshot, brands);
}
