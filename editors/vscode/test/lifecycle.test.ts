import { describe, it, strict } from "poku";
import { LifecycleQueue } from "../src/lifecycle.js";

await describe("editor client lifecycle serialization", async () => {
  await it("orders overlapping starts and recovers after a failed operation", async () => {
    const queue = new LifecycleQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      events.push("start");
      await gate;
      events.push("ready");
    });
    const second = queue.run(async () => {
      events.push("restart");
    });
    await Promise.resolve();
    strict.deepStrictEqual(events, ["start"]);
    release();
    await Promise.all([first, second]);
    strict.deepStrictEqual(events, ["start", "ready", "restart"]);
    await strict.rejects(
      queue.run(async () => {
        throw new Error("failed");
      }),
      /failed/,
    );
    await queue.run(async () => {
      events.push("recovered");
    });
    strict.strictEqual(events.at(-1), "recovered");
  });
  await it("waits for in-flight startup, skips queued work and closes once", async () => {
    const queue = new LifecycleQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      events.push("start");
      await gate;
      events.push("ready");
    });
    await Promise.resolve();
    const pending = queue.run(async () => {
      events.push("unwanted restart");
    });
    const closed = queue.close(async () => {
      events.push("stop");
    });
    strict.strictEqual(
      queue.close(async () => {
        events.push("duplicate stop");
      }),
      closed,
    );
    release();
    await Promise.all([first, pending, closed]);
    await queue.run(async () => {
      events.push("late start");
    });
    strict.deepStrictEqual(events, ["start", "ready", "stop"]);
  });
});
