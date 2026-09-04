import { type InjectionKey, inject, type Ref, reactive, readonly, ref } from "vue";
import { DEFAULT_SCHEMAS, type PlaygroundDialect } from "./schema-catalog.js";

const storageKey = "typed-sql.docs.schemas.v1";

export interface SchemaWorkspaceStore {
  readonly schemas: Readonly<Record<PlaygroundDialect, string>>;
  readonly activeDialect: Ref<PlaygroundDialect>;
  readonly isOpen: Ref<boolean>;
  hydrate(): void;
  open(dialect?: PlaygroundDialect): void;
  close(): void;
  update(dialect: PlaygroundDialect, source: string): void;
  reset(dialect: PlaygroundDialect): void;
  resetAll(): void;
}

export const schemaWorkspaceKey: InjectionKey<SchemaWorkspaceStore> = Symbol("typed-sql-schema-workspace");

function savedSchemas(): Partial<Record<PlaygroundDialect, string>> {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([dialect, source]) =>
          (dialect === "postgres" || dialect === "mysql" || dialect === "sqlite") &&
          typeof source === "string" &&
          source.length <= 40_000,
      ),
    );
  } catch {
    return {};
  }
}

export function createSchemaWorkspace(): SchemaWorkspaceStore {
  const schemas = reactive<Record<PlaygroundDialect, string>>({ ...DEFAULT_SCHEMAS });
  const activeDialect = ref<PlaygroundDialect>("postgres");
  const isOpen = ref(false);
  let hydrated = false;

  function persist() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(schemas));
    } catch {
      // Analysis still works when storage is unavailable (private mode, policy, or quota).
    }
  }

  return {
    schemas: readonly(schemas),
    activeDialect,
    isOpen,
    hydrate() {
      if (hydrated) return;
      Object.assign(schemas, savedSchemas());
      hydrated = true;
    },
    open(dialect) {
      if (dialect !== undefined) activeDialect.value = dialect;
      isOpen.value = true;
    },
    close() {
      isOpen.value = false;
    },
    update(dialect, source) {
      schemas[dialect] = source;
      persist();
    },
    reset(dialect) {
      schemas[dialect] = DEFAULT_SCHEMAS[dialect];
      persist();
    },
    resetAll() {
      Object.assign(schemas, DEFAULT_SCHEMAS);
      persist();
    },
  };
}

export function useSchemaWorkspace(): SchemaWorkspaceStore {
  const workspace = inject(schemaWorkspaceKey);
  if (workspace === undefined) throw new Error("Schema workspace was not installed by the typed-sql docs theme");
  return workspace;
}
