// Both genuine SDK versions execute against independently installed public tarballs.
import { tsImport } from "tsx/esm/api";

await tsImport("../../duckdb/test.mjs", import.meta.url);
