import { hash } from "../language-audit/hash.mjs";

// Physical limits come from sys.types; representation and syntax remain grammar policy.
export function sqlServerTypeSource(policy, groups, header) {
  const observed = groups
    .filter((group) => group.dialect === "sqlserver")
    .flatMap((group) => group.categories.types.rows)
    .map((row) => ({
      name: row.name,
      system_type_id: Number(row.system_type_id),
      max_length: Number(row.max_length),
      precision: Number(row.precision),
      scale: Number(row.scale),
    }));
  if (
    observed.some((row) =>
      [row.system_type_id, row.max_length, row.precision, row.scale].some((value) => !Number.isSafeInteger(value)),
    )
  )
    throw new Error("Invalid native SQL Server type dimensions");
  const rules = {},
    physical = new Map(),
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
    }
    rules[rule.name] = definition;
    physical.set(fact.system_type_id, { rule: definition, fact });
    if (typeof rule.signed === "boolean") {
      const bits = fact.max_length * 8;
      if (![8, 16, 32, 64].includes(bits)) throw new Error(`Unqualified native integer width: ${rule.name}`);
      const width = BigInt(bits - (rule.signed ? 1 : 0));
      bounds.push(
        `${JSON.stringify(rule.name)}: Object.freeze([${rule.signed ? -(1n << width) : 0n}n, ${(1n << width) - 1n}n] as const)`,
      );
    }
  }
  const nativeNames = new Set(policy.types.map((rule) => rule.nativeName ?? rule.name));
  const fixedAliases = {};
  for (const fact of observed) {
    if (nativeNames.has(fact.name) || Object.hasOwn(policy.typeAliases, fact.name)) continue;
    const base = physical.get(fact.system_type_id);
    if (!base) continue;
    if (base.rule.form === "sized") {
      const length = fact.max_length / base.rule.byteWidth;
      if (!Number.isSafeInteger(length) || length < 1 || length > base.rule.maximumLength) continue;
      const alias = { name: base.rule.name, text: `${base.rule.name}(${length})`, length };
      if (fixedAliases[fact.name] && hash(fixedAliases[fact.name]) !== hash(alias))
        throw new Error(`Conflicting SQL Server alias dimensions: ${fact.name}`);
      fixedAliases[fact.name] = alias;
    } else if (base.rule.form === "plain" && fact.max_length === base.fact.max_length)
      fixedAliases[fact.name] = { name: base.rule.name, text: base.rule.name };
  }
  return `${header}import type { SqlServerNativeType, SqlServerNativeTypeRule } from "../../native-types.js";\nexport const typeRules: Readonly<Record<string, SqlServerNativeTypeRule>> = ${JSON.stringify(rules)};\nexport const typeAliases: Readonly<Record<string, string>> = ${JSON.stringify(policy.typeAliases)};\nexport const fixedTypeAliases: Readonly<Record<string, SqlServerNativeType>> = ${JSON.stringify(fixedAliases)};\nexport const integerBounds: Readonly<Record<string, readonly [bigint, bigint]>> = Object.freeze({${bounds.join(",")}});\n`;
}
