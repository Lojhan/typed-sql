import ts from "@typed-sql/browser-typescript";
import type { PlaygroundEnvironment } from "./dialect-browser-runtime.js";
import { ENVIRONMENT_FILE } from "./environment-model.js";
import type { WorkspaceFiles } from "./workspace.js";

export { ENVIRONMENT_FILE } from "./environment-model.js";

/** Read literals only. Version/settings experiments never execute application configuration. */
export function workspaceEnvironment(files: WorkspaceFiles): PlaygroundEnvironment | undefined {
  const content = files[ENVIRONMENT_FILE];
  if (content === undefined) return undefined;
  const source = ts.createSourceFile(ENVIRONMENT_FILE, content, ts.ScriptTarget.ES2024, true);
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
      ? unwrap(node.expression)
      : node;
  const object = (expression: ts.Expression): Record<string, ts.Expression> => {
    const node = unwrap(expression);
    if (!ts.isObjectLiteralExpression(node)) throw new TypeError("Engine settings use literal objects only.");
    if (node.properties.length > 32) throw new TypeError("Engine settings exceed the property limit.");
    const entries: [string, ts.Expression][] = [];
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
        throw new TypeError("Engine settings require named properties without spreads or computed values.");
      const name = property.name.text;
      if (entries.some(([key]) => key === name)) throw new TypeError(`Duplicate engine setting ${name}.`);
      entries.push([name, property.initializer]);
    }
    return Object.fromEntries(entries);
  };
  const declarations = source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? statement.declarationList.declarations.filter(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "environment",
        )
      : [],
  );
  const expression = declarations.length === 1 ? declarations[0]!.initializer : undefined;
  if (!expression) throw new TypeError("Export one literal object named environment from schema/settings.ts.");
  const root = object(expression);
  if (Object.keys(root).some((key) => key !== "version" && key !== "settings"))
    throw new TypeError("Engine configuration accepts version and settings only.");
  let version: string | undefined;
  if (root.version) {
    const node = unwrap(root.version);
    if (!ts.isStringLiteral(node) || !node.text || node.text.length > 100)
      throw new TypeError("Engine version must be bounded literal text.");
    version = node.text;
  }
  const settings = root.settings
    ? Object.fromEntries(
        Object.entries(object(root.settings)).map(([name, expression]) => {
          const node = unwrap(expression);
          if (ts.isStringLiteral(node) && node.text.length <= 1000) return [name, node.text];
          if (ts.isNumericLiteral(node) && Number.isFinite(Number(node.text))) return [name, Number(node.text)];
          if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
            return [name, node.kind === ts.SyntaxKind.TrueKeyword];
          throw new TypeError(`Engine setting ${name} requires literal text, a finite number, or a Boolean.`);
        }),
      )
    : undefined;
  return { ...(version === undefined ? {} : { version }), ...(settings === undefined ? {} : { settings }) };
}
