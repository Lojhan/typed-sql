import assert from "node:assert/strict";
import { sourceFor } from "./cases.mjs";
import { applySourceEdits, assertSqlPreserved } from "./edit-matrix.mjs";

async function eventually(check) {
  const deadline = Date.now() + 25_000;
  let last;
  do {
    try {
      return await check();
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw last;
}

export async function runExtendedScenario(spec, host, record, recordEdit) {
  const source = sourceFor(spec);
  const check = async (name, operation) => {
    try {
      await host.reset(source);
      await operation();
      record(name, "passed");
    } catch (error) {
      record(name, "failed", String(error.stack ?? error));
    }
  };
  const editCheck = async (name, operation) => {
    try {
      await operation();
      recordEdit(name, "passed");
    } catch (error) {
      recordEdit(name, "failed", String(error.stack ?? error));
      throw error;
    }
  };
  const row = (variant = spec.initial) => host.hover(`return row.${variant.member}`, "return row.".length);
  const inferred = async (variant = spec.initial) => {
    const hover = await row(variant);
    assert.ok(hover.includes(variant.member), hover);
    for (const type of variant.type.split(" | ")) assert.match(hover, new RegExp(`\\b${type}\\b`));
    assert.doesNotMatch(hover, /\b(any|unknown)\b/);
  };
  const apply = async (edits, before, expected) => {
    assert.ok(
      Object.values(edits).some((items) => items.length > 0),
      "provider must return meaningful edits",
    );
    const after = applySourceEdits(before, edits);
    for (const [uri, text] of Object.entries(before)) assertSqlPreserved(text, after[uri], spec.initial.query);
    if (expected !== undefined) assert.deepEqual(after, expected);
    await host.apply(edits, before, after);
    return after;
  };

  await check("sql-hover", async () => {
    await eventually(async () => {
      const hover = await host.hover(spec.initial.query, "SELECT ".length);
      assert.match(hover, /typed-sql|Query|inferred/i);
      assert.ok(hover.includes(spec.initial.member), hover);
      assert.doesNotMatch(hover, /\bany\b/);
    });
  });
  await check("sql-completion", async () => {
    await eventually(async () => {
      const labels = await host.completions(spec.initial.query, "SELECT ".length);
      for (const label of spec.initial.completions) assert.ok(labels.includes(label), JSON.stringify(labels));
    });
  });
  await check("parameter-inference", async () => {
    const parameterSource = `import { sql } from ${JSON.stringify(spec.packageName)};\nimport type { QueryParameters } from "@typed-sql/core";\nconst parameterQuery = sql\`${spec.parameters.query}\`;\ndeclare const inferredParameters: QueryParameters<typeof parameterQuery>;\nvoid inferredParameters;\n`;
    await host.reset(parameterSource);
    await eventually(async () => {
      const hover = await host.hover("void inferredParameters", "void ".length);
      const compact = hover.replace(/\s+/g, " ");
      assert.ok(compact.includes(`[${spec.parameters.tuple.join(", ")}]`), hover);
      assert.doesNotMatch(hover, /\b(any|unknown)\b/);
    });
  });
  await check("references", async () => {
    const texts = await host.crossFile(source);
    const references = await host.references("sharedValue");
    const observed = references.map(({ uri, range }) => ({ uri, range }));
    assert.deepEqual(
      observed.sort(host.locationOrder),
      host.occurrences(texts, "sharedValue").sort(host.locationOrder),
    );
  });
  await check("rename", async () => {
    const failures = [];
    for (const [id, symbol, replacement, setup] of [
      [
        "rename-local",
        "ordinary",
        "renamedOrdinary",
        async () => {
          await host.reset(source);
          return host.sources();
        },
      ],
      ["rename-cross-file", "sharedValue", "renamedShared", () => host.crossFile(source)],
    ]) {
      try {
        await editCheck(id, async () => {
          const before = await setup();
          const edits = await host.rename(symbol, replacement);
          const expected = Object.fromEntries(
            Object.entries(before).map(([uri, text]) => [
              uri,
              text.replace(new RegExp(`\\b${symbol}\\b`, "g"), replacement),
            ]),
          );
          await apply(edits, before, expected);
          await eventually(() => inferred());
        });
      } catch (error) {
        failures.push(String(error));
      }
    }
    assert.deepEqual(failures, []);
  });
  await check("formatting", async () => {
    const failures = [];
    for (const ranged of [false, true]) {
      try {
        await editCheck(ranged ? "format-range" : "format-document", async () => {
          await host.reset(`${source}\nexport const unformatted={answer:1};void unformatted.answer;\n`);
          const before = await host.sources();
          const edits = await host.format(ranged);
          const after = await apply(edits, before);
          assert.notDeepEqual(after, before, "formatter must change the unformatted fixture");
          if (ranged)
            for (const [uri, text] of Object.entries(before))
              assert.equal(after[uri].slice(0, source.length), text.slice(0, source.length));
          assert.deepEqual(applySourceEdits(after, await host.format(ranged)), after, "formatting must be idempotent");
          await eventually(() => inferred());
        });
      } catch (error) {
        failures.push(String(error));
      }
    }
    assert.deepEqual(failures, []);
  });
  await check("code-actions", () =>
    editCheck("quick-fix", async () => {
      const broken = `import { sql } from ${JSON.stringify(spec.packageName)};\ndeclare const selected: boolean;\nconst query = sql\`${spec.structural}\`;\n`;
      await host.reset(broken);
      const action = await eventually(async () => {
        const actions = await host.codeActions();
        const fix = actions.find((item) => item.title === "Mark as sql.fragment");
        assert.ok(fix?.edits, JSON.stringify(actions));
        return fix;
      });
      const before = await host.sources();
      const after = applySourceEdits(before, action.edits);
      assert.deepEqual(
        after,
        Object.fromEntries(Object.entries(before).map(([uri, text]) => [uri, text.replace("? `", "? sql.fragment`")])),
      );
      await host.apply(action.edits, before, after);
      await eventually(async () =>
        assert.ok(
          !(await host.diagnostics()).some((item) => item.code === "TSQ004"),
          "structural quick fix must clear TSQ004",
        ),
      );
    }),
  );
  await check("semantic-tokens", async () => {
    await eventually(async () => {
      for (const ranged of [false, true]) {
        const tokens = await host.semanticTokens(ranged);
        assert.ok(tokens.length > 0, "semantic token provider must return source tokens");
        assert.ok(
          tokens.some((item) => item.text === "ordinary"),
          JSON.stringify(tokens),
        );
        for (const item of tokens)
          assert.ok(item.text.length === item.length && item.length > 0, "token must fit its original source line");
      }
    });
  });
  await check("tsx", async () => {
    await host.openTsx(
      `${source}\ndeclare global { namespace JSX { interface IntrinsicElements { panel: { count: number } } } }\nconst view = <panel count={ordinary.count} />; void view;\n`,
    );
    await eventually(() => inferred());
    assert.match(await host.hover("count={ordinary.count}", "count={ordinary.".length), /number/);
    assert.ok(!(await host.diagnostics()).some((item) => /Cannot use JSX|JSX element implicitly/.test(item.message)));
  });
  await check("restart-recovery", async () => {
    await host.reset(sourceFor(spec, spec.changed));
    await eventually(() => inferred(spec.changed));
    await host.restart();
    await eventually(() => inferred(spec.changed));
    await eventually(async () =>
      assert.ok((await host.diagnostics()).some((item) => item.line === 6 && /not assignable/.test(item.message))),
    );
  });
  await check("multi-root", async () => {
    await host.multiRoot(async (other) => {
      await eventually(() => inferred());
      await eventually(async () => {
        const hover = await other.hover();
        assert.ok(hover.includes(other.member), hover);
        assert.match(hover, new RegExp(`\\b${other.type}\\b`));
        assert.doesNotMatch(hover, /\b(any|unknown)\b/);
      });
    });
    await eventually(() => inferred());
  });
  await check("packed-server-install", async () => {
    await host.verifyPacked();
    await eventually(() => inferred());
  });
}
