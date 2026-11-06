import { readFile, writeFile } from "node:fs/promises";
import { CATEGORIES, hash, serialize } from "./inventory.mjs";

const path = new URL("../../test/fixtures/language-audit/live-baselines.json", import.meta.url);

export function summarizeLive(input) {
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
    target: input.target,
    categories,
    recognition: input.recognition ?? {
      status: "unavailable",
      reason: "Native prepare/describe probes not provided by this capture",
    },
  };
}

export function reviewLive(input, baseline) {
  const summary = summarizeLive(input);
  const key = hash({ dialect: summary.dialect, target: summary.target });
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

export async function reviewLiveBaseline(input) {
  return reviewLive(input, JSON.parse(await readFile(path, "utf8")));
}

export async function acceptLiveBaseline(input) {
  const baseline = JSON.parse(await readFile(path, "utf8"));
  const review = reviewLive(input, baseline);
  baseline.targets[review.key] = review.summary;
  baseline.targets = Object.fromEntries(
    Object.entries(baseline.targets).sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeFile(path, `${serialize(baseline)}\n`);
  console.log(`${input.dialect} ${input.target.version}: recorded live inventory ${review.key}`);
}

export async function recordNativeFindings(input, recognition) {
  if (!recognition?.observations) return;
  if (hash(recognition.observations) !== input.recognition?.fingerprint)
    throw new Error("Native recognition fingerprint does not match the capture");
  const file = new URL("../../test/fixtures/language-audit/native-findings.json", import.meta.url);
  const data = JSON.parse(await readFile(file, "utf8"));
  const key = hash({ dialect: input.dialect, target: input.target });
  const observations = recognition.observations.filter((row) =>
    ["native-valid-grammar-diagnostic", "native-valid-grammar-unknown"].includes(row.status),
  );
  data.targets[key] = {
    dialect: input.dialect,
    target: input.target,
    scope: recognition.scope,
    counts: input.recognition.counts,
    fingerprint: hash(observations),
    observations,
  };
  data.targets = Object.fromEntries(Object.entries(data.targets).sort(([left], [right]) => left.localeCompare(right)));
  await writeFile(file, `${serialize(data)}\n`);
}
