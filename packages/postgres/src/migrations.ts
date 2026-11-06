import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CatalogEvidence,
  emptyHistory,
  type JsonValue,
  MigrationError,
  type MigrationHistory,
  type MigrationSession,
  type MigrationStatement,
  type MigrationTarget,
  parseHistory,
  type TargetIdentity,
} from "@typed-sql/migrations";
import { calculateSchemaHash } from "@typed-sql/schema";
import type { Pool, PoolClient } from "pg";
import { postgresMigrationStatements, validatePostgresReconciliation } from "./migration-script.js";
import { loadPgDriver } from "./pg.js";
import { PostgresSchemaProvider } from "./provider.js";
import type { PostgresTypePolicy } from "./type-policy.js";

export interface PgMigrationTargetOptions {
  readonly connectionString: string | (() => string | Promise<string>);
  readonly namespaces?: readonly string[];
  readonly typePolicy?: PostgresTypePolicy;
  readonly historyNamespace?: string;
  readonly expected: MigrationTarget["expected"];
  readonly classification: MigrationTarget["classification"];
  readonly disposable?: boolean;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly driverImporter?: () => Promise<typeof import("pg")>;
}

interface CatalogRow extends Record<string, unknown> {
  readonly kind: string;
  readonly names: string[];
  readonly definition: JsonValue;
}

interface NamespaceRow extends Record<string, unknown> {
  readonly name: string;
  readonly usable: boolean;
}

/** Unambiguous qualified identity, including names containing dots, quotes or colons. */
export function migrationCatalogKey(kind: string, ...identifiers: readonly string[]): string {
  return `${kind}:${JSON.stringify(identifiers)}`;
}

function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes("\0"))
    throw new TypeError("Migration identifiers must be nonempty and contain no NUL bytes.");
  if (Buffer.byteLength(value) > 63)
    throw new TypeError(
      "PostgreSQL migration namespace identifiers must not exceed 63 UTF-8 bytes; implicit truncation would invalidate lock identity.",
    );
  return `"${value.replaceAll('"', '""')}"`;
}

function timeout(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 2_147_483_647)
    throw new TypeError("Migration timeouts must be positive 32-bit integers in milliseconds.");
  return selected;
}

