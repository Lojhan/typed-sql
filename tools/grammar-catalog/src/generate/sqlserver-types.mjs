import { sqlserverEntityFacts } from "../mappers/facets/sqlserver.mjs";
import { hash } from "../model/canonical.mjs";
import { describeEntity } from "../model/facets.mjs";
import { commonEntities, nativeIdentity, requireKnown } from "../model/projection.mjs";

// Compatibility only. Production callers consume validated model groups.
export function sqlServerTypeSource(policy, groups, header) {
  const entities = groups
    .filter((group) => group.dialect === "sqlserver")
    .flatMap((group) => group.categories.types.rows)
    .map((row) => ({
      name: row.name,
      semantic: describeEntity("types", row.name, sqlserverEntityFacts("types", row)),
    }));
  return renderTypeSource(policy, entities, header);
}
export function sqlServerSemanticTypeSource(policy, groups, header) {
  return renderTypeSource(
    policy,
    groups.flatMap((group) => commonEntities(group, "types")),
    header,
  );
}
// Physical limits are explicit facts; representation, defaults and aliases remain owned policy.
function renderTypeSource(policy, entities, header) {
  const observed = entities.map((entity) => {
    const facet = entity.semantic;
    if (facet.kind !== "type") throw new TypeError(`Invalid SQL Server type facet: ${entity.name}`);
    const storage = requireKnown(facet.storageIdentity, `${entity.name} storage identity`);
    if (!/^\d+$/u.test(storage)) throw new TypeError(`Invalid SQL Server storage identity: ${entity.name}`);
    return {
      name: nativeIdentity(facet.canonical, entity.name),
      system_type_id: storage,
      max_length: requireKnown(facet.dimensions.maxLength, `${entity.name} width`),
      precision: requireKnown(facet.dimensions.precision, `${entity.name} precision`),
      scale: requireKnown(facet.dimensions.scale, `${entity.name} scale`),
    };
  });
  const rules = {},
    nativeFacts = new Map(),
    bounds = [];
  for (const rule of policy.types) {
    const facts = [
      ...new Map(
        observed.filter((row) => row.name === (rule.nativeName ?? rule.name)).map((row) => [hash(row), row]),
      ).values(),
    ];
    if (facts.length !== 1) throw new Error(`Missing or conflicting SQL Server type facts: ${rule.name}`);
    if (
      !["plain", "sized", "decimal", "temporal", "float"].includes(rule.form) ||
      !["number", "string", "boolean", "Uint8Array", "bigint", "decimal", "temporal", "json", "unknown"].includes(
        rule.mapping,
      )
    )
      throw new Error(`Invalid SQL Server type policy: ${rule.name}`);
    const fact = facts[0];
    const definition = { ...rule, maximumPrecision: fact.precision, maximumScale: fact.scale };
    if (rule.form === "sized") {
      if (![1, 2].includes(rule.byteWidth)) throw new Error(`Missing SQL Server encoding width: ${rule.name}`);
      definition.maximumLength = fact.max_length / rule.byteWidth;
      if (!Number.isSafeInteger(definition.maximumLength) || definition.maximumLength < 1)
        throw new Error(`Invalid native SQL Server length: ${rule.name}`);
      definition.defaultLengths = policy.typeDefaults?.sized;
      if (
        !definition.defaultLengths ||
        ["declaration", "cast"].some(
          (context) =>
            !Number.isSafeInteger(definition.defaultLengths[context]) ||
            definition.defaultLengths[context] < 1 ||
            definition.defaultLengths[context] > definition.maximumLength,
        )
      )
        throw new Error(`Missing SQL Server contextual length defaults: ${rule.name}`);
    }
    rules[rule.name] = definition;
    nativeFacts.set(rule.name, fact);
    if (typeof rule.signed === "boolean") {
      const bits = fact.max_length * 8;
      if (![8, 16, 32, 64].includes(bits)) throw new Error(`Unqualified native integer width: ${rule.name}`);
      const width = BigInt(bits - (rule.signed ? 1 : 0));
      bounds.push(
        `${JSON.stringify(rule.name)}: Object.freeze([${rule.signed ? -(1n << width) : 0n}n, ${(1n << width) - 1n}n] as const)`,
      );
    }
  }
  const fixedAliases = {};
  // Storage identity is not logical alias evidence (VECTOR shares VARBINARY's ID).
  // The reviewed alias relationship supplies identity; native facts supply dimensions.
  for (const [name, baseName] of Object.entries(policy.systemAliases ?? {})) {
    const facts = [...new Map(observed.filter((row) => row.name === name).map((row) => [hash(row), row])).values()];
    const rule = rules[baseName],
      base = nativeFacts.get(baseName);
    if (facts.length !== 1 || !rule || !base || facts[0].system_type_id !== base.system_type_id)
      throw new Error(`Missing or conflicting SQL Server alias facts: ${name}`);
    const fact = facts[0];
    if (rule.form === "sized") {
      const length = fact.max_length / rule.byteWidth;
      if (!Number.isSafeInteger(length) || length < 1 || length > rule.maximumLength)
        throw new Error(`Invalid SQL Server alias dimensions: ${name}`);
      fixedAliases[name] = { name: rule.name, text: `${rule.name}(${length})`, length };
    } else if (rule.form === "plain" && fact.max_length === base.max_length)
      fixedAliases[name] = { name: rule.name, text: rule.name };
    else throw new Error(`Unsupported SQL Server alias shape: ${name}`);
  }
  return `${header}import type { SqlServerNativeType, SqlServerNativeTypeRule } from "../../native-types.js";\nexport const typeRules: Readonly<Record<string, SqlServerNativeTypeRule>> = ${JSON.stringify(rules)};\nexport const typeAliases: Readonly<Record<string, string>> = ${JSON.stringify(policy.typeAliases)};\nexport const fixedTypeAliases: Readonly<Record<string, SqlServerNativeType>> = ${JSON.stringify(fixedAliases)};\nexport const integerBounds: Readonly<Record<string, readonly [bigint, bigint]>> = Object.freeze({${bounds.join(",")}});\n`;
}
