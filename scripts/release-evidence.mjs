import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const identifierPattern = /^[a-z][a-z0-9-]*$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const removalIssuePattern = /^(?:#[1-9]\d*|https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9]\d*)$/u;
const downgradedFeatureStates = new Set(["conservative", "unsupported", "out-of-scope"]);

const hash = (value) => createHash("sha256").update(value).digest("hex");

function object(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function text(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function identifiers(value, path) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !identifierPattern.test(item))
  ) {
    throw new TypeError(`${path} must contain lowercase hyphenated identifiers`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${path} contains duplicate identifiers`);
  return Object.freeze([...value].sort());
}

function utcDate(value, path) {
  if (typeof value !== "string" || !datePattern.test(value)) throw new TypeError(`${path} must be an ISO date`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${path} is not a valid calendar date`);
  }
  return value;
}

function today(value = new Date()) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new TypeError("Current date must be valid");
  return value.toISOString().slice(0, 10);
}

export function validateReleaseExceptions(value, options = {}) {
  const source = object(value, "Release exceptions");
  if (source.formatVersion !== 1) throw new TypeError("Unsupported release exception formatVersion");
  if (!Array.isArray(source.exceptions)) throw new TypeError("Release exceptions must be an array");
  const currentDate = today(options.now);
  const seen = new Set();
  const exceptions = source.exceptions.map((entry, index) => {
    const exception = object(entry, `exceptions[${index}]`);
    const id = text(exception.id, `exceptions[${index}].id`);
    if (!identifierPattern.test(id)) throw new TypeError(`exceptions[${index}].id is invalid`);
    if (seen.has(id)) throw new TypeError(`Duplicate release exception ${id}`);
    seen.add(id);
    const expiresOn = utcDate(exception.expiresOn, `exceptions[${index}].expiresOn`);
    if (expiresOn < currentDate) throw new Error(`Release exception ${id} expired on ${expiresOn}`);
    const affectedFeatures = object(exception.affectedFeatures, `exceptions[${index}].affectedFeatures`);
    const featureEntries = Object.entries(affectedFeatures).sort(([left], [right]) => left.localeCompare(right));
    if (featureEntries.length === 0) throw new TypeError(`exceptions[${index}].affectedFeatures must not be empty`);
    for (const [feature, state] of featureEntries) {
      if (feature.length === 0 || !downgradedFeatureStates.has(state)) {
        throw new TypeError(`Release exception ${id} must downgrade every affected feature`);
      }
    }
    const removalIssue = text(exception.removalIssue, `exceptions[${index}].removalIssue`);
    if (!removalIssuePattern.test(removalIssue))
      throw new TypeError(`Release exception ${id} has an invalid removal issue`);
    return Object.freeze({
      id,
      gates: identifiers(exception.gates, `exceptions[${index}].gates`),
      owner: text(exception.owner, `exceptions[${index}].owner`),
      reason: text(exception.reason, `exceptions[${index}].reason`),
      affectedFeatures: Object.freeze(Object.fromEntries(featureEntries)),
      expiresOn,
      removalIssue,
    });
  });
  return Object.freeze({
    formatVersion: 1,
    exceptions: Object.freeze(exceptions.sort((left, right) => left.id.localeCompare(right.id))),
  });
}

export function validateReleaseEvidenceInput(value, path = "Evidence input") {
  const source = object(value, path);
  if (source.formatVersion !== 1) throw new TypeError(`${path} has an unsupported formatVersion`);
  const revision = text(source.revision, `${path}.revision`);
  return Object.freeze({
    formatVersion: 1,
    revision,
    lane: text(source.lane, `${path}.lane`),
    gates: identifiers(source.gates, `${path}.gates`),
  });
}

export function assembleReleaseEvidence({ policy, manifest, exceptions, inputs, revision }) {
  const channel = policy.channels[manifest.channel];
  if (channel === undefined) throw new Error(`No evidence policy exists for ${manifest.channel}`);
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("Release evidence requires at least one input");
  const sources = inputs.map((input, index) => {
    const validated = validateReleaseEvidenceInput(input.value, `Evidence input ${input.name ?? index + 1}`);
    if (validated.revision !== revision) {
      throw new Error(`Evidence input ${input.name ?? index + 1} targets ${validated.revision}, expected ${revision}`);
    }
    return Object.freeze({
      name: text(input.name, `inputs[${index}].name`),
      lane: validated.lane,
      gates: validated.gates,
      sha256: text(input.sha256, `inputs[${index}].sha256`),
    });
  });
  const required = [...channel.required];
  const proven = required.filter((gate) => sources.some((source) => source.gates.includes(gate)));
  const missing = required.filter((gate) => !proven.includes(gate));
  const applicableExceptions = exceptions.exceptions.filter((exception) =>
    exception.gates.some((gate) => missing.includes(gate)),
  );
  const excepted = missing.filter((gate) => applicableExceptions.some((exception) => exception.gates.includes(gate)));
  const blocking = missing.filter((gate) => !excepted.includes(gate));
  const complete = missing.length === 0;
  return Object.freeze({
    formatVersion: 1,
    channel: manifest.channel,
    series: manifest.series,
    revision,
    complete,
    publishable: blocking.length === 0,
    stableClaimsAllowed: channel.stableClaimsAllowed && complete,
    required,
    proven,
    missing,
    excepted,
    blocking,
    exceptions: applicableExceptions,
    sources: sources.sort((left, right) => left.name.localeCompare(right.name)),
  });
}

export async function loadEvidenceInput(path) {
  const bytes = await readFile(path);
  return { name: basename(path), sha256: hash(bytes), value: JSON.parse(bytes.toString("utf8")) };
}

export async function writeImmutableEvidence(path, report) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  let current;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (current !== undefined && current !== serialized) {
    throw new Error(`Release evidence ${path} already exists with different content; append a new record instead`);
  }
  if (current === undefined) await writeFile(path, serialized, { flag: "wx" });
  return serialized;
}
