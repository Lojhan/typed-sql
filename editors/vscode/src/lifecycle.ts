/** Serializes ownership changes; shutdown waits for in-flight work and skips queued starts. */
export class LifecycleQueue {
  #tail: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;

  run(operation: () => Promise<void>): Promise<void> {
    if (this.#closing !== undefined) return Promise.resolve();
    const pending = this.#tail.then(async () => {
      if (this.#closing === undefined) await operation();
    });
    this.#tail = pending.catch(() => undefined);
    return pending;
  }

  close(cleanup: () => Promise<void>): Promise<void> {
    this.#closing ??= this.#tail.then(cleanup);
    return this.#closing;
  }
}
