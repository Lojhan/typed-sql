import { ordered, rowsLiteral } from "./common.mjs";

/** Share identical records only across versions that actually own them. */
export async function emitPostgresProfiles({ profiles, directory, emit, header, extraExports = new Map() }) {
  const memberships = new Map();
  for (const [major, rows] of profiles)
    for (const row of rows) {
      const key = JSON.stringify(row),
        entry = memberships.get(key) ?? { row, majors: [] };
      entry.majors.push(major);
      memberships.set(key, entry);
    }
  const partitions = new Map(),
    locations = new Map();
  for (const { row, majors } of memberships.values()) {
    const group = majors
      .map(Number)
      .sort((a, b) => a - b)
      .join("-");
    const rows = partitions.get(group) ?? [];
    rows.push(row);
    partitions.set(group, rows);
  }
  for (const [name, values] of [...partitions].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = ordered(values);
    rows.forEach((row, index) => {
      locations.set(JSON.stringify(row), { name, index });
    });
    await emit(
      `packages/postgres/src/catalog/generated/${directory}/groups/${name}.ts`,
      `${header}import type {PostgresNativeSignature} from "../../../native-resolution.js";\nexport const entries:readonly PostgresNativeSignature[] = ${rowsLiteral(rows)};\n`,
    );
  }
  for (const [major, rows] of profiles) {
    const groups = [...new Set(rows.map((row) => locations.get(JSON.stringify(row)).name))].sort();
    const aliases = new Map(groups.map((name, index) => [name, `group${index}`]));
    await emit(
      `packages/postgres/src/catalog/generated/${directory}/${major}.ts`,
      `${header}import type {PostgresNativeSignature} from "../../native-resolution.js";\n${groups.map((name) => `import {entries as ${aliases.get(name)}} from "./groups/${name}.js";`).join("\n")}\nexport const nativeSignatures:readonly PostgresNativeSignature[] = Object.freeze([${rows
        .map((row) => {
          const { name, index } = locations.get(JSON.stringify(row));
          return `${aliases.get(name)}[${index}]!`;
        })
        .join(",")}]);\n${extraExports.get(major) ?? ""}`,
    );
  }
  return locations;
}
