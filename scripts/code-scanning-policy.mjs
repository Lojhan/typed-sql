import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const blockingSeverities = new Set(["critical", "high"]);

export function blockingCodeScanningAlerts(alerts) {
  return alerts.filter((alert) => blockingSeverities.has(alert.rule?.security_severity_level));
}

export async function fetchOpenCodeScanningAlerts(repository, options = {}) {
  const repositoryParts = repository.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => part.length === 0)) {
    throw new Error(`Invalid GitHub repository name: ${repository}`);
  }
  const request = options.fetch ?? globalThis.fetch;
  const token = options.token ?? process.env.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) throw new Error("GITHUB_TOKEN is required to inspect CodeQL alerts");
  const alerts = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repositoryParts.map(encodeURIComponent).join("/")}/code-scanning/alerts`);
    url.searchParams.set("state", "open");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await request(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`GitHub code-scanning lookup failed (${response.status}): ${detail}`);
    }
    const pageAlerts = await response.json();
    if (!Array.isArray(pageAlerts)) throw new Error("GitHub code-scanning response was not an array");
    alerts.push(...pageAlerts);
    if (pageAlerts.length < 100) return alerts;
  }
}

export async function assertCodeScanningPolicy(options = {}) {
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;
  if (repository === undefined || repository.length === 0) throw new Error("GITHUB_REPOSITORY is required to inspect CodeQL alerts");
  const alerts = await fetchOpenCodeScanningAlerts(repository, options);
  const blocking = blockingCodeScanningAlerts(alerts);
  if (blocking.length > 0) {
    const summary = blocking.map((alert) => {
      const severity = alert.rule?.security_severity_level ?? "unknown";
      const rule = alert.rule?.id ?? "unknown-rule";
      const location = alert.most_recent_instance?.location?.path ?? "unknown-location";
      return `#${alert.number ?? "?"} ${severity} ${rule} at ${location}`;
    }).join("\n");
    throw new Error(`Release blocked by ${blocking.length} open high-severity CodeQL alert(s):\n${summary}`);
  }
  return { open: alerts.length, blocking: 0 };
}

export async function main() {
  const result = await assertCodeScanningPolicy();
  process.stdout.write(`CodeQL release policy verified: ${result.open} open alert(s), none high severity\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
