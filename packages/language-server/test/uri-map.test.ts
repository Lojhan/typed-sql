import { describe, it, strict } from "poku";
import { canonicalDocumentUri, UriMap } from "../src/uri-map.js";

await describe("document URI identity", async () => {
  await it("merges Windows drive casing, path casing, and encoded drive separators", () => {
    strict.equal(
      canonicalDocumentUri("file:///D:/App/Query.ts", true),
      canonicalDocumentUri("file:///d%3A/app/query.ts", true),
    );
    strict.equal(
      canonicalDocumentUri("file://SERVER/Share/Query.ts", true),
      canonicalDocumentUri("file://server/share/query.ts", true),
    );
  });
  await it("preserves distinct case-sensitive POSIX files and virtual schemes", () => {
    strict.notEqual(
      canonicalDocumentUri("file:///tmp/Query.ts", false),
      canonicalDocumentUri("file:///tmp/query.ts", false),
    );
    strict.equal(canonicalDocumentUri("untitled:Query.ts"), "untitled:Query.ts");
    const values = new UriMap<number>();
    const base = process.platform === "win32" ? "file:///D:/tmp/" : "file:///tmp/";
    values.set(`${base}query%2Ets`, 1);
    strict.equal(values.get(`${base}query.ts`), 1);
    strict.equal(values.has(`${base}query.ts`), true);
    strict.equal(values.delete(`${base}query.ts`), true);
    strict.equal(values.size, 0);
  });
});
