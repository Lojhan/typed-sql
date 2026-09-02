import { describe, it, strict } from "poku";
import {
  negotiateTypedSqlProtocol,
  TYPED_SQL_PROTOCOL_CAPABILITIES,
  TYPED_SQL_PROTOCOL_SUPPORT_POLICY,
  TYPED_SQL_PROTOCOL_VERSION,
  TypedSqlProtocolCompatibilityError,
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
    strict.ok(Object.isFrozen(TYPED_SQL_PROTOCOL_CAPABILITIES));
  });

  await it("classifies current, legacy, invalid, and out-of-window clients", () => {
    strict.strictEqual(typedSqlProtocolVersionSupport(undefined), "legacy-unversioned");
    strict.strictEqual(typedSqlProtocolVersionSupport(1), "supported");
    strict.strictEqual(typedSqlProtocolVersionSupport(0), "invalid");
    strict.strictEqual(typedSqlProtocolVersionSupport(1.5), "invalid");
    strict.strictEqual(typedSqlProtocolVersionSupport("1"), "invalid");
    strict.strictEqual(typedSqlProtocolVersionSupport(2), "newer-than-supported");
  });

  await it("negotiates a deterministic capability intersection", () => {
    strict.deepStrictEqual(negotiateTypedSqlProtocol(undefined), {
      version: 1,
      client: "legacy-unversioned",
      capabilities: ["analysis-identity", "diagnostic-fixes", "status"],
    });
    strict.deepStrictEqual(
      negotiateTypedSqlProtocol({
        typedSql: { protocol: { version: 1, capabilities: ["status", "future-capability"] } },
      }),
      { version: 1, client: "versioned", capabilities: ["status"] },
    );
  });

  await it("rejects invalid and unsupported client advertisements", () => {
    strict.throws(
      () => negotiateTypedSqlProtocol({ protocolVersion: 2 }),
      (error: unknown) =>
        error instanceof TypedSqlProtocolCompatibilityError &&
        error.code === "TYPED_SQL_PROTOCOL_UNSUPPORTED" &&
        /Update the editor extension and language server together/u.test(error.message),
    );
    strict.throws(
      () => negotiateTypedSqlProtocol({ protocolVersion: 1, protocolCapabilities: "status" }),
      TypedSqlProtocolCompatibilityError,
    );
  });
});
