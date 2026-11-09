import { diagnosticRegistry } from "@typed-sql/core";
import type { Diagnostic, Range } from "vscode-languageserver/node";
import { UriMap } from "./uri-map.js";

export interface NativeAnalysisProgress {
  readonly uri: string;
  readonly version: number;
  readonly sourceHash: string;
  readonly request: number;
  readonly pending: boolean;
  /** Preparation returned a view; this does not certify native acceptance or every facet. */
  readonly completed: boolean;
  readonly ranges: readonly Range[];
}
interface Pending {
  readonly owner: object;
  readonly event: NativeAnalysisProgress;
  readonly requests: Map<number, readonly Range[]>;
  cancel(): void;
  visible: boolean;
  completed: boolean;
  report?: string;
}

/** Informational UI state, never a source of types or native qualification. */
export class NativePendingDiagnostics {
  readonly #entries = new UriMap<Pending>();
  readonly #waiters = new UriMap<Set<() => void>>();
  constructor(
    readonly options: {
      isCurrent(owner: object, event: NativeAnalysisProgress): boolean;
      publish(uri: string, version: number, diagnostics: readonly Diagnostic[], completed: boolean): void;
      after?(notify: () => void): () => void;
    },
  ) {}

  update(owner: object, event: NativeAnalysisProgress): void {
    let entry = this.#entries.get(event.uri);
    if (!event.pending) {
      if (!entry || entry.owner !== owner || !entry.requests.delete(event.request)) return;
      entry.completed ||= event.completed;
      if (entry.requests.size) {
        this.#show(event.uri, entry);
        return;
      }
      entry.cancel();
      this.#entries.delete(event.uri);
      if (entry.visible) this.#publish(event.uri, event.version, [], entry.completed);
      return;
    }
    if (!this.options.isCurrent(owner, event)) return;
    if (
      !entry ||
      entry.owner !== owner ||
      entry.event.version !== event.version ||
      entry.event.sourceHash !== event.sourceHash
    ) {
      entry?.cancel();
      const next: Pending = {
        owner,
        event,
        requests: new Map([[event.request, event.ranges]]),
        cancel: () => {},
        visible: false,
        completed: false,
      };
      this.#entries.set(event.uri, next);
      const notify = () => {
        if (this.#entries.get(event.uri) !== next || !this.options.isCurrent(owner, event)) return;
        next.visible = true;
        this.#show(event.uri, next);
        for (const wake of this.#waiters.get(event.uri) ?? []) wake();
      };
      next.cancel = this.options.after
        ? this.options.after(notify)
        : (() => {
            const timer = setTimeout(notify, 100);
            timer.unref();
            return () => clearTimeout(timer);
          })();
      entry = next;
    }
    entry.requests.set(event.request, event.ranges);
    this.#show(event.uri, entry);
  }

  #show(uri: string, entry: Pending): void {
    const diagnostics = this.diagnostics(uri);
    if (!diagnostics.length) return;
    const report = JSON.stringify(diagnostics);
    if (entry.report === report) return;
    entry.report = report;
    this.#publish(uri, entry.event.version, diagnostics, false);
  }

  #publish(uri: string, version: number, diagnostics: readonly Diagnostic[], completed: boolean): void {
    try {
      this.options.publish(uri, version, diagnostics, completed);
    } catch {
      /* A closed UI transport cannot poison acquisition. */
    }
  }

  diagnostics(uri: string): readonly Diagnostic[] {
    const entry = this.#entries.get(uri);
    if (!entry?.visible || !this.options.isCurrent(entry.owner, entry.event)) return [];
    const ranges = new Map([...entry.requests.values()].flat().map((range) => [JSON.stringify(range), range]));
    return [...ranges.values()].map((range) => ({
      range,
      code: "TSQ409",
      severity: 3,
      source: "typed-sql",
      message: `${diagnosticRegistry.TSQ409.summary} Results become available when qualification finishes.`,
    }));
  }

  /** Also wakes an initial diagnostic pull that began before native preparation was visible. */
  async wait(uri: string, work: () => Promise<void>): Promise<void> {
    if (this.diagnostics(uri).length) return;
    let wake!: () => void;
    const pending = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const waiters = this.#waiters.get(uri) ?? new Set();
    this.#waiters.set(uri, waiters);
    waiters.add(wake);
    const running = Promise.resolve().then(work);
    try {
      await Promise.race([running, pending]);
      if (!this.diagnostics(uri).length) await running;
    } finally {
      waiters.delete(wake);
      if (!waiters.size) this.#waiters.delete(uri);
    }
  }

  forget(uri: string): void {
    this.#entries.get(uri)?.cancel();
    this.#entries.delete(uri);
  }
}
