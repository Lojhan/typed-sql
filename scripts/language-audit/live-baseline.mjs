import { readFile, writeFile } from "node:fs/promises";
import { CATEGORIES, hash, reviewTarget, serialize } from "./inventory.mjs";

const path = new URL("../../test/fixtures/language-audit/live-baselines.json", import.meta.url);

export const liveTarget = reviewTarget;

export function summarizeLive(input, registry = undefined) {
  const categories = Object.fromEntries(
    CATEGORIES.map((name) => {
      const category = input.categories[name];
      if (!category || !["observed", "unavailable"].includes(category.status))
        throw new Error(`Missing or invalid live category: ${name}`);
      if (category.status === "observed" && (!category.rows?.length || hash(category.rows) !== category.fingerprint))
        throw new Error(`Invalid live inventory: ${name}`);
      return [
        name,
        category.status === "observed"
          ? {
              status: category.status,
              fingerprint: category.fingerprint,
              count: category.rows.length,
              scope: category.scope,
              ...(category.unprobeableTypes ? { unprobeableTypes: category.unprobeableTypes } : {}),
            }
          : { status: category.status, reason: category.reason },
      ];
    }),
  );
  return {
    dialect: input.dialect,
    target: liveTarget(input, registry),
    categories,
    recognition: input.recognition ?? {
      status: "unavailable",
      reason: "Native prepare/describe probes not provided by this capture",
    },
  };
}

/** @param {ReturnType<typeof import('../../tools/grammar-catalog/src/registry.mjs').createMapperRegistry> | undefined} [registry] */
export function reviewLive(input, baseline, registry = undefined) {
  const summary = summarizeLive(input, registry);
  const key = hash({ dialect: summary.dialect, target: summary.target });
  if (input.recognition?.counts?.["native-valid-type-mismatch"] > 0)
    return { status: "invalid-inference", key, reason: "Grammar and native type descriptions disagree", summary };
  const previous = baseline.targets[key];
  if (!previous)
    return { status: "review-required", key, reason: "No reviewed inventory for this exact engine/context", summary };
  const changes = CATEGORIES.filter(
    (category) => hash(previous.categories[category]) !== hash(summary.categories[category]),
  );
  if (
    hash(
      previous.recognition ?? {
        status: "unavailable",
        reason: "Native prepare/describe probes not provided by this capture",
      },
    ) !== hash(summary.recognition)
  )
    changes.push("recognition");
  return { status: changes.length ? "review-required" : "match", key, changedCategories: changes, summary };
}

export async function reviewLiveBaseline(input, registry = undefined) {
  return reviewLive(input, JSON.parse(await readFile(path, "utf8")), registry);
}

export async function acceptLiveBaseline(input, registry = undefined) {
  const baseline = JSON.parse(await readFile(path, "utf8"));
  const review = reviewLive(input, baseline, registry);
  if (review.status === "invalid-inference")
    throw new Error("Native type disagreements cannot be accepted as a baseline");
  baseline.targets[review.key] = review.summary;
  baseline.targets = Object.fromEntries(
    Object.entries(baseline.targets).sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeFile(path, `${serialize(baseline)}\n`);
  console.log(`${input.dialect} ${input.target.version}: recorded live inventory ${review.key}`);
}

export async function recordNativeFindings(input, recognition, registry = undefined) {
  if (!recognition?.observations) return;
  if (hash(recognition.observations) !== input.recognition?.fingerprint)
    throw new Error("Native recognition fingerprint does not match the capture");
  const file = new URL("../../test/fixtures/language-audit/native-findings.json", import.meta.url);
  const data = expandFindings(JSON.parse(await readFile(file, "utf8")));
  const target = liveTarget(input, registry);
  const key = hash({ dialect: input.dialect, target });
  const observations = recognition.observations.filter((row) =>
    ["native-valid-grammar-diagnostic", "native-valid-grammar-unknown"].includes(row.status),
  );
  data.targets[key] = {
    dialect: input.dialect,
    target,
    scope: recognition.scope,
    counts: input.recognition.counts,
    fingerprint: hash(observations),
    observations,
  };
  await writeFile(file, `${serialize(compactFindings(data))}\n`);
}

export function expandFindings(data) {
  if (![1, 2].includes(data.formatVersion)) throw new Error("Unsupported native findings format");
  const targets = {};
  for (const [key, value] of Object.entries(data.targets)) {
    const observations =
      value.observations ??
      value.observationIds.map((id) => {
        const observation = data.observations?.[id];
        if (!observation || hash(observation) !== id) throw new Error(`Invalid shared native observation: ${id}`);
        return observation;
      });
    if (hash(observations) !== value.fingerprint) throw new Error(`Invalid native findings fingerprint: ${key}`);
    const { observationIds: _ids, ...metadata } = value;
    targets[key] = { ...metadata, observations };
  }
  return { formatVersion: 1, targets };
}

export function compactFindings(data) {
  const observations = {},
    targets = {};
  for (const key of Object.keys(data.targets).sort()) {
    const { observations: rows, ...metadata } = data.targets[key];
    const observationIds = rows.map((row) => {
      const id = hash(row);
      observations[id] = row;
      return id;
    });
    targets[key] = { ...metadata, observationIds };
  }
  return {
    formatVersion: 2,
    observations: Object.fromEntries(Object.entries(observations).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    targets,
  };
}
