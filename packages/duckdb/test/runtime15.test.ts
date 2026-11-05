// Poku isolates this file, so only the 1.5.6 native engine is loaded.
process.env.TYPED_SQL_DUCKDB_SDK = "15";
await import("./runtime.test.js");

export {};
