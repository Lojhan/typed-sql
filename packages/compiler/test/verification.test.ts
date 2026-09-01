import { describe, it, strict } from "poku";
import type { LiveQueryVerifier, SchemaSnapshot } from "../../core/src/index.js";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import {
  assertQueryVerificationProofCurrent,
  buildQueryManifest,
  collectQueryVerificationCandidates,
  parseQueryVerificationProof,
  serializeQueryVerificationProof,
  verifyQueryManifest,
} from "../src/index.js";

const schema: PostgresSchemaSnapshot = {
  formatVersion: 1,
  dialect: "postgres",
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "text", tsType: "string", nullable: false },
      },
    },
  },
};

const source = [
  'import { sql } from "@typed-sql/postgres";',
  "declare const id: bigint;",
  "const query = sql`SELECT users.id, users.email FROM users WHERE users.id = ${id}`;",
  'const dynamic = sql.dynamic(process.env["SECRET_SQL"] ?? "SELECT recognizable-secret");',
  "void [query, dynamic];",
].join("\n");

function fixture() {
  const dialect = postgres();
  const rootDir = "/portable/project";
  const sources = [{ file: `${rootDir}/src/query.ts`, source }];
  const projects = [`${rootDir}/tsconfig.json`];
  const manifest = buildQueryManifest({
    rootDir,
    sources,
    projects,
    dialect,
    schema,
    compilerVersion: "2.0.0-test",
  }).manifest;
  const candidates = collectQueryVerificationCandidates({ manifest, rootDir, sources, projects, dialect, schema });
  return { dialect, rootDir, sources, projects, manifest, candidates };
}

function verifier(overrides: Partial<LiveQueryVerifier> = {}): LiveQueryVerifier {
  return {
    dialect: "postgres",
    adapterVersion: "test-adapter-v1",
    async server() {
      return { version: "18.4", features: ["z:1", "a:1"] };
    },
    async verify() {
      return {
        columns: [
          { index: 1, databaseType: "bigint", tsType: "bigint" },
          { index: 2, databaseType: "text", tsType: "string" },
        ],
        parameters: [{ index: 1, databaseType: "bigint", tsType: "bigint" }],
      };
    },
    async close() {},
    ...overrides,
  };
}

