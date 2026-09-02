import { describe, it, strict } from "poku";
import {
  TYPED_SQL_PROTOCOL_SUPPORT_POLICY,
  TYPED_SQL_PROTOCOL_VERSION,
  typedSqlProtocolVersionSupport,
} from "../src/index.js";

await describe("typed-sql language-server protocol support policy", async () => {
  await it("publishes an immutable current-version window", () => {
    strict.strictEqual(TYPED_SQL_PROTOCOL_VERSION, 1);
    strict.deepStrictEqual(TYPED_SQL_PROTOCOL_SUPPORT_POLICY.acceptedVersions, [1]);
    strict.strictEqual(TYPED_SQL_PROTOCOL_SUPPORT_POLICY.legacyUnversionedClients, "accepted-as-version-1");
    strict.strictEqual(TYPED_SQL_PROTOCOL_SUPPORT_POLICY.deprecation.removal, "language-server-major-only");
    strict.ok(Object.isFrozen(TYPED_SQL_PROTOCOL_SUPPORT_POLICY));
    strict.ok(Object.isFrozen(TYPED_SQL_PROTOCOL_SUPPORT_POLICY.acceptedVersions));
    strict.ok(Object.isFrozen(TYPED_SQL_PROTOCOL_SUPPORT_POLICY.deprecation));
  });

  await it("classifies current, legacy, invalid, and out-of-window clients", () => {
    strict.strictEqual(typedSqlProtocolVersionSupport(undefined), "legacy-unversioned");
    strict.strictEqual(typedSqlProtocolVersionSupport(1), "supported");
    strict.strictEqual(typedSqlProtocolVersionSupport(0), "invalid");
    strict.strictEqual(typedSqlProtocolVersionSupport(1.5), "invalid");
    strict.strictEqual(typedSqlProtocolVersionSupport("1"), "invalid");
    strict.strictEqual(typedSqlProtocolVersionSupport(2), "newer-than-supported");
  });
});
