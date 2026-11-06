import { describe, it, strict } from "poku";
import {
  PostgresMigrationScriptError,
  postgresMigrationStatements,
  validatePostgresReconciliation,
} from "../src/migration-script.js";

await describe("PostgreSQL migration scripts", async () => {
  await it("preserves complete dollar-quoted routines, escaped literals and nested comments", () => {
    const source = `/* outer /* nested ; */ comment */
create function public.example() returns text language plpgsql as $body$
begin
  return 'value; still one function';
end;
$body$;
insert into public.messages(value) values(E'it\\'s; a value');
-- tail
select "name;quoted" from public.messages;`;
    const statements = postgresMigrationStatements(source);
    strict.strictEqual(statements.length, 3);
    strict.ok(statements[0]!.text.includes("return 'value; still one function'"));
    strict.ok(statements[1]!.text.startsWith("insert into"));
    strict.strictEqual(statements[0]!.range.line, 2);
    strict.strictEqual(source.slice(statements[0]!.range.start, statements[0]!.range.end), statements[0]!.text);
  });

  await it("ignores empty delimiters and comment-only scripts", () => {
    strict.deepStrictEqual(postgresMigrationStatements("; -- no SQL\n /* empty */ ;"), []);
    strict.strictEqual(postgresMigrationStatements("select 1 -- tail").length, 1);
  });

  await it("rejects transaction control without mistaking quoted words for commands", () => {
    for (const source of [
      "begin;",
      "commit;",
      "rollback;",
      "end;",
      "abort;",
      "savepoint x;",
      "release x;",
      "start transaction;",
      "prepare transaction 'x';",
      "set transaction read only;",
      "set session authorization 'x';",
      "discard all",
      "reset all",
      "select pg_advisory_unlock_all()",
      "select pg_catalog.pg_advisory_unlock(1)",
    ]) {
      strict.throws(() => postgresMigrationStatements(source), PostgresMigrationScriptError);
    }
    strict.strictEqual(postgresMigrationStatements("select 'commit;'; select \"begin\" from x;").length, 2);
  });

  await it("rejects unsupported client-protocol and routine body syntax", () => {
    strict.throws(() => postgresMigrationStatements("copy public.accounts from stdin;"), /COPY FROM STDIN/);
    strict.throws(
      () =>
        postgresMigrationStatements("create function public.f() returns int language sql begin atomic select 1; end;"),
      /BEGIN ATOMIC/,
    );
    strict.throws(() => postgresMigrationStatements("\\i other.sql"));
    strict.throws(() => postgresMigrationStatements("select 'unterminated"));
    strict.throws(() => postgresMigrationStatements('select "unterminated'));
    strict.throws(() => postgresMigrationStatements("do $body$ begin perform 1; end;"));
  });

  await it("qualifies only a narrow schema-only reconciliation subset", () => {
    for (const source of [
      "create table public.accounts(id integer primary key, name text not null, enabled boolean default true, unique(name))",
      "create unique index accounts_name on public.accounts(name desc nulls last) include(id)",
      "alter table public.accounts add column status text not null default 'active'",
      "alter table public.accounts add column score numeric(10,2) default -1",
    ])
      validatePostgresReconciliation(source);
    for (const source of [
      "insert into public.accounts values(1)",
      "update public.accounts set name='changed'",
      "create table public.copy as select * from public.accounts",
      "create table public.copy(id integer default effectful())",
      "create index accounts_expr on public.accounts(lower(name))",
      "create index accounts_partial on public.accounts(name) where enabled",
      "alter table public.accounts add column status text default effectful()",
      "alter table public.accounts add column created timestamptz default current_timestamp",
      "alter table public.accounts add column value public.custom_type",
      "alter table public.accounts add column value text generated always as (effectful()) stored",
      "delete from public.accounts; create table public.more(id integer)",
    ])
      strict.throws(() => validatePostgresReconciliation(source), /Schema-only reconciliation/);
  });
});
