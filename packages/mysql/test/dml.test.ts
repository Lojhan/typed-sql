import { describe, it, strict } from "poku";
import { type SchemaSnapshot, upgradeSchemaSnapshotV1 } from "../../schema/src/index.js";
import { parseStatement } from "../src/parser/index.js";
import { resolveMySqlStatement } from "../src/resolver.js";
import { analyzeMySqlSemantics } from "../src/semantics.js";

const schema = {
  formatVersion: 1,
  dialect: "mysql",
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "bigint unsigned", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "varchar(255)", tsType: "string", nullable: false },
        status: {
          name: "status",
          databaseType: "enum('active','suspended')",
          tsType: '"active" | "suspended"',
          nullable: false,
        },
        generated_slug: {
          name: "generated_slug",
          databaseType: "varchar(255)",
          tsType: "string",
          nullable: false,
        },
      },
    },
    projects: {
      name: "projects",
      columns: {
        id: { name: "id", databaseType: "int", tsType: "number", nullable: false },
        owner_id: { name: "owner_id", databaseType: "bigint unsigned", tsType: "bigint", nullable: false },
        budget: { name: "budget", databaseType: "decimal(14,2)", tsType: "string", nullable: true },
      },
    },
  },
} as const satisfies SchemaSnapshot;

const structuralSchema = (() => {
  const upgraded = upgradeSchemaSnapshotV1(schema);
  const users = upgraded.relations.users!;
  return {
    ...upgraded,
    relations: {
      ...upgraded.relations,
      users: {
        ...users,
        columns: {
          ...users.columns,
          id: { ...users.columns.id!, default: "present", identity: "always", insertable: false },
          email: { ...users.columns.email!, default: "none", insertable: true, updatable: true },
          status: { ...users.columns.status!, default: "none", insertable: true, updatable: true },
          generated_slug: {
            ...users.columns.generated_slug!,
            default: "present",
            generated: "stored",
            insertable: false,
            updatable: false,
          },
        },
      },
    },
  } as const satisfies SchemaSnapshot;
})();

const resolve = (source: string, selectedSchema: SchemaSnapshot = schema) =>
  resolveMySqlStatement(parseStatement(source), selectedSchema);

const errors = (source: string, selectedSchema: SchemaSnapshot = schema) =>
  resolve(source, selectedSchema).diagnostics.filter(({ severity }) => severity === "error");

