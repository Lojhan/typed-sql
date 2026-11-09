import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AnalysisRegistration,
  defineAnalysisRegistration,
  inspectAnalysisCache,
  loadQueryContractInputs,
  openAnalysisCache,
  queryContractDigest,
} from "@typed-sql/analysis";
import { fromConfig, loadConfigSource } from "@typed-sql/config";

export async function runCacheCli(args: readonly string[]): Promise<void> {
  const [operation, ...flags] = args;
  if (operation !== "status" && operation !== "prune") throw new Error("Use typed-sql cache status or cache prune");
  const options: Record<string, string> = {};
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (flag === "--json") {
      options.json = "true";
      continue;
    }
    if (flag !== "--config" && !(operation === "prune" && flag === "--retention-days"))
      throw new Error(`Unsupported cache option ${flag}`);
    const value = flags[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = value;
  }
  const days = options["retention-days"] === undefined ? 30 : Number(options["retention-days"]);
  if (!Number.isSafeInteger(days) || days < 0 || days > 36_500)
    throw new Error("Cache retention must be 0–36500 whole days");
  const loaded = await loadConfigSource(options.config === undefined ? {} : { file: options.config });
  if (!loaded.config.analysis) throw new Error("Cache maintenance requires analysis.cache configuration");
  const configuration = defineAnalysisRegistration(loaded.config.analysis as AnalysisRegistration);
  if (!configuration.cache) throw new Error("Cache maintenance requires analysis.cache configuration");
  const directory = fromConfig(loaded.directory, configuration.cache.directory ?? ".typed-sql/cache/analysis/v1");
  const input = {
    directory,
    workspaceContext: queryContractDigest({ workspace: loaded.directory, config: loaded.file }),
  };
  const inspected = await inspectAnalysisCache(input);
  if (operation === "prune") {
    const report =
      inspected.status === "absent"
        ? { status: "absent" as const, pruned: false as const }
        : {
            status: "present" as const,
            pruned: true as const,
            ...(await (await openAnalysisCache(input)).prune({ retentionMs: days * 86_400_000 })),
          };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report)}\n`
        : report.pruned
          ? `Pruned ${report.removed} unreachable object(s), ${report.bytes} bytes; retained ${report.retainedBytes} bytes.\n`
          : "No analysis cache namespace exists for this configuration.\n",
    );
    return;
  }
  const durable = fromConfig(loaded.directory, configuration.contractsDir ?? `${loaded.config.outDir}/contracts`);
  let durableInputs: Awaited<ReturnType<typeof loadQueryContractInputs>> | undefined;
  let exists = false;
  try {
    await lstat(join(durable, "manifest.json"));
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) durableInputs = await loadQueryContractInputs(durable);
  const exported = new Set(durableInputs?.contracts.map((contract) => contract.digest) ?? []);
  const indexed = [...new Set(inspected.indexedContracts.map((contract) => contract.digest))];
  const catalogs = [...new Set(inspected.indexedCatalogs.map((catalog) => catalog.digest))];
  const report = {
    ...inspected,
    pendingRequests: "unobserved" as const,
    durableExport: {
      indexedContractsMissing: indexed.filter((digest) => !exported.has(digest)),
      indexedContractsAlreadyExported: indexed.filter((digest) => exported.has(digest)).length,
      catalogSelectionsMissing: catalogs.filter((digest) => digest !== durableInputs?.projectCatalogs?.digest),
      catalogSelectionsAlreadyExported: catalogs.filter((digest) => digest === durableInputs?.projectCatalogs?.digest)
        .length,
    },
  };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report)}\n`
      : [
          `Analysis cache: ${report.status}; remote freshness: unverified.`,
          `Indexed query contracts: ${indexed.length}; missing from durable export: ${report.durableExport.indexedContractsMissing.length}.`,
          `Indexed catalog selections: ${catalogs.length}; missing from durable export: ${report.durableExport.catalogSelectionsMissing.length}.`,
          `Indexed outcomes: ${JSON.stringify(report.outcomes)}.`,
          ...report.failures.map((failure) => `  ${failure.kind} (${failure.code}) in context ${failure.contextHash}.`),
          ...report.contexts.map(
            (context) =>
              `Context ${context.contextHash}: ${context.status}; last observation ${context.observedAt} (epoch ms).`,
          ),
          "Active requests in other processes are unobserved; editor status reports its own live queue.",
          "Index references are not proof of current remote validity or full project coverage.",
          "",
        ].join("\n"),
  );
}
