import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hash } from "../../model/canonical.mjs";

const execFile = promisify(execFileCallback);

/** Compile the vendor's own preprocessor-controlled table; never regex C initializers. */
export async function extractKeywords({ directory, version, revision, defines = [], compiler = "cc" }) {
  if (defines.some((define) => !/^SQLITE_[A-Z0-9_]+(?:=\d+)?$/u.test(define)))
    throw new TypeError("Invalid SQLite preprocessor definition");
  const actual = (await readFile(join(directory, "VERSION"), "utf8")).trim();
  if (actual !== version) throw new TypeError(`SQLite source version mismatch: ${actual}`);
  const workspace = await mkdtemp(join(tmpdir(), "typed-sql-sqlite-keywords-"));
  try {
    // Include exact locked bytes in one translation unit so static vendor data stays accessible.
    const source = await readFile(join(directory, "tool/mkkeywordhash.c"), "utf8");
    const wrapper = `#define main sqlite_vendor_generator_main\n${source}\n#undef main\nint main(void){\n  for(int i=0;i<nKeyword;i++){\n    printf("%s\\t%s\\t%u\\n",aKeywordTable[i].zName,aKeywordTable[i].zTokenType,(unsigned)aKeywordTable[i].mask);\n  }\n  return 0;\n}\n`;
    const file = join(workspace, "keywords.c"),
      binary = join(workspace, process.platform === "win32" ? "keywords.exe" : "keywords");
    await writeFile(file, wrapper);
    await execFile(compiler, ["-std=c11", ...defines.map((value) => `-D${value}`), file, "-o", binary], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const { stdout } = await execFile(binary, [], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
    return {
      formatVersion: 1,
      grammar: "sqlite",
      version,
      revision,
      defines: [...defines].sort(),
      keywords: parseKeywordOutput(stdout),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
export function parseKeywordOutput(text) {
  const names = new Set();
  const rows = text
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      const [name, token, mask, ...extra] = line.split("\t");
      if (
        extra.length ||
        !name ||
        !/^[A-Z_]+$/u.test(name) ||
        !/^TK_[A-Z_]+$/u.test(token ?? "") ||
        !/^\d+$/u.test(mask ?? "") ||
        !Number.isSafeInteger(Number(mask)) ||
        names.has(name)
      )
        throw new TypeError("Unrecognized SQLite keyword-table output");
      names.add(name);
      return { name, token, mask: Number(mask), enabled: Number(mask) !== 0 };
    });
  if (!rows.length) throw new TypeError("Empty SQLite keyword table");
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function validateKeywordFacts(facts) {
  if (
    facts?.formatVersion !== 1 ||
    facts.grammar !== "sqlite" ||
    !Array.isArray(facts.defines) ||
    facts.defines.some((value) => !/^SQLITE_[A-Z0-9_]+(?:=\d+)?$/u.test(value)) ||
    !Array.isArray(facts.keywords) ||
    !facts.keywords.length
  )
    throw new TypeError("Invalid SQLite vendor keyword facts");
  const encoded = facts.keywords.map((row) => `${row.name}\t${row.token}\t${row.mask}`).join("\n");
  if (hash(parseKeywordOutput(encoded)) !== hash(facts.keywords))
    throw new TypeError("SQLite keyword facts are not canonical");
}
export function keywordCoverage(facts, parserWords) {
  const words = new Set(parserWords);
  return Object.fromEntries(
    Object.entries(facts.versions).map(([version, value]) => {
      validateKeywordFacts(value);
      const enabled = value.keywords.filter((row) => row.enabled).map((row) => row.name);
      const native = new Set(enabled);
      return [
        version,
        {
          configuration: "explicit source defines; not native build qualification",
          defines: value.defines,
          vendorKeywords: enabled.length,
          recognizedByParser: enabled.filter((name) => words.has(name)),
          sourceOnly: enabled.filter((name) => !words.has(name)),
          parserOnly: [...words].filter((name) => !native.has(name)).sort(),
          disabled: value.keywords.filter((row) => !row.enabled).map((row) => row.name),
        },
      ];
    }),
  );
}
