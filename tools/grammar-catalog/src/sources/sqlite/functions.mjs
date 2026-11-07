import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { hash } from "../../model/canonical.mjs";

const execFile = promisify(execFileCallback);
/** @template {import('@sinclair/typebox').TProperties} T @param {T} properties */
const object = (properties) => Type.Object(properties, { additionalProperties: false });
const integer = Type.Integer({ minimum: 0 });
const name = Type.String({ pattern: "^[!-~]+$" });
export const FunctionProfileSchema = object({
  id: Type.String({ minLength: 1 }),
  defines: Type.Array(Type.String({ pattern: "^SQLITE_[A-Z0-9_]+(?:=\\d+)?$" }), { uniqueItems: true }),
  version: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }),
  sourceId: Type.String({ minLength: 1 }),
  maximumFunctionArguments: Type.Integer({ minimum: 1 }),
  compileOptions: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  registrations: Type.Array(
    object({
      name,
      arity: Type.Integer({ minimum: -4 }),
      flags: integer,
      encoding: Type.Integer({ minimum: 1, maximum: 3 }),
      binderMinimumArguments: integer,
      kind: Type.Union([Type.Literal("scalar"), Type.Literal("aggregate"), Type.Literal("window")]),
      windowCapable: Type.Boolean(),
      internal: Type.Boolean(),
    }),
    { minItems: 1 },
  ),
  visible: Type.Array(
    object({
      name,
      builtin: Type.Boolean(),
      kind: Type.Union([Type.Literal("s"), Type.Literal("a"), Type.Literal("w")]),
      encoding: Type.Union([Type.Literal("utf8"), Type.Literal("utf16le"), Type.Literal("utf16be")]),
      arity: Type.Integer({ minimum: -4 }),
      flags: integer,
    }),
    { minItems: 1 },
  ),
});
const checker = TypeCompiler.Compile(FunctionProfileSchema);
const sorted = (values) =>
  [...values].sort((a, b) => {
    const x = JSON.stringify(a),
      y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
/** @param {unknown} value @returns {import('@sinclair/typebox').Static<typeof FunctionProfileSchema>} */
export function validateFunctionProfile(value) {
  if (!checker.Check(value)) throw new TypeError("Invalid SQLite source function profile");
  for (const field of ["defines", "compileOptions", "registrations", "visible"]) {
    if (
      hash(sorted(value[field])) !== hash(value[field]) ||
      new Set(value[field].map((row) => JSON.stringify(row))).size !== value[field].length
    )
      throw new TypeError(`Noncanonical SQLite function profile: ${field}`);
  }
  for (const row of value.registrations) {
    if (
      row.arity === -2 ||
      row.binderMinimumArguments > value.maximumFunctionArguments ||
      (row.arity >= 0 && row.binderMinimumArguments !== row.arity)
    )
      throw new TypeError("Invalid SQLite function binder bounds");
  }
  return value;
}

/** Strict framed protocol from our compiled wrapper; unfamiliar rows are never discarded. */
export function parseFunctionOutput(text, { id, defines }) {
  const value = { id, defines: sorted(defines), compileOptions: [], registrations: [], visible: [] };
  const singleton = new Set();
  const numeric = (input, signed = false) => {
    if (!(signed ? /^-?\d+$/u : /^\d+$/u).test(input ?? "") || !Number.isSafeInteger(Number(input)))
      throw new TypeError("Invalid SQLite function extraction integer");
    return Number(input);
  };
  const boolean = (input) => {
    if (input !== "0" && input !== "1") throw new TypeError("Invalid SQLite function extraction boolean");
    return input === "1";
  };
  for (const line of text.trim().split(/\r?\n/u)) {
    const [tag, ...fields] = line.split("\t");
    if (["version", "sourceId", "maximumFunctionArguments"].includes(tag)) {
      if (fields.length !== 1 || singleton.has(tag)) throw new TypeError("Duplicate SQLite function extraction header");
      singleton.add(tag);
      value[tag] = tag === "maximumFunctionArguments" ? numeric(fields[0]) : fields[0];
    } else if (tag === "option" && fields.length === 1) value.compileOptions.push(fields[0]);
    else if (tag === "registration" && fields.length === 9) {
      const [name, arity, flags, encoding, minimum, kind, window, internal, terminator] = fields;
      if (terminator !== "end") throw new TypeError("Truncated SQLite function extraction registration");
      value.registrations.push({
        name,
        arity: numeric(arity, true),
        flags: numeric(flags),
        encoding: numeric(encoding),
        binderMinimumArguments: numeric(minimum),
        kind,
        windowCapable: boolean(window),
        internal: boolean(internal),
      });
    } else if (tag === "visible" && fields.length === 6) {
      const [name, builtin, kind, encoding, arity, flags] = fields;
      value.visible.push({
        name,
        builtin: boolean(builtin),
        kind,
        encoding,
        arity: numeric(arity, true),
        flags: numeric(flags),
      });
    } else throw new TypeError("Unrecognized SQLite function extraction row");
  }
  for (const field of ["compileOptions", "registrations", "visible"]) value[field] = sorted(value[field]);
  return validateFunctionProfile(value);
}

const wrapper = `#include "sqlite3.c"
#include <stdio.h>
int main(void){
  sqlite3 *db=0;
  sqlite3_stmt *stmt=0;
  if(sqlite3_open(":memory:",&db)!=SQLITE_OK) return 1;
  printf("version\\t%s\\nsourceId\\t%s\\nmaximumFunctionArguments\\t%d\\n",sqlite3_libversion(),sqlite3_sourceid(),sqlite3_limit(db,SQLITE_LIMIT_FUNCTION_ARG,-1));
  for(int i=0;sqlite3_compileoption_get(i);i++) printf("option\\t%s\\n",sqlite3_compileoption_get(i));
  for(int i=0;i<SQLITE_FUNC_HASH_SZ;i++){
    for(FuncDef *head=sqlite3BuiltinFunctions.a[i];head;head=head->u.pHash){
      for(FuncDef *p=head;p;p=p->pNext){
        int minimum=-1;
        for(int n=0;n<=SQLITE_MAX_FUNCTION_ARG;n++) if(matchQuality(p,n,SQLITE_UTF8)>0){minimum=n;break;}
        if(minimum<0) return 2;
        printf("registration\\t%s\\t%d\\t%u\\t%d\\t%d\\t%s\\t%d\\t%d\\tend\\n",p->zName,p->nArg,(unsigned)p->funcFlags,p->funcFlags&SQLITE_FUNC_ENCMASK,minimum,(p->funcFlags&SQLITE_FUNC_WINDOW)?"window":p->xFinalize?"aggregate":"scalar",p->xValue!=0&&p->xInverse!=0,(p->funcFlags&SQLITE_FUNC_INTERNAL)!=0);
      }
    }
  }
  if(sqlite3_prepare_v2(db,"SELECT name,builtin,type,enc,narg,flags FROM pragma_function_list",-1,&stmt,0)!=SQLITE_OK) return 3;
  int rc;
  while((rc=sqlite3_step(stmt))==SQLITE_ROW){
    printf("visible\\t%s\\t%d\\t%s\\t%s\\t%d\\t%u\\n",sqlite3_column_text(stmt,0),sqlite3_column_int(stmt,1),sqlite3_column_text(stmt,2),sqlite3_column_text(stmt,3),sqlite3_column_int(stmt,4),(unsigned)sqlite3_column_int64(stmt,5));
  }
  if(rc!=SQLITE_DONE || sqlite3_finalize(stmt)!=SQLITE_OK) return 4;
  if(sqlite3_close(db)!=SQLITE_OK) return 5;
  return 0;
}
`;

/** Build exact vendor sources, then read their own function registry and binder. */
export async function extractFunctions({
  directory,
  version,
  revision,
  upstreamRevision,
  compiler = "cc",
  python = "python3",
  make = "make",
}) {
  const workspace = await mkdtemp(join(tmpdir(), "typed-sql-sqlite-functions-"));
  try {
    const run = async (command, args, cwd) =>
      execFile(command, args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    await run(
      python,
      [
        fileURLToPath(new URL("./extract-archive.py", import.meta.url)),
        join(directory, "source.tar.gz"),
        workspace,
        revision,
      ],
      workspace,
    );
    const source = join(workspace, `sqlite-${revision}`);
    // Verify separately acquired pins against their archive members before executing the build.
    for (const path of ["VERSION", "manifest.uuid", "LICENSE.md", "tool/mkkeywordhash.c", "src/func.c"])
      if (!(await readFile(join(source, path))).equals(await readFile(join(directory, path))))
        throw new TypeError(`SQLite archive/member disagreement: ${path}`);
    await run(join(source, "configure"), ["--disable-shared"], source);
    await run(make, ["sqlite3.c"], source);
    await writeFile(join(source, "typed-sql-functions.c"), wrapper);
    const profiles = [];
    for (const profile of [
      { id: "default", defines: [] },
      {
        id: "extended",
        defines: [
          "SQLITE_ENABLE_MATH_FUNCTIONS",
          "SQLITE_ENABLE_FTS5",
          "SQLITE_ENABLE_RTREE",
          "SQLITE_SOUNDEX",
          "SQLITE_ENABLE_PERCENTILE",
          "SQLITE_ENABLE_OFFSET_SQL_FUNC",
        ],
      },
    ]) {
      const binary = join(source, `typed-sql-functions-${profile.id}`);
      await run(
        compiler,
        [
          "-std=c11",
          "-O0",
          ...profile.defines.map((value) => `-D${value}`),
          "typed-sql-functions.c",
          "-o",
          binary,
          "-lm",
          "-lpthread",
        ],
        source,
      );
      const { stdout } = await run(binary, [], source);
      const facts = parseFunctionOutput(stdout, profile);
      if (facts.version !== version || !facts.sourceId.endsWith(upstreamRevision))
        throw new TypeError("Compiled SQLite source identity differs from lock");
      profiles.push(facts);
    }
    return profiles;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