function driverFailure(error: unknown): MigrationError {
  if (error instanceof MigrationError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const sqlState = /^[A-Z0-9]{5}$/u.test(code) ? code : undefined;
  const failure = new MigrationError(
    "MIGRATION_DATABASE",
    sqlState === undefined
      ? "Migration database operation failed; inspect the target before retrying."
      : `Migration database operation failed (SQLSTATE ${sqlState}); inspect the target before retrying.`,
  );
  Object.defineProperty(failure, "cause", { value: error });
  return failure;
}

// The evidence intentionally excludes volatile OIDs, sequence values, owners and data rows.
// Definition hashes preserve structural comparison without storing function bodies or defaults.
const catalogSql = `
with namespaces as (
  select oid, nspname from pg_catalog.pg_namespace where nspname = any($1::text[])
), catalog as (
  select 'namespace'::text as kind, array[n.nspname]::text[] as names,
    pg_catalog.jsonb_build_object('name',n.nspname) as definition
  from namespaces n
  union all
  select 'relation', array[n.nspname,c.relname],
    pg_catalog.jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,
      'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity,
      'replicaIdentity',c.relreplident,'options',c.reloptions,
      'partitionKey',case when c.relkind='p' then pg_catalog.pg_get_partkeydef(c.oid) end,
      'partitionBound',pg_catalog.pg_get_expr(c.relpartbound,c.oid),
      'parents',(select pg_catalog.jsonb_agg(array[pn.nspname,pc.relname] order by i.inhseqno)
        from pg_catalog.pg_inherits i join pg_catalog.pg_class pc on pc.oid=i.inhparent
        join pg_catalog.pg_namespace pn on pn.oid=pc.relnamespace where i.inhrelid=c.oid),
      'view',case when c.relkind in ('v','m') then pg_catalog.pg_get_viewdef(c.oid,true) end)
  from pg_catalog.pg_class c join namespaces n on n.oid=c.relnamespace
  where c.relkind in ('r','p','v','m','f')
  union all
  select 'column', array[n.nspname,c.relname,a.attname],
    pg_catalog.jsonb_build_object('position',row_number() over(partition by a.attrelid order by a.attnum),'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
      'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
      'collation',case when a.attcollation<>0 then a.attcollation::pg_catalog.regcollation::text end,
      'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid))
  from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid
  join namespaces n on n.oid=c.relnamespace
  left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
  where a.attnum>0 and not a.attisdropped and c.relkind in ('r','p','v','m','f')
  union all
  select 'index',array[n.nspname,c.relname,ic.relname],
    pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_indexdef(i.indexrelid),
      'valid',i.indisvalid,'ready',i.indisready,'replicaIdentity',i.indisreplident,
      'clustered',i.indisclustered)
  from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indrelid
  join namespaces n on n.oid=c.relnamespace join pg_catalog.pg_class ic on ic.oid=i.indexrelid
  union all
  select 'constraint',array[n.nspname,c.relname,k.conname],
    pg_catalog.jsonb_build_object('kind',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid,true),
      'validated',k.convalidated,'deferrable',k.condeferrable,'initiallyDeferred',k.condeferred)
  from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid
  join namespaces n on n.oid=c.relnamespace
  union all
  select 'sequence',array[n.nspname,c.relname],
    pg_catalog.jsonb_build_object('type',pg_catalog.format_type(s.seqtypid,null),'start',s.seqstart::text,
      'increment',s.seqincrement::text,'min',s.seqmin::text,'max',s.seqmax::text,
      'cache',s.seqcache::text,'cycle',s.seqcycle,
      'ownedBy',(select pg_catalog.jsonb_build_array(tn.nspname,t.relname,a.attname)
        from pg_catalog.pg_depend d join pg_catalog.pg_class t on t.oid=d.refobjid
        join pg_catalog.pg_namespace tn on tn.oid=t.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid=t.oid and a.attnum=d.refobjsubid
        where d.classid='pg_catalog.pg_class'::pg_catalog.regclass and d.objid=c.oid
          and d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass and d.deptype in ('a','i') limit 1))
  from pg_catalog.pg_sequence s join pg_catalog.pg_class c on c.oid=s.seqrelid
  join namespaces n on n.oid=c.relnamespace
  union all
  select 'routine',array[n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)],
    pg_catalog.jsonb_build_object('kind',p.prokind,'arguments',pg_catalog.pg_get_function_arguments(p.oid),
      'result',pg_catalog.pg_get_function_result(p.oid),'language',l.lanname,
      'body',p.prosrc,'binary',p.probin,'volatility',p.provolatile,'strict',p.proisstrict,
      'securityDefiner',p.prosecdef,'parallel',p.proparallel,'config',p.proconfig,
      'cost',p.procost,'rows',p.prorows,
      'definition',case when p.prokind<>'a' then pg_catalog.pg_get_functiondef(p.oid) end,
      'aggregate',(select pg_catalog.jsonb_build_object('kind',a.aggkind,'directArguments',a.aggnumdirectargs,
        'transition',a.aggtransfn::pg_catalog.regprocedure::text,'final',a.aggfinalfn::pg_catalog.regprocedure::text,
        'combine',a.aggcombinefn::pg_catalog.regprocedure::text,'serial',a.aggserialfn::pg_catalog.regprocedure::text,
        'deserial',a.aggdeserialfn::pg_catalog.regprocedure::text,'movingTransition',a.aggmtransfn::pg_catalog.regprocedure::text,
        'movingInverse',a.aggminvtransfn::pg_catalog.regprocedure::text,'movingFinal',a.aggmfinalfn::pg_catalog.regprocedure::text,
        'transitionType',pg_catalog.format_type(a.aggtranstype,null),'initial',a.agginitval,'movingInitial',a.aggminitval)
        from pg_catalog.pg_aggregate a where a.aggfnoid=p.oid))
  from pg_catalog.pg_proc p join namespaces n on n.oid=p.pronamespace
  join pg_catalog.pg_language l on l.oid=p.prolang
  union all
  select 'type',array[n.nspname,t.typname],
    pg_catalog.jsonb_build_object('kind',t.typtype,'base',case when t.typbasetype<>0 then pg_catalog.format_type(t.typbasetype,t.typtypmod) end,
      'notNull',t.typnotnull,'default',t.typdefault,'length',t.typlen,'byValue',t.typbyval,
      'category',t.typcategory,'preferred',t.typispreferred,'delimiter',t.typdelim,
      'input',t.typinput::pg_catalog.regprocedure::text,'output',t.typoutput::pg_catalog.regprocedure::text,
      'receive',t.typreceive::pg_catalog.regprocedure::text,'send',t.typsend::pg_catalog.regprocedure::text,
      'align',t.typalign,'storage',t.typstorage,
      'enum',(select pg_catalog.jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_catalog.pg_enum e where e.enumtypid=t.oid),
      'domainConstraints',(select pg_catalog.jsonb_agg(pg_catalog.pg_get_constraintdef(k.oid,true) order by k.conname)
        from pg_catalog.pg_constraint k where k.contypid=t.oid),
      'range',(select pg_catalog.jsonb_build_object('subtype',pg_catalog.format_type(r.rngsubtype,null),
        'collation',r.rngcollation::pg_catalog.regcollation::text,
        'opclass',(select pg_catalog.jsonb_build_array(onsp.nspname,oc.opcname)
          from pg_catalog.pg_opclass oc join pg_catalog.pg_namespace onsp on onsp.oid=oc.opcnamespace where oc.oid=r.rngsubopc),
        'canonical',r.rngcanonical::pg_catalog.regprocedure::text,'subdiff',r.rngsubdiff::pg_catalog.regprocedure::text)
        from pg_catalog.pg_range r where r.rngtypid=t.oid or r.rngmultitypid=t.oid),
      'attributes',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,
        'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull) order by a.attnum)
        from pg_catalog.pg_attribute a where a.attrelid=t.typrelid and a.attnum>0 and not a.attisdropped))
  from pg_catalog.pg_type t join namespaces n on n.oid=t.typnamespace
  left join pg_catalog.pg_class c on c.oid=t.typrelid
  where t.typtype in ('e','d','r','m') or (t.typtype='c' and c.relkind='c') or (t.typtype='b' and t.typelem=0)
  union all
  select 'trigger',array[n.nspname,c.relname,t.tgname],
    pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled)
  from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
  join namespaces n on n.oid=c.relnamespace where not t.tgisinternal
  union all
  select 'policy',array[n.nspname,c.relname,p.polname],
    pg_catalog.jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
      'roles',(select pg_catalog.jsonb_agg(case when r=0 then 'public' else pg_catalog.pg_get_userbyid(r) end order by r)
        from pg_catalog.unnest(p.polroles) r),
      'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
  from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid
  join namespaces n on n.oid=c.relnamespace
  union all
  select 'extension',array[n.nspname,e.extname],
    pg_catalog.jsonb_build_object('version',e.extversion,'relocatable',e.extrelocatable)
  from pg_catalog.pg_extension e join namespaces n on n.oid=e.extnamespace
  union all
  select 'collation',array[n.nspname,c.collname],
    (pg_catalog.to_jsonb(c)-'oid'-'collnamespace'-'collowner')
  from pg_catalog.pg_collation c join namespaces n on n.oid=c.collnamespace
  union all
  select 'rule',array[n.nspname,c.relname,r.rulename],
    pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_ruledef(r.oid,true),'enabled',r.ev_enabled)
  from pg_catalog.pg_rewrite r join pg_catalog.pg_class c on c.oid=r.ev_class
  join namespaces n on n.oid=c.relnamespace where r.rulename<>'_RETURN'
  union all
  select 'foreign-table',array[n.nspname,c.relname],
    pg_catalog.jsonb_build_object('server',s.srvname,'options',f.ftoptions)
  from pg_catalog.pg_foreign_table f join pg_catalog.pg_class c on c.oid=f.ftrelid
  join namespaces n on n.oid=c.relnamespace join pg_catalog.pg_foreign_server s on s.oid=f.ftserver
  union all
  select 'unsupported',array[n.nspname,'operator',o.oprname], '{}'::jsonb
  from pg_catalog.pg_operator o join namespaces n on n.oid=o.oprnamespace
  union all
  select 'unsupported',array[n.nspname,'operator-class',o.opcname], '{}'::jsonb
  from pg_catalog.pg_opclass o join namespaces n on n.oid=o.opcnamespace
  union all
  select 'unsupported',array[n.nspname,'operator-family',o.opfname], '{}'::jsonb
  from pg_catalog.pg_opfamily o join namespaces n on n.oid=o.opfnamespace
  union all
  select 'unsupported',array[n.nspname,'conversion',o.conname], '{}'::jsonb
  from pg_catalog.pg_conversion o join namespaces n on n.oid=o.connamespace
  union all
  select 'unsupported',array[n.nspname,'text-search-config',o.cfgname], '{}'::jsonb
  from pg_catalog.pg_ts_config o join namespaces n on n.oid=o.cfgnamespace
  union all
  select 'unsupported',array[n.nspname,'text-search-dictionary',o.dictname], '{}'::jsonb
  from pg_catalog.pg_ts_dict o join namespaces n on n.oid=o.dictnamespace
  union all
  select 'unsupported',array[n.nspname,'text-search-parser',o.prsname], '{}'::jsonb
  from pg_catalog.pg_ts_parser o join namespaces n on n.oid=o.prsnamespace
  union all
  select 'unsupported',array[n.nspname,'text-search-template',o.tmplname], '{}'::jsonb
  from pg_catalog.pg_ts_template o join namespaces n on n.oid=o.tmplnamespace
  union all
  select 'unsupported',array[n.nspname,'extended-statistics',o.stxname], '{}'::jsonb
  from pg_catalog.pg_statistic_ext o join namespaces n on n.oid=o.stxnamespace
) select kind,names,definition from catalog order by kind,names`;

function definitionHash(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createPgMigrationTarget(options: PgMigrationTargetOptions): MigrationTarget {
  if (!["development", "test", "production"].includes(options.classification))
    throw new TypeError("Migration targets require an explicit development, test or production classification.");
  if (typeof options.expected?.database !== "string" || options.expected.database.length === 0)
    throw new TypeError("Migration targets require an expected database identity.");
  if (options.disposable !== undefined && typeof options.disposable !== "boolean")
    throw new TypeError("Migration disposable capability must be boolean.");
  const namespaces = [...new Set(options.namespaces ?? ["public"])].sort();
  if (namespaces.length === 0) throw new TypeError("Migration targets require at least one managed namespace.");
  namespaces.forEach(quoteIdentifier);
  const historyNamespace = options.historyNamespace ?? "typed_sql";
  quoteIdentifier(historyNamespace);
  if (namespaces.includes(historyNamespace))
    throw new TypeError("The migration history namespace must be separate from managed application namespaces.");
  const statementTimeoutMs = timeout(options.statementTimeoutMs, 30_000);
  const lockTimeoutMs = timeout(options.lockTimeoutMs, 10_000);
  return {
    classification: options.classification,
    expected: options.expected,
    ...(options.disposable === undefined ? {} : { disposable: options.disposable }),
    async connect(): Promise<MigrationSession> {
      let connectionString: string;
      try {
        connectionString =
          typeof options.connectionString === "function" ? await options.connectionString() : options.connectionString;
      } catch (error) {
        throw driverFailure(error);
      }
      if (typeof connectionString !== "string" || connectionString.length === 0)
        throw new TypeError("Set a connection string for the selected migration target.");
      let driver: typeof import("pg");
      try {
        driver = await loadPgDriver(options.driverImporter);
      } catch (error) {
        const cause = error instanceof Error && "cause" in error ? error.cause : error;
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ERR_MODULE_NOT_FOUND")
          throw new MigrationError(
            "MIGRATION_DRIVER_REQUIRED",
            "Install the application-owned PostgreSQL driver with: pnpm add pg",
            2,
          );
        throw driverFailure(error);
      }
      if (typeof driver.Pool !== "function")
        throw new MigrationError(
          "MIGRATION_DRIVER_INTERFACE",
          "The configured pg driver must export a Pool constructor.",
          2,
        );
      const pool = new driver.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        await pool.end();
        throw driverFailure(error);
      }
      try {
        await client.query(
          "select pg_catalog.set_config('statement_timeout',$1,false), pg_catalog.set_config('lock_timeout',$2,false), pg_catalog.set_config('search_path',$3,false)",
          [
            String(statementTimeoutMs),
            String(lockTimeoutMs),
            [...namespaces.map(quoteIdentifier), "pg_catalog"].join(","),
          ],
        );
        return new PgMigrationSession(client, pool, namespaces, historyNamespace, options.typePolicy);
      } catch (error) {
        client.release(true);
        await pool.end();
        throw driverFailure(error);
      }
    },
  };
}

class PgMigrationSession implements MigrationSession {
  readonly #client: PoolClient;
  readonly #pool: Pool;
  readonly #namespaces: readonly string[];
  readonly #historyNamespace: string;
  readonly #ledger: string;
  readonly #typePolicy: PostgresTypePolicy | undefined;
  #lockKey: string | undefined;
  #closed = false;
  #locked = false;
  #transaction = false;
  #fatal: unknown;
  readonly #onError = (error: Error): void => {
    this.#fatal = error;
  };

  constructor(
    client: PoolClient,
    pool: Pool,
    namespaces: readonly string[],
    historyNamespace: string,
    typePolicy?: PostgresTypePolicy,
  ) {
    this.#typePolicy = typePolicy;
    this.#client = client;
    this.#pool = pool;
    this.#namespaces = namespaces;
    this.#historyNamespace = historyNamespace;
    this.#ledger = `${quoteIdentifier(historyNamespace)}."migration_history"`;
    client.on("error", this.#onError);
  }

  async #query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly Row[]; readonly fields: readonly { readonly name: string }[] }> {
    if (this.#closed) throw new MigrationError("MIGRATION_SESSION_CLOSED", "The migration session is closed.");
    if (this.#fatal !== undefined) throw driverFailure(this.#fatal);
    try {
      return await this.#client.query<Row>(text, [...values]);
    } catch (error) {
      throw driverFailure(error);
    }
  }

  #requireLock(): void {
    if (!this.#locked)
      throw new MigrationError(
        "MIGRATION_LOCK_REQUIRED",
        "Acquire the target migration lock before changing history or executing migration SQL.",
        3,
      );
  }

  async #verifyLock(): Promise<void> {
    this.#requireLock();
    const key = BigInt.asUintN(64, BigInt(this.#lockKey!));
    const result = await this.#query<{ held: boolean }>(
      "select exists(select 1 from pg_catalog.pg_locks where locktype='advisory' and pid=pg_catalog.pg_backend_pid() and database=(select oid from pg_catalog.pg_database where datname=pg_catalog.current_database()) and classid=$1::oid and objid=$2::oid and objsubid=1 and granted) as held",
      [(key >> 32n).toString(), (key & 0xffffffffn).toString()],
    );
    if (result.rows[0]?.held !== true) {
      this.#locked = false;
      throw new MigrationError(
        "MIGRATION_LOCK_LOST",
        "The server no longer confirms ownership of the target migration lock; inspect the target before continuing.",
        4,
      );
    }
  }

  async identity(): Promise<TargetIdentity> {
    const result = await this.#query<{ database: string; address: string | null; port: number | null }>(
      "select pg_catalog.current_database() as database, pg_catalog.host(pg_catalog.inet_server_addr()) as address, pg_catalog.inet_server_port() as port",
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new MigrationError("MIGRATION_IDENTITY", "The migration target did not return an identity.", 3);
    return { dialect: "postgres", database: row.database, server: `${row.address ?? "unix"}:${row.port ?? "local"}` };
  }
  async snapshot() {
    await this.#verifyLock();
    const provider = new PostgresSchemaProvider({
      client: {
        query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
          this.#query<Row>(text, values),
      },
      includeSchemas: this.#namespaces,
      ...(this.#typePolicy === undefined ? {} : { typePolicy: this.#typePolicy }),
    });
    return provider.introspect({});
  }
  async snapshotHash(): Promise<string> {
    return calculateSchemaHash(await this.snapshot());
  }

  async capture(): Promise<CatalogEvidence> {
    // PostgreSQL deparsers render defaults, types and definitions through session
    // settings. Normalize only this observation, without changing migration SQL.
    // Rolling back a savepoint restores settings and preserves preceding DDL.
    const nested = this.#transaction;
    await this.#query(
      nested ? "savepoint typed_sql_catalog_context" : "begin isolation level repeatable read read only",
    );
    let captured: CatalogEvidence | undefined;
    let captureFailed = false;
    let captureError: unknown;
    try {
      await this.#query(`select
        pg_catalog.set_config('search_path','pg_catalog',true),
        pg_catalog.set_config('TimeZone','UTC',true),
        pg_catalog.set_config('DateStyle','ISO, YMD',true),
        pg_catalog.set_config('IntervalStyle','postgres',true),
        pg_catalog.set_config('extra_float_digits','3',true),
        pg_catalog.set_config('standard_conforming_strings','on',true)
      `);
      captured = await this.#captureCatalog();
    } catch (error) {
      captureFailed = true;
      captureError = error;
    }
    try {
      if (nested) {
        await this.#query("rollback to savepoint typed_sql_catalog_context");
        await this.#query("release savepoint typed_sql_catalog_context");
      } else await this.#query("rollback");
    } catch (error) {
      const failure = new MigrationError(
        "MIGRATION_CATALOG_CONTEXT",
        "Catalog observation could not restore its session context. The connection is unusable; inspect migration state before continuing.",
        4,
      );
      Object.defineProperty(failure, "cause", { value: error });
      this.#fatal = failure;
      throw failure;
    }
    if (captureFailed) throw captureError;
    return captured!;
  }

  async #captureCatalog(): Promise<CatalogEvidence> {
    const environmentResult = await this.#query<{ environment: Record<string, JsonValue> }>(`
      select pg_catalog.jsonb_build_object(
        'encoding',pg_catalog.pg_encoding_to_char(d.encoding),
        'collation',d.datcollate,'ctype',d.datctype,
        'provider',coalesce(pg_catalog.to_jsonb(d)->>'datlocprovider','c'),
        'locale',coalesce(pg_catalog.to_jsonb(d)->>'datlocale',pg_catalog.to_jsonb(d)->>'daticulocale'),
        'rules',pg_catalog.to_jsonb(d)->>'daticurules',
        'collationVersion',pg_catalog.to_jsonb(d)->>'datcollversion'
      ) as environment from pg_catalog.pg_database d where d.datname=pg_catalog.current_database()
    `);
    const settings = environmentResult.rows[0]?.environment;
    if (
      !settings ||
      typeof settings !== "object" ||
      Array.isArray(settings) ||
      typeof settings.encoding !== "string" ||
      typeof settings.collation !== "string" ||
      typeof settings.ctype !== "string" ||
      typeof settings.provider !== "string"
    )
      throw new MigrationError(
        "MIGRATION_ENVIRONMENT",
        "Cannot establish persistent database default environment evidence.",
        3,
      );
    const version = await this.#query<{ version: string }>(
      "select pg_catalog.current_setting('server_version_num') as version",
    );
    const major = String(Math.floor(Number(version.rows[0]?.version) / 10_000));
    if (!/^\d+$/u.test(major) || Number(major) < 14)
      throw new MigrationError(
        "MIGRATION_SERVER",
        "PostgreSQL migration catalog capture requires PostgreSQL 14 or newer.",
      );
    const scope = await this.#query<NamespaceRow>(
      "select nspname as name, pg_catalog.has_schema_privilege(oid,'USAGE') as usable from pg_catalog.pg_namespace where nspname=any($1::text[]) order by nspname",
      [this.#namespaces],
    );
    let complete = scope.rows.length === this.#namespaces.length && scope.rows.every((row) => row.usable);
    const objects: Record<string, JsonValue> = {};
    if (complete) {
      const result = await this.#query<CatalogRow>(catalogSql, [this.#namespaces]);
      for (const row of result.rows)
        objects[migrationCatalogKey(row.kind, ...row.names)] = { definitionHash: definitionHash(row.definition) };
      if (result.rows.filter((row) => row.kind === "namespace").length !== this.#namespaces.length) complete = false;
      if (result.rows.some((row) => row.kind === "unsupported")) complete = false;
    }
    return {
      formatVersion: 1,
      dialect: "postgres",
      serverMajor: major,
      namespaces: this.#namespaces,
      objects,
      coverage: complete ? "complete" : "unknown",
      environment: { formatVersion: 1, settings },
    };
  }

  async history(): Promise<MigrationHistory> {
    const present = await this.#query<{ present: string | null }>("select pg_catalog.to_regclass($1) as present", [
      this.#ledger,
    ]);
    if (present.rows[0]?.present == null) return emptyHistory();
    const result = await this.#query<{ document: unknown }>(
      `select document from ${this.#ledger} where singleton=true`,
    );
    if (result.rows.length !== 1)
      throw new MigrationError(
        "MIGRATION_HISTORY_INVALID",
        "The migration ledger is missing its unique history document.",
        3,
      );
    return parseHistory(result.rows[0]!.document);
  }

  async lock(milliseconds: number): Promise<void> {
    if (this.#locked)
      throw new MigrationError("MIGRATION_LOCK_HELD", "This session already holds its migration lock.", 3);
    const limit = timeout(milliseconds, 10_000);
    const identity = await this.identity();
    this.#lockKey = createHash("sha256")
      .update(`${identity.database}\0${this.#historyNamespace}`)
      .digest()
      .readBigInt64BE()
      .toString();
    const deadline = Date.now() + limit;
    while (true) {
      const acquired = await this.#query<{ acquired: boolean }>(
        "select pg_catalog.pg_try_advisory_lock($1::bigint) as acquired",
        [this.#lockKey],
      );
      if (acquired.rows[0]?.acquired === true) {
        this.#locked = true;
        return;
      }
      if (Date.now() >= deadline)
        throw new MigrationError(
          "MIGRATION_LOCK_TIMEOUT",
          "Another migration runner holds the target lock; wait for it to finish and retry.",
          3,
        );
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }

  async unlock(): Promise<void> {
    if (!this.#locked) return;
    if (this.#transaction)
      throw new MigrationError(
        "MIGRATION_TRANSACTION_ACTIVE",
        "Finish the active transaction before releasing its migration lock.",
        3,
      );
    const result = await this.#query<{ released: boolean }>(
      "select pg_catalog.pg_advisory_unlock($1::bigint) as released",
      [this.#lockKey],
    );
    if (result.rows[0]?.released !== true)
      throw new MigrationError("MIGRATION_LOCK_LOST", "The migration session no longer holds its target lock.", 4);
    this.#locked = false;
  }

  async bootstrap(): Promise<void> {
    await this.#verifyLock();
    await this.#query(`create schema if not exists ${quoteIdentifier(this.#historyNamespace)}`);
    await this.#query(
      `create table if not exists ${this.#ledger} (singleton boolean primary key check(singleton), document jsonb not null)`,
    );
    await this.#query(
      `insert into ${this.#ledger}(singleton,document) values(true,$1::jsonb) on conflict(singleton) do nothing`,
      [JSON.stringify(emptyHistory())],
    );
    await this.history();
  }

  async begin(): Promise<void> {
    await this.#verifyLock();
    if (this.#transaction)
      throw new MigrationError("MIGRATION_TRANSACTION_ACTIVE", "A migration transaction is already active.");
    await this.#query("begin");
    this.#transaction = true;
  }
  async commit(): Promise<void> {
    if (!this.#transaction)
      throw new MigrationError("MIGRATION_TRANSACTION_MISSING", "There is no active migration transaction.");
    await this.#verifyLock();
    await this.#query("commit");
    this.#transaction = false;
  }
  async rollback(): Promise<void> {
    if (!this.#transaction) return;
    await this.#query("rollback");
    this.#transaction = false;
  }

  validate(statements: readonly MigrationStatement[], _transaction: "required" | "none"): void {
    for (const statement of statements) {
      const parsed = postgresMigrationStatements(statement.text);
      if (!parsed.length)
        throw new MigrationError(
          "MIGRATION_EMPTY_SQL",
          "Migration operations cannot contain only whitespace or comments. Write the intended SQL before planning.",
        );
      if (statement.values.length > 0 && parsed.length !== 1)
        throw new MigrationError(
          "MIGRATION_SCRIPT_PARAMETERS",
          "Parameterized migration SQL must contain exactly one statement.",
        );
    }
  }

  validateReconciliation(statements: readonly MigrationStatement[]): void {
    for (const statement of statements) {
      if (statement.values.length > 0)
        throw new MigrationError(
          "MIGRATION_RECONCILE_SQL",
          "Schema-only reconciliation does not accept bound data values; use explicit data-proof workflows.",
        );
      validatePostgresReconciliation(statement.text);
    }
  }

  async execute(statement: MigrationStatement): Promise<readonly Readonly<Record<string, unknown>>[]> {
    await this.#verifyLock();
    this.validate([statement], this.#transaction ? "required" : "none");
    const statements = postgresMigrationStatements(statement.text);
    let rows: readonly Readonly<Record<string, unknown>>[] = [];
    for (const item of statements) {
      await this.#verifyLock();
      rows = (await this.#query(item.text, statement.values)).rows;
      await this.#verifyLock();
    }
    return rows;
  }

  async check(statement: MigrationStatement, kind: "noRows" | "boolean"): Promise<boolean> {
    const statements = postgresMigrationStatements(statement.text);
    if (statements.length !== 1 || !/^\s*select\b/iu.test(statements[0]!.text))
      throw new MigrationError("MIGRATION_CHECK_QUERY", "Migration data assertions require one SELECT statement.");
    const evaluate = async (): Promise<boolean> => {
      const source = statements[0]!.text.trim().replace(/;$/u, "");
      if (kind === "noRows") {
        const result = await this.#query<{ ok: boolean }>(`select not exists (${source}\n) as ok`, statement.values);
        return result.rows[0]?.ok === true;
      }
      const result = await this.#query(`select * from (${source}\n) as "__typed_sql_check" limit 2`, statement.values);
      if (
        result.rows.length !== 1 ||
        result.fields.length !== 1 ||
        typeof result.rows[0]![result.fields[0]!.name] !== "boolean"
      )
        throw new MigrationError(
          "MIGRATION_CHECK_RESULT",
          "A boolean migration assertion must return exactly one non-null boolean value.",
        );
      return result.rows[0]![result.fields[0]!.name] === true;
    };
    if (!this.#transaction) return evaluate();
    // A warning-level assertion may fail without aborting the surrounding migration.
    // Required failures still reach the engine, which rolls back the complete migration.
    await this.#query("savepoint typed_sql_assertion");
    try {
      const result = await evaluate();
      await this.#query("release savepoint typed_sql_assertion");
      return result;
    } catch (error) {
      try {
        await this.#query("rollback to savepoint typed_sql_assertion");
        await this.#query("release savepoint typed_sql_assertion");
      } catch {
        // A lost connection/transaction is never made reusable by pretending cleanup succeeded.
        this.#fatal = error;
      }
      throw error;
    }
  }

  async saveHistory(history: MigrationHistory): Promise<void> {
    await this.#verifyLock();
    parseHistory(history);
    const saved = await this.#query(
      `update ${this.#ledger} set document=$1::jsonb where singleton=true returning singleton`,
      [JSON.stringify(history)],
    );
    if (saved.rows.length !== 1)
      throw new MigrationError(
        "MIGRATION_HISTORY_INVALID",
        "The migration ledger did not acknowledge its unique history document.",
        3,
      );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      if (this.#transaction) await this.rollback();
      if (this.#locked) await this.unlock();
    } finally {
      this.#closed = true;
      this.#client.removeListener("error", this.#onError);
      this.#client.release(this.#fatal === undefined ? undefined : true);
      await this.#pool.end();
    }
  }
}
