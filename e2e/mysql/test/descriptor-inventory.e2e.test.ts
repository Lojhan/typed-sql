import { describe, it, strict } from "poku";
import { captureMySqlDescriptorInventory } from "../../../test/helpers/mysql-descriptor-inventory.js";
import { startMySqlFixture } from "./helpers/database-fixture.js";

const fixture = await startMySqlFixture();
try {
  await describe("MySQL source-driven descriptor inventory", async () => {
    await it("accounts for every generated constructor and preserves independent parameter/result facts", async () => {
      const report = await captureMySqlDescriptorInventory(fixture.rootUri);
      strict.equal(report.observations.length, report.cases.length * 2);
    });
  });
} finally {
  await fixture.close();
}
