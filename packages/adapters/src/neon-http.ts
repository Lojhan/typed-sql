import { type BatchDatabase, type BufferedOptions, createBufferedDatabase, rawPostgresTypes } from "./index.js";

export type NeonHttpClient = import("@neondatabase/serverless").NeonQueryFunction<false, true>;
const rawOptions = Object.freeze({ fullResults: true, arrayMode: false, types: rawPostgresTypes } as const);

export function createNeonHttpDatabase(client: NeonHttpClient, options: BufferedOptions): BatchDatabase {
  if (
    options.profile.jsonWire !== "text" ||
    (options.profile.jsonInputWire !== undefined && options.profile.jsonInputWire !== "text")
  )
    throw new TypeError("This adapter requires text JSON wire formats");
  if (options.profile.dialect !== "postgres" || options.profile.jsonWire !== "text")
    throw new TypeError("Neon HTTP requires a PostgreSQL raw-text transport profile");
  return createBufferedDatabase(
    {
      async execute(text, values) {
        return (await client.query(text, [...values], rawOptions)).rows;
      },
      async batch(statements) {
        const queries = statements.map(({ text, values }) => client.query(text, [...values], rawOptions));
        return (await client.transaction(queries, rawOptions)).map((result) => result.rows);
      },
    },
    options,
  );
}
