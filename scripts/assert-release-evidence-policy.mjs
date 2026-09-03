import { resolve } from "node:path";
import { loadReleaseEvidencePolicy } from "./release-evidence-policy.mjs";
import { loadReleaseManifest } from "./release-policy.mjs";

const workspace = resolve(import.meta.dirname, "..");
const requested = process.argv[2];
const policy = await loadReleaseEvidencePolicy(workspace);
const manifest = await loadReleaseManifest(workspace);
if (requested !== manifest.channel) throw new Error(`Evidence channel ${requested} does not match ${manifest.channel}`);
const channel = policy.channels[requested];
if (channel === undefined) throw new Error(`No evidence policy exists for ${requested}`);
if (requested === "stable" && manifest.sourceCandidate === undefined)
  throw new Error("Stable release evidence requires a source candidate");
console.log(`${requested} requires ${channel.required.length} evidence gates`);
