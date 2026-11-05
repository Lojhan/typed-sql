import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createTestWorkspace } from "../test/helpers/playground-workspace.js";
import { COMMERCE_FILES } from "../website/.vitepress/theme/playground/commerce-example.js";
import { DEFAULT_SCHEMAS } from "../website/.vitepress/theme/playground/playground.js";
import { lessonFiles } from "../website/.vitepress/theme/playground/workspace.js";

// Native SVG only: GitHub image embeds do not run JavaScript or load application code.
// Generate presentation text from checked query contracts, never from handwritten result types.
const workspace = createTestWorkspace();
const check = process.argv.includes("--check");
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const brandAliases = (text: string) => text.replaceAll('import("@typed-sql/core").Brand', "Brand");
function formatType(text: string): string {
  let output = "";
  let indent = 0;
  let quote = false;
  for (const char of brandAliases(text)) {
    if (char === '"') quote = !quote;
    if (!quote && char === "{") {
      output = `${output.trimEnd()} {\n${"  ".repeat(++indent)}`;
    } else if (!quote && char === "}") {
      output = `${output.trimEnd()}\n${"  ".repeat(--indent)}}`;
    } else if (!quote && char === ";") {
      output = `${output.trimEnd()};\n${"  ".repeat(indent)}`;
    } else if (char !== " " || !output.endsWith(" ")) output += char;
  }
  return output.trim().replace(/\{([^{}]+)\}/gu, (whole, inner: string) => {
    const compact = inner.replace(/\s+/gu, " ").trim();
    return compact.length < 43 ? `{ ${compact} }` : whole;
  });
}
function parameters(text: string): string {
  const value = brandAliases(text);
  return value.length < 46
    ? value
    : value.startsWith("readonly [")
      ? value.replace("readonly [", "readonly [\n  ").replace(/>, /gu, ">,\n  ").replace(/\]$/u, "\n]")
      : value.replace("readonly (", "readonly (\n  ").replaceAll(" | ", " |\n  ").replace(")[]", "\n)[]");
}
function analyze(files: Record<string, string>) {
  return workspace.analyze("postgres", files);
}
function contract(files: Record<string, string>, binding: string) {
  const result = analyze(files);
  assert.deepEqual(result.problems, []);
  const query = result.queries.find((query) => query.binding === binding);
  assert.ok(query, `Missing query ${binding}`);
  return { row: formatType(query.rowType), parameters: parameters(query.parameterType) };
}
interface Scene {
  file: string;
  code: string;
  row?: string;
  parameters?: string;
  note?: string;
  error?: string;
  highlight?: number;
  typing?: { line: number; text: string };
  hover?: { line: number; column: number; length: number; label: string; type: string };
}
interface Demo {
  id: string;
  title: string;
  description: string;
  height: number;
  scenes: Scene[];
}
const schema = { "schema/tables.sql": DEFAULT_SCHEMAS.postgres };
const namedSql = "SELECT id, user_id FROM orders\nWHERE user_id = :userId\n   OR user_id = :userId;";
const namedFiles = { ...schema, "orders.sql": namedSql };
const named = contract(namedFiles, "orders");
const namedInput = named.parameters.slice("readonly [".length).split(",")[0]!;
const namedCall = 'import orders from "./orders.sql";\n\nconst query = orders({ userId: 42n });';
const invalidNamed = analyze({ ...namedFiles, "app.ts": namedCall.replace("42n", '"42"') });
const namedError = invalidNamed.problems.find(({ code }) => code === "TS2322");
assert.ok(namedError);
assert.ok(namedError.message.includes("bigint"));
assert.deepEqual(analyze({ ...namedFiles, "app.ts": namedCall }).problems, []);
const positionalBefore = "SELECT id, email FROM users\nWHERE email <> $2\n  AND (id = $1 OR id = $1);";
const positionalAfter = "SELECT id, email FROM users\nWHERE id = $1\n  AND (email <> $2 OR id = $1);";
const positional = (source: string) => contract({ ...schema, "account.sql": source }, "account");
const brandedFiles = lessonFiles("postgres", "brands", DEFAULT_SCHEMAS.postgres);
brandedFiles["queries/orders.sql"] = brandedFiles["queries/orders.sql"]!.replace("id, user_id, status", "id, user_id");
const branded = contract(brandedFiles, "ordersByCustomer");
const userIdBrand = /"user_id": ([^;]+);/u.exec(branded.row)![1]!;
const mapBefore = `export function insertProducts(items: readonly NewProduct[]) {
  if (!items.length) throw new RangeError("Empty collection");
  return sql\`
    INSERT INTO products
      (id, sku, title, price_cents, active)
    VALUES \${items.map(item => sql.fragment\`
      (\${item.id}, \${item.sku}, \${item.title},
       \${item.priceCents}, \${true})
    \`)}
    RETURNING id, sku
  \`;
}`;
const mapAfter = mapBefore.replace("RETURNING id, sku", "RETURNING id, sku, title");
const mapPrelude =
  'import { sql } from "@typed-sql/postgres";\ninterface NewProduct { id: bigint; sku: string; title: string; priceCents: number; }\n';
