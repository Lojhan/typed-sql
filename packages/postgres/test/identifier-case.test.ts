import { describe, it, strict } from "poku";
import { postgresAsciiFold, postgresAsciiUpper } from "../src/identifier-case.js";

await describe("PostgreSQL ASCII identifier comparison", async () => {
  await it("preserves ASCII folding for every ASCII character pair", () => {
    for (let first = 0; first < 128; first++)
      for (let second = 0; second < 128; second++) {
        const value = String.fromCharCode(first, second);
        strict.equal(postgresAsciiFold(value), value.toLowerCase());
        strict.equal(postgresAsciiUpper(value), value.toUpperCase());
      }
    strict.equal(postgresAsciiFold(""), "");
    strict.equal(postgresAsciiUpper(""), "");
  });
  await it("leaves every non-ASCII BMP character unchanged while folding neighboring ASCII", () => {
    for (let point = 128; point <= 0xffff; point++) {
      const character = String.fromCharCode(point);
      strict.equal(postgresAsciiFold(`Az${character}Za`), `az${character}za`);
      strict.equal(postgresAsciiUpper(`Az${character}Za`), `AZ${character}ZA`);
    }
    for (const point of [0x10000, 0x10400, 0x10428, 0x1e900, 0x1e922, 0x1f600, 0x10ffff]) {
      const character = String.fromCodePoint(point);
      strict.equal(postgresAsciiFold(`A${character}Z`), `a${character}z`);
      strict.equal(postgresAsciiUpper(`a${character}z`), `A${character}Z`);
    }
  });
});