await describe("MySQL data-modification grammar", async () => {
  await it("parses INSERT modifiers, partitions, SET, row aliases, duplicate-key updates, and REPLACE", () => {
    const insert = parseStatement(`
      INSERT HIGH_PRIORITY IGNORE INTO users PARTITION (p0, p1) (email, status)
      VALUES (?, ?) AS incoming(mail, state)
      ON DUPLICATE KEY UPDATE email = incoming.mail, status = state
    `);
    strict.strictEqual(insert.kind, "insert");
    if (insert.kind !== "insert") return;
    strict.strictEqual(insert.operation, "insert");
    strict.strictEqual(insert.priority, "high");
    strict.strictEqual(insert.ignore, true);
    strict.deepStrictEqual(
      insert.table.partitions?.map(({ name }) => name),
      ["p0", "p1"],
    );
    strict.strictEqual(insert.rowAlias?.name, "incoming");
    strict.deepStrictEqual(
      insert.columnAliases.map(({ name }) => name),
      ["mail", "state"],
    );
    strict.strictEqual(insert.duplicateKey.length, 2);

    const replace = parseStatement("REPLACE LOW_PRIORITY INTO users SET email = ?, status = ?");
    strict.strictEqual(replace.kind, "insert");
    if (replace.kind !== "insert") return;
    strict.strictEqual(replace.operation, "replace");
    strict.strictEqual(replace.source.kind, "set");
  });

  await it("types inserted-row aliases and duplicate-key parameters in textual order", () => {
    const result = resolve(`
      INSERT INTO users (email, status)
      VALUES (?, ?) AS incoming(mail, state)
      ON DUPLICATE KEY UPDATE email = incoming.mail, status = ?
    `);
    strict.deepStrictEqual(
      errors(`
      INSERT INTO users (email, status)
      VALUES (?, ?) AS incoming(mail, state)
      ON DUPLICATE KEY UPDATE email = incoming.mail, status = ?
    `),
      [],
    );
    strict.deepStrictEqual(
      result.parameters.map(({ index, tsType, nullable }) => ({ index, tsType, nullable })),
      [
        { index: 1, tsType: "string", nullable: false },
        { index: 2, tsType: '"active" | "suspended"', nullable: false },
        { index: 3, tsType: '"active" | "suspended"', nullable: false },
      ],
    );
    const legacy = resolve(
      "INSERT INTO users (email, status) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email)",
    );
    strict.strictEqual(legacy.diagnostics.find(({ message }) => message.includes("deprecated"))?.severity, "warning");
    strict.ok(!errors("INSERT INTO users () VALUES ()").some(({ code }) => code === "TSQ214"));
    strict.ok(
      errors("INSERT INTO users (email, status) VALUES (status, 'active')").some(({ code }) => code === "TSQ228"),
    );
    strict.ok(
      !errors("INSERT INTO users (email, status) VALUES ('active', email)").some(({ code }) => code === "TSQ228"),
    );
    strict.deepStrictEqual(
      resolve("INSERT INTO users (email, status) SELECT ? AS email, ? AS status").parameters.map(
        ({ tsType }) => tsType,
      ),
      ["string", '"active" | "suspended"'],
    );
    strict.deepStrictEqual(
      resolve(
        "INSERT INTO users (email, status) WITH incoming AS (SELECT ? AS email, ? AS status) SELECT email, status FROM incoming",
      ).parameters.map(({ tsType }) => tsType),
      ["string", '"active" | "suspended"'],
    );
    strict.throws(
      () =>
        parseStatement(
          "WITH incoming AS (SELECT 'a' AS email, 'active' AS status) INSERT INTO users (email, status) SELECT email, status FROM incoming",
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "TSQ401",
    );
  });

  await it("uses v2 eligibility for INSERT, REPLACE, duplicate-key, and generated DEFAULT assignments", () => {
    strict.deepStrictEqual(
      errors("REPLACE INTO users (email, status, generated_slug) VALUES (?, ?, DEFAULT)", structuralSchema),
      [],
    );
    strict.deepStrictEqual(errors("UPDATE users SET generated_slug = DEFAULT WHERE id = ?", structuralSchema), []);
    strict.ok(
      errors("UPDATE users SET generated_slug = ? WHERE id = ?", structuralSchema).some(
        ({ code }) => code === "TSQ218",
      ),
    );
    strict.ok(
      errors(
        "INSERT INTO users (email, status) VALUES (?, ?) AS users ON DUPLICATE KEY UPDATE email = users.email",
      ).some(({ code }) => code === "TSQ224"),
    );
    strict.ok(
      errors(
        "INSERT INTO users (email, status) VALUES (?, ?) AS incoming(mail) ON DUPLICATE KEY UPDATE email = mail",
      ).some(({ code }) => code === "TSQ214"),
    );
    strict.ok(
      errors(
        "INSERT INTO users (email, status) VALUES (?, ?) AS incoming(mail, mail) ON DUPLICATE KEY UPDATE email = mail",
      ).some(({ code }) => code === "TSQ224"),
    );
    strict.throws(
      () => parseStatement("REPLACE HIGH_PRIORITY INTO users (email, status) VALUES (?, ?)"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "TSQ224",
    );
    strict.throws(
      () => parseStatement("INSERT DELAYED INTO users (email, status) SELECT email, status FROM users"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "TSQ224",
    );
    strict.throws(
      () =>
        parseStatement(
          "REPLACE INTO users (email, status) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email)",
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "TSQ224",
    );
    for (const source of [
      "INSERT INTO users (email) VALUES ROW(?) AS incoming ON DUPLICATE KEY UPDATE email = incoming.email",
      "INSERT INTO users (email) VALUES (?) AS incoming() ON DUPLICATE KEY UPDATE email = incoming.email",
      "INSERT INTO users (email) VALUES ROW(?), (?)",
    ]) {
      strict.throws(
        () => parseStatement(source),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "TSQ224",
      );
    }
    const delayed = resolve("REPLACE DELAYED INTO users SET email = ?, status = ?");
    strict.strictEqual(delayed.diagnostics.find(({ severity }) => severity === "warning")?.code, "TSQ401");
    strict.deepStrictEqual(
      delayed.parameters.map(({ tsType }) => tsType),
      ["string", '"active" | "suspended"'],
    );
    strict.ok(
      errors(
        "INSERT INTO users (email, status) VALUES (?, ?) ON DUPLICATE KEY UPDATE generated_slug = ?",
        structuralSchema,
      ).some(({ code }) => code === "TSQ218"),
    );
  });

  await it("resolves joined UPDATE targets and preserves ON, SET, WHERE parameter order", () => {
    const source = `
      UPDATE LOW_PRIORITY IGNORE users u
      JOIN projects p ON p.owner_id = ?
      SET u.status = ?, p.budget = ?
      WHERE u.id = ?
    `;
    const result = resolve(source);
    strict.deepStrictEqual(result.diagnostics, []);
    strict.deepStrictEqual(
      result.parameters.map(({ index, tsType, nullable }) => ({ index, tsType, nullable })),
      [
        { index: 1, tsType: "bigint", nullable: false },
        { index: 2, tsType: '"active" | "suspended"', nullable: false },
        { index: 3, tsType: "string", nullable: true },
        { index: 4, tsType: "bigint", nullable: false },
      ],
    );
    strict.ok(
      errors("UPDATE users u JOIN projects p ON p.owner_id = u.id SET u.status = 'active' ORDER BY u.id LIMIT 1").some(
        ({ code }) => code === "TSQ401",
      ),
    );
    strict.ok(errors("UPDATE users u, projects p SET id = 1").some(({ code }) => code === "TSQ102"));
  });

  await it("resolves both multi-table DELETE forms and restricts their targets and tails", () => {
    const first = parseStatement(
      "DELETE LOW_PRIORITY QUICK IGNORE u, p.* FROM users u JOIN projects p ON p.owner_id = u.id WHERE p.id = ?",
    );
    strict.strictEqual(first.kind, "delete");
    if (first.kind !== "delete") return;
    strict.strictEqual(first.multiTable, true);
    strict.deepStrictEqual(
      first.targets.map(({ name }) => name),
      ["u", "p"],
    );
    strict.deepStrictEqual(resolveMySqlStatement(first, schema).diagnostics, []);

    const second = resolve("DELETE FROM u USING users u JOIN projects p ON p.owner_id = u.id WHERE p.id = ?");
    strict.deepStrictEqual(second.diagnostics, []);
    strict.strictEqual(second.parameters[0]?.tsType, "number");
    strict.ok(
      errors("DELETE missing FROM users u JOIN projects p ON p.owner_id = u.id").some(({ code }) => code === "TSQ103"),
    );
    strict.ok(
      errors("DELETE u FROM users u JOIN projects p ON p.owner_id = u.id ORDER BY u.id LIMIT 1").some(
        ({ code }) => code === "TSQ401",
      ),
    );
  });

  await it("keeps single-table UPDATE and DELETE ordering and limits typed", () => {
    const update = resolve("UPDATE users SET status = ? WHERE id = ? ORDER BY email LIMIT ?");
    strict.deepStrictEqual(
      update.parameters.map(({ tsType }) => tsType),
      ['"active" | "suspended"', "bigint", "number"],
    );
    const deletion = resolve("DELETE FROM users WHERE status = ? ORDER BY id LIMIT ?");
    strict.deepStrictEqual(
      deletion.parameters.map(({ tsType }) => tsType),
      ['"active" | "suspended"', "number"],
    );
    const partitioned = parseStatement("DELETE FROM users AS doomed PARTITION (p0) WHERE doomed.id = ?");
    strict.strictEqual(partitioned.kind, "delete");
    if (partitioned.kind === "delete" && partitioned.table.kind === "table") {
      strict.deepStrictEqual(
        partitioned.table.partitions?.map(({ name }) => name),
        ["p0"],
      );
    }
  });

  await it("publishes write dependencies for duplicate-key, REPLACE, and all multi-table targets", () => {
    const update = parseStatement(
      "UPDATE users u JOIN projects p ON p.owner_id = u.id SET u.status = 'active', p.budget = 0",
    );
    const updateDependencies = analyzeMySqlSemantics(update, schema).dependencies;
    strict.deepStrictEqual(
      updateDependencies
        .filter(({ kind, access }) => kind === "relation" && access === "write")
        .map(({ name }) => name),
      ["projects", "users"],
    );
    const deletion = parseStatement("DELETE u, p FROM users u JOIN projects p ON p.owner_id = u.id");
    strict.deepStrictEqual(
      analyzeMySqlSemantics(deletion, schema)
        .dependencies.filter(({ kind, access }) => kind === "relation" && access === "write")
        .map(({ name }) => name),
      ["projects", "users"],
    );
    strict.ok(
      analyzeMySqlSemantics(
        parseStatement("REPLACE INTO users (email, status) VALUES (?, ?)"),
        schema,
      ).capabilities.includes("replace"),
    );
  });
});
