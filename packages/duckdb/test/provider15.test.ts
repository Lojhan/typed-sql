// Different native engines must not be loaded into the same process (dynamic-library symbol interposition).
process.env.TYPED_SQL_DUCKDB_SDK = "15";
await import("./provider.test.js");

export {};