const mapContract = (source: string) =>
  contract({ ...schema, "insert-products.ts": mapPrelude + source }, "insertProducts");
const jsonBefore = COMMERCE_FILES["queries/order-json.ts"];
const jsonAfter = jsonBefore.replace("'customer', jsonb_build_object", "'buyer', jsonb_build_object");
const jsonContract = (source: string) => contract({ ...schema, "order-json.ts": source }, "orderDocument");
// Only the SELECT expression is shown; joins/grouping remain in the analyzed source above.
const jsonExcerpt = (source: string) =>
  source.slice(source.indexOf("  SELECT"), source.indexOf("  FROM")).trimEnd().replace(/^ {2}/gmu, "");
const demos: Demo[] = [
  {
    id: "named",
    title: "One named argument. Every occurrence bound.",
    height: 372,
    description:
      "A repeated userId binds two bigint values. Passing a string produces TS2322; correcting it to bigint clears the diagnostic.",
    scenes: [
      {
        file: "orders.sql",
        code: namedSql,
        ...named,
        note: "One userId property → two bound values",
        highlight: 2,
        hover: { line: 2, column: 16, length: 7, label: "Named parameter · userId", type: namedInput },
      },
      {
        file: "app.ts",
        code: namedCall.replace("42n", '"42"'),
        ...named,
        error: namedError.message,
        highlight: 3,
        typing: { line: 3, text: '"42"' },
        hover: { line: 3, column: 23, length: 6, label: "Expected argument · userId", type: namedInput },
      },
      {
        file: "app.ts",
        code: namedCall,
        ...named,
        note: "Corrected to bigint · no problems",
        highlight: 3,
        typing: { line: 3, text: "42n" },
        hover: { line: 3, column: 6, length: 5, label: "const query · Query parameters", type: named.parameters },
      },
    ],
  },
  {
    id: "positional",
    title: "SQL occurrence order drives the bound tuple.",
    height: 326,
    description:
      "Reorder PostgreSQL placeholders from $2, $1, $1 to $1, $2, $1. The inferred tuple changes from string/bigint/bigint to bigint/string/bigint; factory arguments remain in numeric order.",
    scenes: [
      {
        file: "account.sql",
        code: positionalBefore,
        ...positional(positionalBefore),
        note: 'Factory: account(42n, "excluded@example.com")',
        highlight: 2,
        hover: {
          line: 2,
          column: 15,
          length: 2,
          label: "Bound parameter tuple",
          type: positional(positionalBefore).parameters,
        },
      },
      {
        file: "account.sql",
        code: positionalAfter,
        ...positional(positionalAfter),
        note: "Same arguments · bound tuple follows SQL order",
        highlight: 2,
        typing: { line: 2, text: "id = $1" },
        hover: {
          line: 2,
          column: 11,
          length: 2,
          label: "Bound parameter tuple",
          type: positional(positionalAfter).parameters,
        },
      },
    ],
  },
  {
    id: "brands",
    title: "Declare identities once. Keep them in queries.",
    height: 414,
    description:
      "UserId and OrderId column brands from schema configuration survive in inferred SQL result rows and repeated bound parameters. Brand is imported from @typed-sql/core.",
    scenes: [
      {
        file: "schema/brands.ts",
        code: 'export const brands = {\n  columns: {\n    users: { id: "UserId" },\n    orders: {\n      id: "OrderId",\n      user_id: "UserId"\n    }\n  }\n} as const;',
        ...branded,
        note: "withSchemaBrands(snapshot, brands) · explicit identities",
        typing: { line: 3, text: '"UserId"' },
        hover: { line: 3, column: 17, length: 8, label: "Column identity · users.id", type: userIdBrand },
      },
      {
        file: "queries/orders.sql",
        code: brandedFiles["queries/orders.sql"]!,
        ...branded,
        note: "Brand is imported from @typed-sql/core",
        highlight: 2,
        hover: { line: 2, column: 11, length: 7, label: "Column · orders.user_id", type: userIdBrand },
      },
    ],
  },
  {
    id: "map",
    title: "Map a collection. Infer the RETURNING row.",
    height: 432,
    description:
      "A mapped fragment collection becomes one parameterized INSERT. Adding title to RETURNING adds a string field to the inferred row. Runtime-sized collections use a readonly parameter array.",
    scenes: [
      {
        file: "insert-products.ts · NewProduct from application",
        code: mapBefore,
        ...mapContract(mapBefore),
        note: "Runtime-sized collection · values remain parameters",
        highlight: 6,
        hover: {
          line: 6,
          column: 19,
          length: 3,
          label: "Query parameters · runtime collection",
          type: mapContract(mapBefore).parameters,
        },
      },
      {
        file: "insert-products.ts · NewProduct from application",
        code: mapAfter,
        ...mapContract(mapAfter),
        note: "RETURNING changes → result type updates",
        highlight: 10,
        typing: { line: 10, text: ", title" },
        hover: {
          line: 10,
          column: 23,
          length: 5,
          label: "Result column · title",
          type: /"title": ([^;]+);/u.exec(mapContract(mapAfter).row)![1]!,
        },
      },
    ],
  },
  {
    id: "json",
    title: "Nested JSON keeps the shape your SQL builds.",
    height: 640,
    description:
      "Rename the customer key to buyer in a PostgreSQL JSON constructor. The inferred nested object updates and preserves the items array. The editor displays the SELECT expression; joins and grouping are present in the checked query.",
    scenes: [
      {
        file: "order-json.ts · SELECT excerpt",
        code: jsonExcerpt(jsonBefore),
        ...jsonContract(jsonBefore),
        note: "Constructed objects and item arrays retain their shape",
        highlight: 5,
        hover: {
          line: 5,
          column: 3,
          length: 10,
          label: "JSON property · customer",
          type: /"customer": (\{[^}]+\})/u.exec(jsonContract(jsonBefore).row)![1]!,
        },
      },
      {
        file: "order-json.ts · SELECT excerpt",
        code: jsonExcerpt(jsonAfter),
        ...jsonContract(jsonAfter),
        note: "Rename a JSON key → inferred shape updates",
        highlight: 5,
        typing: { line: 5, text: "buyer" },
        hover: {
          line: 5,
          column: 3,
          length: 7,
          label: "JSON property · buyer",
          type: /"buyer": (\{[^}]+\})/u.exec(jsonContract(jsonAfter).row)![1]!,
        },
      },
    ],
  },
];

