import assert from "node:assert/strict";
import { interfaces, sourceFor } from "./cases.mjs";

async function eventually(label, check) {
  const deadline = Date.now() + 25_000;
  let last;
  do {
    try {
      return await check();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${last?.stack ?? last}`);
}

function assertType(hover, member, type) {
  assert.ok(hover.includes(member), hover);
  for (const part of type.split(" | ")) assert.match(hover, new RegExp(`\\b${part}\\b`));
  assert.doesNotMatch(hover, /\b(any|unknown)\b/);
}

// Host adapters supply observed editor values, not expected grammar semantics.
export async function runScenario(spec, host, record) {
  const check = async (id, run) => {
    assert.ok(interfaces.includes(id));
    try {
      await run();
      record(id, "passed");
    } catch (error) {
      record(id, "failed", String(error));
      throw error;
    }
  };
  const marker = (variant) => `return row.${variant.member}`;
  const memberOffset = "return row.".length;
  await check("row-hover", () =>
    eventually("row hover", async () =>
      assertType(await host.hover(marker(spec.initial), memberOffset), spec.initial.member, spec.initial.type),
    ),
  );
  await check("row-completion", () =>
    eventually("row completion", async () => {
      const labels = await host.completions(marker(spec.initial), memberOffset);
      for (const name of spec.initial.completions) assert.ok(labels.includes(name), JSON.stringify(labels));
    }),
  );
  await check("typescript-diagnostic", () =>
    eventually("TypeScript diagnostic", async () => {
      const errors = (await host.diagnostics()).filter((item) => item.error);
      assert.ok(
        errors.some((item) => item.line === 7 && /not assignable/.test(item.message)),
        JSON.stringify(errors),
      );
      assert.ok(!errors.some((item) => item.line === 6), JSON.stringify(errors));
    }),
  );
  await check("source-definition", async () =>
    assert.ok(
      (await host.definitions("void ordinary.count", "void ".length)).some(
        (item) => item.ownDocument && item.text === "ordinary",
      ),
      "definition after same-line overlay must locate original identifier",
    ),
  );
  await check("ordinary-hover", async () =>
    assert.match(await host.hover("ordinary.count", "ordinary.".length), /number/),
  );
  await check("schema-file-refresh", async () => {
    try {
      if (spec.schemaRefresh !== undefined) {
        const changed = structuredClone(spec.schema);
        changed.tables[spec.schemaRefresh.table].columns[spec.schemaRefresh.column].nullable = true;
        await host.writeSchema(changed);
        await eventually("schema nullability reaches hover", async () =>
          assertType(
            await host.hover(marker(spec.initial), memberOffset),
            spec.initial.member,
            spec.schemaRefresh.type,
          ),
        );
        await eventually("schema nullability reaches diagnostics", async () =>
          assert.ok(
            (await host.diagnostics()).some((item) => item.error && item.line === 6 && /null/.test(item.message)),
          ),
        );
      }
      // Every grammar validates its envelope, even if its semantics intentionally
      // do not use column metadata (the synthetic third-party fixture).
      await host.writeSchema({ ...spec.schema, dialectVersion: "0.0.0-incompatible" });
      await eventually("incompatible schema fails closed", async () => {
        const diagnostics = await host.diagnostics();
        assert.ok(
          diagnostics.some((item) => item.source === "typed-sql" && /analysis is unavailable/.test(item.message)),
          JSON.stringify(diagnostics),
        );
        const value = await host.hover(marker(spec.initial), memberOffset).catch(() => "");
        assert.ok(value.length === 0 || /\bunknown\b/.test(value), `must not retain stale inference: ${value}`);
      });
    } finally {
      await host.writeSchema(spec.schema);
    }
    await eventually("restored schema restores inference and clears stale errors", async () => {
      const value = await host.hover(marker(spec.initial), memberOffset);
      assertType(value, spec.initial.member, spec.initial.type);
      assert.doesNotMatch(value, /\bnull\b/);
      const errors = (await host.diagnostics()).filter((item) => item.error);
      assert.ok(
        !errors.some((item) => item.line === 6 || /analysis is unavailable/.test(item.message)),
        JSON.stringify(errors),
      );
      assert.ok(
        errors.some((item) => item.line === 7 && /not assignable/.test(item.message)),
        JSON.stringify(errors),
      );
    });
  });
  await check("unsaved-query-refresh", async () => {
    await host.replace(sourceFor(spec, spec.changed));
    await eventually("unsaved inference", async () =>
      assertType(await host.hover(marker(spec.changed), memberOffset), spec.changed.member, spec.changed.type),
    );
    await eventually("refreshed diagnostic", async () =>
      assert.ok(
        (await host.diagnostics()).some((item) => item.error && item.line === 6 && /not assignable/.test(item.message)),
      ),
    );
  });
  await check("sql-diagnostic", async () => {
    await host.replace(sourceFor(spec, { ...spec.changed, query: spec.invalidQuery }));
    await eventually("SQL diagnostic", async () =>
      assert.ok(
        (await host.diagnostics()).some(
          (item) => item.source === "typed-sql" && new RegExp(spec.diagnosticPattern).test(item.message),
        ),
      ),
    );
  });
}
