import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { type NativeAnalysisProgress, NativePendingDiagnostics } from "../src/native-progress.js";

const uri = pathToFileURL(resolve("query.ts")).href;
const range = { start: { line: 2, character: 5 }, end: { line: 2, character: 24 } };
const event = (request: number, pending = true, version = 1): NativeAnalysisProgress => ({
  uri,
  version,
  request,
  pending,
  completed: !pending,
  sourceHash: `source-${version}`,
  ranges: [range],
});
await describe("native pending diagnostics", async () => {
  await it("clears cancelled progress without claiming a completed prepared view", () => {
    let tick!: () => void;
    const reports: boolean[] = [];
    const owner = {};
    const controller = new NativePendingDiagnostics({
      isCurrent: () => true,
      after: (notify) => {
        tick = notify;
        return () => {};
      },
      publish: (_uri, _version, _diagnostics, completed) => {
        reports.push(completed);
      },
    });
    controller.update(owner, event(1));
    tick();
    controller.update(owner, { ...event(1, false), completed: false });
    strict.deepEqual(reports, [false, false]);
    strict.deepEqual(controller.diagnostics(uri), []);
  });
  await it("contains a closed diagnostic transport without retaining completed progress", () => {
    let tick!: () => void;
    const owner = {};
    const controller = new NativePendingDiagnostics({
      isCurrent: () => true,
      after: (notify) => {
        tick = notify;
        return () => {};
      },
      publish: () => {
        throw new Error("closed transport");
      },
    });
    controller.update(owner, event(1));
    strict.doesNotThrow(() => tick());
    strict.doesNotThrow(() => controller.update(owner, event(1, false)));
    strict.deepEqual(controller.diagnostics(uri), []);
  });
  await it("coalesces shared work, wakes an initial pull and clears only after the last subscriber settles", async () => {
    const owner = {};
    const timers = new Set<() => void>();
    const reports: { version: number; codes: (string | number | undefined)[] }[] = [];
    const controller = new NativePendingDiagnostics({
      isCurrent: () => true,
      after: (notify) => {
        timers.add(notify);
        return () => {
          timers.delete(notify);
        };
      },
      publish: (_uri, version, diagnostics) =>
        reports.push({ version, codes: diagnostics.map((diagnostic) => diagnostic.code) }),
    });
    let finish!: () => void,
      completed = false;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pull = controller.wait(uri, async () => {
      await work;
      completed = true;
    });
    controller.update(owner, event(1));
    controller.update(owner, event(2));
    strict.deepEqual(reports, []);
    for (const tick of [...timers]) tick();
    await pull;
    strict.equal(completed, false, "The diagnostic is visible before native work finishes");
    strict.deepEqual(controller.diagnostics(uri)[0]!.range, range);
    strict.equal(controller.diagnostics(uri)[0]!.severity, 3);
    strict.deepEqual(reports, [{ version: 1, codes: ["TSQ409"] }]);
    controller.update(owner, event(1, false));
    strict.equal(reports.length, 1, "A remaining subscriber still needs the shared work");
    controller.update(owner, event(2, false));
    strict.deepEqual(reports.at(-1)!.codes, []);
    strict.deepEqual(controller.diagnostics(uri), []);
    finish();
    await work;
  });
  await it("suppresses short requests, late timers and obsolete document/service completions", async () => {
    let version = 1;
    const owner = {},
      other = {};
    let selected = owner;
    const timers: (() => void)[] = [];
    const reports: number[] = [];
    const controller = new NativePendingDiagnostics({
      isCurrent: (current, value) => current === selected && value.version === version,
      after: (notify) => {
        timers.push(notify);
        return () => {};
      },
      publish: (_uri, value, diagnostics) => {
        if (diagnostics.length) reports.push(value);
      },
    });
    controller.update(owner, event(1));
    controller.update(owner, event(1, false));
    timers[0]!();
    strict.deepEqual(reports, []);
    controller.update(owner, event(2));
    version = 2;
    controller.update(owner, event(3, true, 2));
    timers[1]!();
    strict.deepEqual(reports, []);
    timers[2]!();
    strict.deepEqual(reports, [2]);
    controller.update(owner, event(2, false));
    strict.equal(controller.diagnostics(uri).length, 1);
    selected = other;
    controller.update(other, event(1, true, 2));
    controller.update(owner, event(3, false, 2));
    timers[3]!();
    strict.equal(controller.diagnostics(uri).length, 1);
    controller.forget(uri);
    timers[3]!();
    strict.deepEqual(controller.diagnostics(uri), []);
    await strict.rejects(
      controller.wait(uri, () => {
        throw new Error("cancelled");
      }),
      /cancelled/u,
    );
    await controller.wait(uri, async () => {});
  });
});