await describe("live query verification", async () => {
  await it("collects transient SQL only after proving sources match the manifest", () => {
    const value = fixture();
    strict.strictEqual(value.candidates.length, 1);
    strict.match(value.candidates[0]!.sql, /SELECT users\.id/u);
    strict.throws(
      () =>
        collectQueryVerificationCandidates({
          manifest: value.manifest,
          rootDir: value.rootDir,
          sources: [{ file: `${value.rootDir}/src/query.ts`, source: `${source}\n// changed` }],
          projects: value.projects,
          dialect: value.dialect,
          schema,
        }),
      /stale/u,
    );
  });

  await it("emits deterministic secret-free proof and explicit unresolved skips", async () => {
    const value = fixture();
    const first = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: value.candidates,
      verifier: verifier(),
    });
    const second = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: value.candidates,
      verifier: verifier(),
    });
    strict.strictEqual(first.verified, 1);
    strict.strictEqual(first.skipped, 1);
    strict.strictEqual(first.proof.server.features?.[0], "a:1");
    const serialized = serializeQueryVerificationProof(first.proof);
    strict.strictEqual(serialized, serializeQueryVerificationProof(second.proof));
    strict.ok(!serialized.includes("SELECT"));
    strict.ok(!serialized.includes("recognizable-secret"));
    strict.ok(!serialized.includes("/portable/project"));
    strict.strictEqual(parseQueryVerificationProof(JSON.parse(serialized)).cacheKey, first.proof.cacheKey);
    assertQueryVerificationProofCurrent(value.manifest, first.proof, verifier());
  });

  await it("reports exact grammar-versus-native mismatches without driver errors", async () => {
    const value = fixture();
    const mismatch = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: value.candidates,
      verifier: verifier({
        async verify() {
          return {
            columns: [{ index: 1, name: "wrong", databaseType: "text", tsType: "string", nullable: true }],
            parameters: [],
          };
        },
      }),
    });
    strict.strictEqual(mismatch.mismatched, 1);
    const entry = mismatch.proof.entries.find((item) => item.status === "mismatch");
    if (entry?.status !== "mismatch") strict.fail("Expected a mismatch entry");
    strict.deepStrictEqual([...new Set(entry.mismatches.map((item) => item.kind))].sort(), [
      "column-count",
      "column-name",
      "nullability",
      "parameter-count",
      "typescript-type",
    ]);

    const failed = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: value.candidates,
      verifier: verifier({
        async verify() {
          throw new Error("postgresql://user:secret@host/db SELECT private");
        },
      }),
    });
    strict.strictEqual(failed.failed, 1);
    const serialized = serializeQueryVerificationProof(failed.proof);
    strict.ok(!serialized.includes("secret"));
    strict.ok(!serialized.includes("private"));
  });

  await it("accepts literal parameter subsets without weakening result verification", async () => {
    const value = fixture();
    const compareParameterTypes = async (expected: string, actual: string) =>
      verifyQueryManifest({
        manifest: value.manifest,
        candidates: [
          {
            ...value.candidates[0]!,
            parameters: value.candidates[0]!.parameters.map((field) => ({ ...field, tsType: expected })),
          },
        ],
        verifier: verifier({
          async verify() {
            return {
              columns: [
                { index: 1, databaseType: "bigint", tsType: "bigint" },
                { index: 2, databaseType: "text", tsType: "string" },
              ],
              parameters: [{ index: 1, databaseType: "native", tsType: actual }],
            };
          },
        }),
      });
    const literalParameter = {
      ...value.candidates[0]!,
      parameters: value.candidates[0]!.parameters.map((field) => ({
        ...field,
        tsType: '"active" | "suspended"',
      })),
    };
    const accepted = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: [literalParameter],
      verifier: verifier({
        async verify() {
          return {
            columns: [
              { index: 1, databaseType: "bigint", tsType: "bigint" },
              { index: 2, databaseType: "text", tsType: "string" },
            ],
            parameters: [{ index: 1, databaseType: "varchar", tsType: "string" }],
          };
        },
      }),
    });
    strict.strictEqual(accepted.verified, 1);

    const literalColumn = {
      ...value.candidates[0]!,
      columns: value.candidates[0]!.columns.map((field, index) =>
        index === 1 ? { ...field, tsType: '"active" | "suspended"' } : field,
      ),
    };
    const rejected = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: [literalColumn],
      verifier: verifier(),
    });
    strict.strictEqual(rejected.mismatched, 1);

    const broadParameter = {
      ...value.candidates[0]!,
      parameters: value.candidates[0]!.parameters.map((field) => ({ ...field, tsType: "string" })),
    };
    const narrowNativeInput = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: [broadParameter],
      verifier: verifier({
        async verify() {
          return {
            columns: [
              { index: 1, databaseType: "bigint", tsType: "bigint" },
              { index: 2, databaseType: "text", tsType: "string" },
            ],
            parameters: [{ index: 1, databaseType: "enum", tsType: '"active" | "suspended"' }],
          };
        },
      }),
    });
    strict.strictEqual(narrowNativeInput.mismatched, 1);

    for (const [expected, actual] of [
      ['"pipe|value" | "escaped\\\\value"', "string"],
      ["1 | -2.5 | 6e2", "number"],
      ["1n | -2n", "bigint"],
      ["true | false", "boolean"],
      ["null | undefined", "null | undefined"],
    ] as const) {
      strict.strictEqual((await compareParameterTypes(expected, actual)).verified, 1, `${expected} -> ${actual}`);
    }
    for (const [expected, actual] of [
      ["number", "1 | 2"],
      ['{ readonly kind: "x|y" }', "string"],
      [String.raw`"\q"`, "string"],
    ] as const) {
      strict.strictEqual((await compareParameterTypes(expected, actual)).mismatched, 1, `${expected} !-> ${actual}`);
    }
  });

  await it("bounds native concurrency and rejects stale or malformed proof", async () => {
    const value = fixture();
    const base = value.candidates[0]!;
    const variants = Array.from({ length: 8 }, (_, index) => ({
      ...base,
      variantFingerprint: `sha256:${String(index).padStart(64, "0")}`,
    }));
    const manifest = {
      ...value.manifest,
      queries: value.manifest.queries.flatMap((entry) =>
        entry.status === "resolved"
          ? [
              {
                ...entry,
                variants: variants.map((variant) => ({
                  ...entry.variants[0]!,
                  fingerprint: variant.variantFingerprint,
                })),
              },
            ]
          : [],
      ),
    };
    let active = 0;
    let maximum = 0;
    const result = await verifyQueryManifest({
      manifest,
      candidates: variants,
      concurrency: 2,
      verifier: verifier({
        async verify() {
          active += 1;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active -= 1;
          return { columns: [{ index: 1 }, { index: 2 }], parameters: [{ index: 1 }] };
        },
      }),
    });
    strict.strictEqual(maximum, 2);
    strict.strictEqual(result.verified, 8);
    strict.throws(() => assertQueryVerificationProofCurrent(value.manifest, result.proof), /stale/u);
    strict.throws(() => parseQueryVerificationProof({ formatVersion: 99 }), /Unsupported/u);
  });

  await it("skips unsafe operations instead of invoking the adapter", async () => {
    const value = fixture();
    let called = false;
    const candidate = { ...value.candidates[0]!, operation: "ddl" as const };
    const result = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: [candidate],
      verifier: verifier({
        async verify() {
          called = true;
          return { columns: [], parameters: [] };
        },
      }),
    });
    strict.strictEqual(called, false);
    strict.strictEqual(result.skipped, 2);
  });

  await it("validates verifier identity, concurrency, server metadata, and unavailable evidence", async () => {
    const value = fixture();
    await strict.rejects(
      verifyQueryManifest({
        manifest: value.manifest,
        candidates: value.candidates,
        verifier: verifier({ dialect: "mysql" }),
      }),
      /does not match/u,
    );
    await strict.rejects(
      verifyQueryManifest({
        manifest: value.manifest,
        candidates: value.candidates,
        concurrency: 0,
        verifier: verifier(),
      }),
      /positive safe integer/u,
    );
    await strict.rejects(
      verifyQueryManifest({
        manifest: value.manifest,
        candidates: value.candidates,
        verifier: verifier({ adapterVersion: "" }),
      }),
      /must not be empty/u,
    );
    await strict.rejects(
      verifyQueryManifest({
        manifest: value.manifest,
        candidates: value.candidates,
        verifier: verifier({
          async server() {
            return { version: "" };
          },
        }),
      }),
      /server\.version/u,
    );
    const unavailable = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: value.candidates,
      verifier: verifier({
        async verify() {
          return { columns: [], parameters: [], unavailable: ["columns"] };
        },
      }),
    });
    strict.strictEqual(unavailable.skipped, 2);

    const missing = await verifyQueryManifest({ manifest: value.manifest, candidates: [], verifier: verifier() });
    strict.strictEqual(missing.skipped, 2);
  });

  await it("uses normalized database identity when semantic types are unavailable", async () => {
    const value = fixture();
    const candidate = {
      ...value.candidates[0]!,
      columns: value.candidates[0]!.columns.map((field) => ({ ...field, tsType: "unknown" })),
      parameters: value.candidates[0]!.parameters.map((field) => ({ ...field, tsType: "unknown" })),
    };
    const equal = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: [candidate],
      verifier: verifier({
        async verify() {
          return {
            columns: [
              { index: 1, databaseType: " BIGINT " },
              { index: 2, databaseType: "TEXT" },
            ],
            parameters: [{ index: 1, databaseType: "BIGINT" }],
          };
        },
      }),
    });
    strict.strictEqual(equal.verified, 1);

    const mismatch = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: [candidate],
      verifier: verifier({
        async verify() {
          return {
            columns: [
              { index: 1, databaseType: "integer" },
              { index: 2, databaseType: "text" },
            ],
            parameters: [{ index: 1, databaseType: "bigint" }],
          };
        },
      }),
    });
    const entry = mismatch.proof.entries.find((item) => item.status === "mismatch");
    if (entry?.status !== "mismatch") strict.fail("Expected database type mismatch");
    strict.ok(entry.mismatches.some((item) => item.kind === "database-type"));
  });

  await it("deeply validates proof artifacts and every discriminated entry", async () => {
    const value = fixture();
    const result = await verifyQueryManifest({
      manifest: value.manifest,
      candidates: value.candidates,
      verifier: verifier(),
    });
    const valid = JSON.parse(serializeQueryVerificationProof(result.proof)) as Record<string, unknown>;
    const asRecord = (item: unknown) => item as Record<string, unknown>;
    const asArray = (item: unknown) => item as unknown[];
    const firstEntry = (proof: Record<string, unknown>) => asRecord(asArray(proof.entries)[0]);
    const firstColumn = (proof: Record<string, unknown>) =>
      asRecord(asArray(asRecord(firstEntry(proof).evidence).columns)[0]);
    const invalid = (mutate: (proof: Record<string, unknown>) => void, pattern: RegExp) => {
      const proof = structuredClone(valid);
      mutate(proof);
      strict.throws(() => parseQueryVerificationProof(proof), pattern);
    };

    invalid((proof) => {
      proof.verifierVersion = "future";
    }, /verifier version/u);
    invalid((proof) => {
      proof.adapterVersion = "";
    }, /adapterVersion/u);
    invalid((proof) => {
      proof.manifestHash = "nope";
    }, /fingerprint/u);
    invalid((proof) => {
      proof.schemaFormat = 3;
    }, /schemaFormat/u);
    invalid((proof) => {
      proof.schemaHash = 1;
    }, /schemaHash/u);
    invalid((proof) => {
      proof.schemaHash = "invalid";
    }, /schemaHash/u);
    invalid((proof) => {
      asRecord(proof.server).features = [1];
    }, /server or entries/u);
    invalid((proof) => {
      asRecord(firstEntry(proof).source).file = "../private.ts";
    }, /relative file/u);
    invalid((proof) => {
      asRecord(asRecord(firstEntry(proof).source).range).line = 1.5;
    }, /range/u);
    invalid((proof) => {
      firstEntry(proof).variantFingerprint = undefined;
    }, /requires a variant/u);
    invalid((proof) => {
      asRecord(firstEntry(proof).evidence).columns = {};
    }, /must be an array/u);
    invalid((proof) => {
      firstColumn(proof).index = 0;
    }, /invalid field/u);
    invalid((proof) => {
      firstColumn(proof).name = 1;
    }, /invalid name/u);
    invalid((proof) => {
      firstColumn(proof).nullable = "yes";
    }, /nullability/u);
    invalid((proof) => {
      firstEntry(proof).status = "other";
    }, /invalid entry/u);

    const mismatch = structuredClone(valid);
    asArray(mismatch.entries)[0] = {
      ...firstEntry(mismatch),
      status: "mismatch",
      code: "TSQ500",
      mismatches: [{ kind: "database-type", target: "column", index: 1, expected: "bigint", actual: "text" }],
    };
    strict.doesNotThrow(() => parseQueryVerificationProof(mismatch));
    invalid((proof) => {
      asArray(proof.entries)[0] = {
        ...firstEntry(mismatch),
        mismatches: [{ kind: "other", target: "column", expected: "a", actual: "b" }],
      };
    }, /mismatch evidence/u);

    const skipped = structuredClone(valid);
    asArray(skipped.entries)[0] = {
      ...firstEntry(skipped),
      status: "skipped",
      code: "TSQ501",
      reason: "candidate-missing",
    };
    strict.doesNotThrow(() => parseQueryVerificationProof(skipped));
    invalid((proof) => {
      asArray(proof.entries)[0] = { ...firstEntry(skipped), reason: "other" };
    }, /skip/u);

    const failed = structuredClone(valid);
    asArray(failed.entries)[0] = {
      ...firstEntry(failed),
      status: "error",
      code: "TSQ502",
      reason: "native-verification-failed",
    };
    strict.doesNotThrow(() => parseQueryVerificationProof(failed));
    invalid((proof) => {
      asArray(proof.entries)[0] = { ...firstEntry(failed), code: "TSQ500" };
    }, /failure/u);

    strict.throws(
      () => assertQueryVerificationProofCurrent(value.manifest, { ...result.proof, dialect: "mysql" }),
      /dialect/u,
    );
    strict.throws(
      () =>
        assertQueryVerificationProofCurrent(value.manifest, result.proof, {
          dialect: "postgres",
          adapterVersion: "v2",
        }),
      /adapter/u,
    );
    strict.throws(
      () =>
        assertQueryVerificationProofCurrent(value.manifest, { ...result.proof, cacheKey: `sha256:${"0".repeat(64)}` }),
      /cache key/u,
    );
    const tampered = structuredClone(result.proof);
    const first = tampered.entries[0];
    if (first?.status !== "verified") strict.fail("Expected verified proof entry");
    const edited = {
      ...tampered,
      entries: [{ ...first, evidence: { ...first.evidence, columns: [] } }, ...tampered.entries.slice(1)],
    };
    strict.throws(() => assertQueryVerificationProofCurrent(value.manifest, edited), /cache key/u);
  });
});

void (schema satisfies SchemaSnapshot);