function tokens(line: string): string {
  const pattern =
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:SELECT|FROM|WHERE|OR|AND|INSERT|INTO|VALUES|RETURNING|AS|GROUP|BY|JOIN|ON|COALESCE)\b|\b(?:export|const|return|function|if|throw|new|readonly|interface|import|from|as)\b|\$\d+|:[A-Za-z_]\w*|\b\d+n?\b|\b(?:bigint|string|number|boolean|Brand|NewProduct|RangeError)\b)/gu;
  let previous = 0;
  let result = "";
  for (const match of line.matchAll(pattern)) {
    result += escapeXml(line.slice(previous, match.index));
    const word = match[0];
    const kind = /^['"]/u.test(word)
      ? "string"
      : /^(?:\$\d|:\w|\d)/u.test(word)
        ? "value"
        : /^[A-Z_]+$/u.test(word)
          ? "sql"
          : /^(?:bigint|string|number|boolean|Brand|NewProduct|RangeError)$/u.test(word)
            ? "type"
            : "keyword";
    result += `<tspan class="${kind}">${escapeXml(word)}</tspan>`;
    previous = match.index + word.length;
  }
  return result + escapeXml(line.slice(previous));
}
function code(text: string, x: number, y: number, numbered = false, size = 14): string {
  return text
    .split("\n")
    .map((line, index) => {
      // Keep all text inside its actual pane rather than letting long tokens overlap the divider.
      const width = numbered ? 538 : 362;
      assert.ok(line.length * size * 0.61 <= width, `Line too wide: ${line}`);
      return `${numbered ? `<text x="22" y="${y + index * 23}" class="line-number">${index + 1}</text>` : ""}<text x="${x}" y="${y + index * 23}" class="code" font-size="${size}">${tokens(line)}</text>`;
    })
    .join("\n");
}
function render(demo: Demo): string {
  const height = Math.max(
    demo.height,
    ...demo.scenes.map(
      (scene) => 210 + ((scene.row?.split("\n").length ?? 0) + (scene.parameters?.split("\n").length ?? 0)) * 23,
    ),
  );
  const segment = 4.4;
  const duration = demo.scenes.length * segment;
  const files = [...new Set(demo.scenes.map((scene) => scene.file.split(" · ")[0]!))];
  const css: string[] = [];
  const windowAnimation = (name: string, start: number, end: number) => {
    const percent = (seconds: number) => Math.max(0, Math.min(100, (seconds / duration) * 100)).toFixed(4);
    css.push(
      `@keyframes ${name}{0%{opacity:${start === 0 ? 1 : 0}}${start > 0 ? `${percent(start - 0.001)}%{opacity:0}${percent(start)}%{opacity:1}` : ""}${percent(end - 0.001)}%{opacity:1}${percent(end)}%{opacity:0}100%{opacity:0}} .${name}{animation:${name} ${duration}s steps(1) infinite}`,
    );
    return name;
  };
  const movement = (name: string, start: number, end: number, before: string, after: string, steps?: number) => {
    const pct = (seconds: number) => ((seconds / duration) * 100).toFixed(4);
    css.push(
      `@keyframes ${name}{0%,${pct(start)}%{transform:${before}}${pct(end)}%,100%{transform:${after}}}.${name}{animation:${name} ${duration}s ${steps ? `steps(${steps},end)` : "cubic-bezier(.2,.7,.3,1)"} infinite}`,
    );
  };
  const scenes = demo.scenes
    .map((scene, index) => {
      const start = index * segment;
      const end = start + segment;
      const sceneClass = windowAnimation(`scene-${index}`, start, end);
      const resolved = scene.typing ? windowAnimation(`resolved-${index}`, start + 1.15, end) : "";
      const checking = scene.typing ? windowAnimation(`checking-${index}`, start, start + 1.15) : "hidden";
      const source = scene.code
        .split("\n")
        .map((line, lineIndex) => {
          const baseline = 106 + lineIndex * 23;
          const numbering = `<text x="22" y="${baseline}" class="line-number">${lineIndex + 1}</text>`;
          if (!scene.typing || scene.typing.line !== lineIndex + 1)
            return `${numbering}<text x="46" y="${baseline}" class="code" font-size="13">${tokens(line)}</text>`;
          const { text } = scene.typing;
          const column = line.indexOf(text);
          assert.ok(column >= 0, `Missing typing token ${text}`);
          const x = 46 + column * 7.8;
          const width = text.length * 7.8;
          movement(`reveal-${index}`, start + 0.15, start + 1, "scaleX(0)", "scaleX(1)", text.length);
          movement(`suffix-${index}`, start + 0.15, start + 1, `translateX(-${width}px)`, "translateX(0)", text.length);
          movement(`caret-${index}`, start + 0.15, start + 1, "translateX(0)", `translateX(${width}px)`, text.length);
          return `${numbering}<text x="46" y="${baseline}" class="code" font-size="13">${tokens(line.slice(0, column))}</text>
<defs><clipPath id="typing-${index}"><rect width="${width + 1}" height="23" class="reveal-${index} reveal motion"/></clipPath></defs>
<g transform="translate(${x} ${baseline - 17})"><g clip-path="url(#typing-${index})"><text x="0" y="17" class="code" font-size="13">${tokens(text)}</text></g><rect x="0" y="1" width="1.5" height="20" fill="var(--accent)" class="caret-${index} typing-caret motion"/></g>
<g class="suffix-${index} typing-suffix motion"><text x="${x + width}" y="${baseline}" class="code" font-size="13">${tokens(line.slice(column + text.length))}</text></g>`;
        })
        .join("\n");
      let hover = "";
      if (scene.hover) {
        const targetX = 46 + scene.hover.column * 7.8;
        const targetY = 106 + (scene.hover.line - 1) * 23;
        const hoverClass = windowAnimation(`hover-${index}`, start + 2, end - 0.15);
        movement(
          `pointer-${index}`,
          start + 1.2,
          start + 1.95,
          `translate(520px,${height - 60}px)`,
          `translate(${targetX + 12}px,${targetY + 4}px)`,
        );
        const tooltipLines = scene.hover.type.split("\n");
        const boxHeight = 55 + tooltipLines.length * 20;
        const boxY = Math.max(82, Math.min(targetY + 20, height - 39 - boxHeight));
        assert.ok(boxY > 78, `${demo.id} tooltip exceeds editor`);
        hover = `<g class="pointer-${index} pointer motion"><path d="M0 0L2 20L7 15L12 24L16 22L11 13L18 12Z" fill="var(--ink)" stroke="var(--bg)" stroke-width="1.5"/></g>
<g class="${hoverClass} hover"><path d="M${targetX} ${targetY + 4}h${scene.hover.length * 7.8}" stroke="var(--accent)"/>
<rect x="54" y="${boxY}" width="510" height="${boxHeight}" rx="7" fill="var(--bar)" stroke="var(--line)"/>
<text x="68" y="${boxY + 22}" class="label">${escapeXml(scene.hover.label)}</text>
${tooltipLines.map((line, i) => `<text x="68" y="${boxY + 46 + i * 20}" class="code" font-size="13">${tokens(line)}</text>`).join("\n")}</g>`;
      }
      const rowLines = scene.row?.split("\n").length ?? 0;
      const parameterY = 150 + rowLines * 23;
      assert.ok(
        parameterY + 25 + (scene.parameters?.split("\n").length ?? 1) * 23 < height - 12,
        `${demo.id} contract overflows`,
      );
      return `<g class="scene ${sceneClass}${index === demo.scenes.length - 1 ? " final" : ""}">
${files.map((file, i) => `<text x="${18 + i * 180}" y="64" class="${file === scene.file.split(" · ")[0] ? "heading" : "label"}">${escapeXml(file)}</text>${file === scene.file.split(" · ")[0] ? `<path d="M${10 + i * 180} 75h160" stroke="var(--accent)" stroke-width="2"/>` : ""}`).join("")}
${scene.file.includes(" · ") ? `<text x="46" y="${height - 49}" class="label">${escapeXml(scene.file.split(" · ")[1]!)}</text>` : ""}
${scene.highlight ? `<rect x="38" y="${89 + (scene.highlight - 1) * 23}" width="540" height="23" rx="3" fill="var(--tint)"/>` : ""}
${source}
<g class="${resolved} resolved"><text x="610" y="103" class="label">Result row${files.length > 1 ? ` · ${files.find((file) => file.endsWith(".sql"))}` : ""}</text>${code(scene.row ?? "", 610, 128)}
<text x="610" y="${parameterY}" class="label">Bound parameters</text>${code(scene.parameters ?? "", 610, parameterY + 25, false, 13)}
<circle cx="18" cy="${height - 16}" r="3" fill="var(--${scene.error ? "error" : "ok"})"/>
<text x="30" y="${height - 12}" class="label"${scene.error ? ' style="fill:var(--error)"' : ""}>${escapeXml(scene.error ? `TS2322 · ${scene.error}` : (scene.note ?? "No problems"))}</text></g>
<g class="${checking} checking"><text x="610" y="103" class="label">Checking the edit…</text><text x="18" y="${height - 12}" class="label">Analyzing…</text></g>
${hover}
</g>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}" role="img" aria-labelledby="title description">
<title id="title">${escapeXml(demo.title)}</title><desc id="description">${escapeXml(demo.description)}</desc>
<style>
svg{--bg:#0b1b22;--bar:#10242d;--line:#29404b;--ink:#d9e7ed;--muted:#8099a6;--accent:#60d4e1;--purple:#c69bed;--blue:#8ec7fa;--green:#b4ce94;--gold:#e3bc78;--error:#ff8796;--tint:#173940;--ok:#8fd6b0;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
@media(prefers-color-scheme:light){svg{--bg:#f9fbfd;--bar:#edf3f7;--line:#cfdee7;--ink:#213848;--muted:#61798a;--accent:#007887;--purple:#7f3e9c;--blue:#155d9d;--green:#426527;--gold:#885c12;--error:#bc2949;--tint:#e0f1f3;--ok:#19754d}}
text{white-space:pre}.code{fill:var(--ink)}.line-number{fill:var(--muted);font-size:12px;text-anchor:end}.label{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;fill:var(--muted)}.heading{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;font-weight:600;fill:var(--ink)}.sql{fill:var(--accent)}.keyword{fill:var(--purple)}.string{fill:var(--green)}.value{fill:var(--gold)}.type{fill:var(--blue)}.scene{opacity:0}.scene-0{opacity:1}.hidden{display:none}.reveal{transform-box:fill-box;transform-origin:left center}.typing-caret{animation-timing-function:steps(1)}.progress{transform-origin:0 0;animation:progress ${duration}s linear infinite}@keyframes progress{from{transform:scaleX(0)}to{transform:scaleX(1)}}
${css.join("\n")}
@media(prefers-reduced-motion:reduce){.scene{animation:none!important;opacity:0}.scene.final{opacity:1}.motion,.progress,.resolved{animation:none!important;transform:none!important}.typing-caret,.pointer,.hover,.checking{display:none!important}.resolved{opacity:1!important}}
</style>
<rect x=".5" y=".5" width="999" height="${height - 1}" rx="12" fill="var(--bg)" stroke="var(--line)"/>
<path d="M12 1H988Q999 1 999 12V42H1V12Q1 1 12 1" fill="var(--bar)"/>
<text x="20" y="26" class="heading">PostgreSQL</text><text x="120" y="26" class="label">/ ${escapeXml(demo.title)}</text>
<path d="M590 42V${height - 33}M1 76H999M1 ${height - 33}H999" stroke="var(--line)" fill="none"/>
<text x="610" y="64" class="heading">Inferred types</text>
${scenes}
<rect x="1" y="${height - 2}" width="998" height="1.5" fill="var(--accent)" class="progress"/>
</svg>\n`;
}
try {
  for (const demo of demos) {
    const content = render(demo);
    const path = `docs/assets/typed-sql-${demo.id}.svg`;
    if (check) assert.equal(readFileSync(path, "utf8"), content, `${path} is stale; run pnpm docs:demos`);
    else writeFileSync(path, content);
    console.log(`${check ? "Checked" : "Generated"} ${path}`);
  }
} finally {
  workspace.dispose();
}
