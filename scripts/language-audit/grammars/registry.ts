import { createMapperRegistry } from "../../../tools/grammar-catalog/src/registry.mjs";
import type { AuditGrammar, AuditGrammarDefinition } from "./contracts.js";

export interface AuditGrammarRegistry {
  readonly ids: readonly string[];
  get(id: string): AuditGrammar;
  extend(contributions: readonly AuditGrammarDefinition[]): AuditGrammarRegistry;
}

function expose(registry: ReturnType<typeof createMapperRegistry>): AuditGrammarRegistry {
  return Object.freeze({
    ids: registry.ids as readonly string[],
    // The neutral registry checks identity, inheritance and required methods before this boundary.
    get: (id: string): AuditGrammar => registry.get(id) as AuditGrammar,
    extend: (contributions: readonly AuditGrammarDefinition[]) => expose(registry.extend(contributions)),
  });
}

export function createAuditGrammarRegistry(definitions: readonly AuditGrammarDefinition[]): AuditGrammarRegistry {
  return expose(
    createMapperRegistry(definitions, {
      methods: ["versionBand", "createAnalysis", "tokenize", "planInvocations", "planEntity"],
    }),
  );
}
