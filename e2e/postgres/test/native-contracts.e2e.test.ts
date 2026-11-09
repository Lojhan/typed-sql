import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "poku";
import { assertPostgresNativeContracts } from "../../../test/helpers/postgres-native-contracts.js";
import { startPostgresFixture } from "./helpers/database-fixture.js";

const fixture = await startPostgresFixture();
try {
  await describe("PostgreSQL native contracts and descriptor inventory", async () => {
    await it("qualifies native contracts within the declared scope and checks reviewed descriptors", async () => {
      await assertPostgresNativeContracts(
        fixture.connectionString,
        resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      );
    });
  });
} finally {
  await fixture.close();
}
