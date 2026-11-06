import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  closeCompletion,
  completionKeymap,
  snippet,
  startCompletion,
} from "@codemirror/autocomplete";
import { redo, redoDepth, selectAll, undo, undoDepth } from "@codemirror/commands";
import { type Diagnostic, lintGutter, lintKeymap, setDiagnostics } from "@codemirror/lint";
import { openSearchPanel } from "@codemirror/search";
import { EditorSelection, type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  activateHover,
  closeHoverTooltips,
  EditorView,
  hasHoverTooltips,
  hoverTooltip,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { token } from "./api.js";
import {
  canonicalWorkingCopies,
  completionItems,
  displayDocumentation,
  type LanguageCompletion,
  type LanguageDiagnostic,
  type LanguageEdit,
  type LanguageLocation,
  type LanguageRange,
  mergeDocumentDiagnostics,
  offsets,
  positionAt,
  textChanges,
  type WorkingCopy,
} from "./editor-language-model.js";

export type { LanguageDiagnostic, LanguageLocation, LanguageRange, WorkingCopy } from "./editor-language-model.js";
export interface EditorDiagnostic {
  code: string;
  message: string;
  severity: string;
  range: { line: number; column: number; start?: number; end?: number };
  source?: string;
  origin?: string;
  engine?: string;
  sourceRevision?: string;
}
export interface LanguageSettings {
  file: string;
  revision: string;
  readOnly: boolean;
  enabled: boolean;
  diagnostics: readonly EditorDiagnostic[];
  workingCopies: readonly WorkingCopy[];
  onNavigate?: (location: LanguageLocation) => void;
  onFormat?: () => void;
  onLanguageStatus?: (message: string) => void;
  onDiagnostics?: (source: string, diagnostics: readonly LanguageDiagnostic[]) => void;
}
interface InlineDiagnostic extends Diagnostic {
  code: string;
  origin: string;
  engine?: string;
  sourceRevision?: string;
}
interface LanguageResponse {
  file: string;
  uri?: string;
  revision: string;
  sourceHash: string;
  workingCopyHash: string;
  version: number;
  result: unknown;
  diagnostics: LanguageDiagnostic[];
  status: { state: "ready" | "unavailable" | "failed"; message?: string };
}
export type EditorLanguageCommand = "completion" | "definition" | "hover" | "codeAction";
const languageCommands = new WeakMap<EditorView, (command: EditorLanguageCommand) => void>();
export function runEditorLanguageCommand(view: EditorView, command: EditorLanguageCommand): boolean {
  const run = languageCommands.get(view);
  if (!run) return false;
  view.focus();
  run(command);
  return true;
}
interface CodeAction {
  title: string;
  disabled?: { reason: string };
  edit?: {
    changes?: Record<string, LanguageEdit[]>;
    documentChanges?: { textDocument?: { uri: string; version?: number | null }; edits?: LanguageEdit[] }[];
  };
  command?: unknown;
}
type LanguageRefresh = Pick<LanguageSettings, "revision" | "enabled"> & {
  diagnosticsKey: string;
  workingCopyKey: string;
};
const refresh = StateEffect.define<LanguageRefresh>();
export const refreshEditorLanguage = (settings: LanguageRefresh) => refresh.of(settings);
let dismissOpenMenu: (() => void) | undefined;
function documentation(value: unknown): HTMLElement {
  const container = document.createElement("div");
  container.className = "editor-language-documentation";
  const text = displayDocumentation(value);
  for (const block of text.split(/(```[^\n]*\n[\s\S]*?```)/gu)) {
    if (!block.trim()) continue;
    const code = /^```[^\n]*\n([\s\S]*?)```$/u.exec(block);
    const child = document.createElement(code ? "pre" : "div");
    if (code) child.textContent = code[1] ?? "";
    else {
      for (const part of block.split(/(\*\*[^*]+\*\*|`[^`]+`)/gu)) {
        if (part.startsWith("**") && part.endsWith("**")) {
          const strong = document.createElement("strong");
          strong.textContent = part.slice(2, -2);
          child.append(strong);
        } else if (part.startsWith("`") && part.endsWith("`")) {
          const inline = document.createElement("code");
          inline.textContent = part.slice(1, -1);
          child.append(inline);
        } else child.append(document.createTextNode(part));
      }
    }
    container.append(child);
  }
  return container;
}
const completionTypes: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "function",
  5: "property",
  6: "variable",
  7: "class",
  8: "interface",
  9: "namespace",
  10: "property",
  12: "text",
  13: "enum",
  14: "keyword",
  15: "text",
  17: "file",
  20: "enum",
  21: "constant",
  22: "class",
  25: "type",
};
async function hash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function languageExtensions(settings: () => LanguageSettings): Extension {
  const workingKey = () => JSON.stringify(canonicalWorkingCopies(settings().workingCopies, settings().file));
  const epoch = StateField.define<string>({
    create: () => `${settings().revision}:${settings().enabled}:${workingKey()}`,
    update: (current, transaction) => {
      const effect = transaction.effects.find((effect) => effect.is(refresh));
      return effect ? `${effect.value.revision}:${effect.value.enabled}:${effect.value.workingCopyKey}` : current;
    },
  });
  class LanguageView {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly requests = new Set<AbortController>();
    private disposed = false;
    private unavailable = false;
    private lastRevision = "";
    private lastEnabled = false;
    private lastWorkingKey = workingKey();
    private closeMenu: (() => void) | undefined;
    private serverDiagnostics: LanguageDiagnostic[] = [];
    private publishedSource = "";
    private publishedDiagnostics = "";
    private publish(source: string, diagnostics: LanguageDiagnostic[]) {
      const encoded = JSON.stringify(diagnostics);
      if (source === this.publishedSource && encoded === this.publishedDiagnostics) return;
      this.publishedSource = source;
      this.publishedDiagnostics = encoded;
      settings().onDiagnostics?.(source, diagnostics);
    }
    constructor(readonly view: EditorView) {
      languageCommands.set(view, (command) => {
        const pos = view.state.selection.main.head;
        if (command === "completion") startCompletion(view);
        else if (command === "definition") void this.definition(pos);
        else if (command === "codeAction") void this.actions(pos);
        else this.showType(pos);
      });
      this.schedule(50);
    }
    status(message: string) {
      settings().onLanguageStatus?.(message);
    }
    private schedule(delay = 350) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.diagnostics(), delay);
    }
    update(update: ViewUpdate) {
      const revision = settings().revision;
      const enabled = settings().enabled;
      const context = workingKey();
      if (context !== this.lastWorkingKey) {
        this.lastWorkingKey = context;
        this.unavailable = false;
        this.serverDiagnostics = [];
        this.publish(this.view.state.doc.toString(), []);
        this.closeMenu?.();
        for (const request of this.requests) request.abort();
        queueMicrotask(() => {
          if (this.disposed) return;
          closeCompletion(this.view);
          this.view.dispatch({ effects: closeHoverTooltips });
        });
      }
      if (revision !== this.lastRevision || enabled !== this.lastEnabled) {
        this.lastRevision = revision;
        this.lastEnabled = enabled;
        this.unavailable = false;
        if (!enabled) this.publish(this.view.state.doc.toString(), []);
      }
      if (update.docChanged) {
        this.serverDiagnostics = [];
        this.publish(update.state.doc.toString(), []);
        this.closeMenu?.();
        for (const request of this.requests) request.abort();
        this.schedule();
      } else if (update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refresh))))
        this.schedule(50);
    }
    destroy() {
      this.disposed = true;
      clearTimeout(this.timer);
      this.closeMenu?.();
      for (const request of this.requests) request.abort();
      this.requests.clear();
      languageCommands.delete(this.view);
    }
    private current(source: string, revision: string, context = workingKey()) {
      return (
        !this.disposed &&
        this.view.state.doc.toString() === source &&
        settings().revision === revision &&
        workingKey() === context
      );
    }
    async request(
      method: string,
      extra: Record<string, unknown> = {},
      explicit = false,
    ): Promise<LanguageResponse | undefined> {
      const current = settings();
      if (current.readOnly) {
        if (explicit)
          this.status(
            "This read-only definition is an inspection view. Open a project file to use editor language actions.",
          );
        return undefined;
      }
      if (!current.enabled) {
        if (explicit) this.status("Enable trusted project execution to start the project's editor language server.");
        return undefined;
      }
      if (!current.revision || (this.unavailable && !explicit)) return undefined;
      const source = this.view.state.doc.toString();
      const revision = current.revision;
      const workingCopies = canonicalWorkingCopies(current.workingCopies, current.file);
      const context = JSON.stringify(workingCopies);
      const body = JSON.stringify({ method, file: current.file, source, revision, workingCopies, ...extra });
      if (new TextEncoder().encode(body).byteLength > 1024 * 1024) {
        this.publish(source, []);
        this.status("Editor context exceeds 1 MiB. Save some working files before requesting more editor information.");
        return undefined;
      }
      const controller = new AbortController();
      this.requests.add(controller);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15000);
      try {
        const response = await fetch("/api/editor", {
          method: "POST",
          headers: { "x-typed-sql-session": token, "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
        const result = await response.json();
        if (!this.current(source, revision, context)) return undefined;
        if (!response.ok) {
          this.unavailable = response.status === 403 || response.status === 404 || response.status === 503;
          this.publish(source, []);
          if (explicit) this.status(result.error?.message ?? "Editor language service is unavailable.");
          return undefined;
        }
        const value = result as LanguageResponse;
        if (!value.status || typeof value.sourceHash !== "string") {
          if (explicit) this.status("The editor language service returned an unsupported protocol response.");
          return undefined;
        }
        if (
          value.file !== current.file ||
          value.revision !== revision ||
          value.sourceHash !== (await hash(source)) ||
          value.workingCopyHash !== (await hash(context)) ||
          !this.current(source, revision, context)
        )
          return undefined;
        this.unavailable = value.status.state !== "ready";
        if (value.status.state !== "ready") {
          this.publish(source, []);
          if (explicit) this.status(value.status.message ?? "Editor language service is unavailable.");
          return undefined;
        }
        this.serverDiagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
        this.publish(source, this.serverDiagnostics);
        this.status("");
        return value;
      } catch (error) {
        if (explicit && this.current(source, revision, context) && (!controller.signal.aborted || timedOut))
          this.status(
            timedOut
              ? "The editor language server did not respond within 15 seconds. Retry after it starts."
              : error instanceof Error
                ? error.message
                : "Editor request failed.",
          );
        return undefined;
      } finally {
        clearTimeout(timer);
        this.requests.delete(controller);
      }
    }
    private fallback(source: string, sourceHash: string): InlineDiagnostic[] {
      const result: InlineDiagnostic[] = [];
      for (const item of settings().diagnostics) {
        if (item.sourceRevision && item.sourceRevision !== sourceHash) continue;
        const range =
          Number.isInteger(item.range.start) &&
          Number.isInteger(item.range.end) &&
          item.range.start! >= 0 &&
          item.range.end! >= item.range.start! &&
          item.range.end! <= source.length
            ? { from: item.range.start!, to: item.range.end! }
            : offsets(source, {
                start: { line: item.range.line - 1, character: item.range.column - 1 },
                end: { line: item.range.line - 1, character: item.range.column - 1 },
              });
        if (range)
          result.push({
            ...range,
            message: item.message,
            code: item.code,
            origin: item.origin ?? "analysis",
            ...(item.engine ? { engine: item.engine } : {}),
            ...(item.sourceRevision ? { sourceRevision: item.sourceRevision } : {}),
            severity: item.severity === "warning" ? "warning" : item.severity === "info" ? "info" : "error",
            source: item.source ?? `${item.origin === "database" ? "database" : "typed-sql"} ${item.code}`,
          });
      }
      return result;
    }
    async diagnostics() {
      if (this.disposed) return;
      const source = this.view.state.doc.toString();
      const context = workingKey();
      const response = await this.request("diagnostics");
      if (this.disposed || this.view.state.doc.toString() !== source || workingKey() !== context) return;
      const diagnostics: InlineDiagnostic[] = response
        ? (response.diagnostics ?? []).flatMap((item) => {
            const range = offsets(source, item.range);
            return range && typeof item.message === "string"
              ? [
                  {
                    ...range,
                    severity:
                      item.severity === 2
                        ? ("warning" as const)
                        : item.severity === 3
                          ? ("info" as const)
                          : item.severity === 4
                            ? ("hint" as const)
                            : ("error" as const),
                    message: item.message,
                    code: String(item.code ?? ""),
                    origin: "language-server",
                    source: [item.source, item.code].filter((value) => value !== undefined).join(" ") || "typed-sql",
                  },
                ]
              : [];
          })
        : [];
      const displayedHash = await hash(source);
      if (this.disposed || this.view.state.doc.toString() !== source || workingKey() !== context) return;
      this.view.dispatch(
        setDiagnostics(
          this.view.state,
          mergeDocumentDiagnostics([...diagnostics, ...this.fallback(source, displayedHash)]),
        ),
      );
    }
    async hover(pos: number, explicit = false): Promise<{ contents: unknown; from: number; to: number } | undefined> {
      const source = this.view.state.doc.toString();
      const response = await this.request("hover", { position: positionAt(source, pos) }, explicit);
      if (!response?.result || typeof response.result !== "object" || !("contents" in response.result))
        return undefined;
      const result = response.result as { contents: unknown; range?: LanguageRange };
      const range = result.range ? offsets(source, result.range) : undefined;
      if (!displayDocumentation(result.contents)) return undefined;
      return { contents: result.contents, from: range?.from ?? pos, to: range?.to ?? pos };
    }
    showType(pos: number) {
      void this.hover(pos, true).then((value) => {
        if (value)
          activateHover(this.view, pos, 1, {
            until: (transaction) => transaction.docChanged || transaction.selection !== undefined,
          });
      });
    }
    async definition(pos: number) {
      const response = await this.request(
        "definition",
        { position: positionAt(this.view.state.doc.toString(), pos) },
        true,
      );
      if (!response) return;
      const values = Array.isArray(response.result) ? response.result : response.result ? [response.result] : [];
      const locations = values.filter((item): item is LanguageLocation =>
        Boolean(item && typeof item === "object" && ("file" in item || "token" in item) && "range" in item),
      );
      if (!locations.length) {
        this.status("No definition is available at this position.");
        return;
      }
      if (locations.length === 1) settings().onNavigate?.(locations[0]!);
      else
        this.menu(
          this.view.coordsAtPos(pos)?.left ?? 0,
          this.view.coordsAtPos(pos)?.bottom ?? 0,
          locations.map((location) => ({
            label: location.file ?? "Definition",
            run: () => settings().onNavigate?.(location),
          })),
        );
    }
    async completions(context: CompletionContext): Promise<CompletionResult | null> {
      const source = context.state.doc.toString();
      const projectContext = workingKey();
      const word = context.matchBefore(/[\p{L}\p{N}_$]*$/u);
      if (!context.explicit && !word?.text && !/[.\s]$/u.test(source.slice(0, context.pos))) return null;
      const response = await this.request(
        "completion",
        {
          position: positionAt(source, context.pos),
          context: {
            triggerKind: context.explicit ? 1 : 2,
            ...(source[context.pos - 1] === "." ? { triggerCharacter: "." } : {}),
          },
        },
        context.explicit,
      );
      if (!response || context.aborted || this.view.state.doc.toString() !== source) return null;
      const options = completionItems(response.result).map(
        (item): Completion => ({
          label: item.filterText ?? item.label,
          displayLabel: item.label,
          ...(item.detail ? { detail: item.detail } : {}),
          ...(item.sortText ? { sortText: item.sortText } : {}),
          type: completionTypes[item.kind ?? 1] ?? "text",
          info: async () => {
            const resolved = await this.request("completionResolve", { item });
            const data =
              resolved?.result && typeof resolved.result === "object"
                ? ({ ...item, ...resolved.result } as LanguageCompletion)
                : item;
            return documentation(data.documentation ?? data.detail ?? "");
          },
          apply: (view, completion, from, to) =>
            void this.applyCompletion(item, source, projectContext, view, completion, from, to),
        }),
      );
      return { from: word?.from ?? context.pos, to: context.pos, options, filter: true };
    }
    private async applyCompletion(
      item: LanguageCompletion,
      source: string,
      context: string,
      view: EditorView,
      completion: Completion,
      from: number,
      to: number,
    ) {
      if (workingKey() !== context) return;
      const response = await this.request("completionResolve", { item });
      if (this.disposed || view.state.doc.toString() !== source || workingKey() !== context) return;
      const value =
        response?.result && typeof response.result === "object"
          ? ({ ...item, ...response.result } as LanguageCompletion)
          : item;
      const edit = value.textEdit;
      const primary = edit ? offsets(source, "range" in edit ? edit.range : edit.replace) : { from, to };
      if (!primary) return;
      const insert = edit?.newText ?? value.insertText ?? value.label;
      const extras = textChanges(source, value.additionalTextEdits ?? []);
      if (
        !extras ||
        !textChanges(source, [
          ...(value.additionalTextEdits ?? []),
          { range: { start: positionAt(source, primary.from), end: positionAt(source, primary.to) }, newText: insert },
        ])
      ) {
        this.status("Completion edits overlap or no longer match this source.");
        return;
      }
      if (value.insertTextFormat === 2) {
        if (/\$[A-Za-z_]|\$\{[^\d}]/u.test(insert)) {
          this.status("This completion uses a snippet variable unsupported by this editor.");
          return;
        }
        const changes = view.state.changes(extras);
        if (extras.length) view.dispatch({ changes, userEvent: "input.complete" });
        snippet(insert)(view, completion, changes.mapPos(primary.from), changes.mapPos(primary.to));
      } else {
        const changes = view.state.changes([...extras, { ...primary, insert }]);
        view.dispatch({
          changes,
          selection: EditorSelection.cursor(changes.mapPos(primary.to, 1)),
          userEvent: "input.complete",
        });
      }
      view.focus();
      closeCompletion(view);
    }
    async actions(pos: number) {
      const source = this.view.state.doc.toString();
      const context = workingKey();
      const position = positionAt(source, pos);
      const response = await this.request(
        "codeAction",
        { range: { start: position, end: position }, context: { diagnostics: this.serverDiagnostics } },
        true,
      );
      if (!response) return;
      const actions = Array.isArray(response.result)
        ? response.result.filter((item): item is CodeAction =>
            Boolean(item && typeof item === "object" && typeof item.title === "string"),
          )
        : [];
      if (!actions.length) {
        this.status("No quick fixes are available at this position.");
        return;
      }
      const point = this.view.coordsAtPos(pos);
      this.menu(
        point?.left ?? 0,
        point?.bottom ?? 0,
        actions.map((action) => ({
          label: action.title,
          disabled:
            action.disabled?.reason ??
            (!action.edit || action.command
              ? "This action requires an unsupported language-server command."
              : undefined),
          run: () => {
            if (this.view.state.doc.toString() !== source || workingKey() !== context || !response.uri) return;
            const byUri = new Map(Object.entries(action.edit?.changes ?? {}));
            for (const change of action.edit?.documentChanges ?? []) {
              if (
                !change.textDocument ||
                !change.edits ||
                (typeof change.textDocument.version === "number" && change.textDocument.version !== response.version)
              ) {
                this.status("This action requires file operations. Review it in your project editor.");
                return;
              }
              byUri.set(change.textDocument.uri, [...(byUri.get(change.textDocument.uri) ?? []), ...change.edits]);
            }
            if ([...byUri.keys()].some((uri) => uri !== response.uri)) {
              this.status("This action changes multiple files. Review it in your project editor.");
              return;
            }
            const changes = textChanges(source, byUri.get(response.uri) ?? []);
            if (!changes) return;
            this.view.dispatch({ changes, userEvent: "input.codeAction" });
            this.view.focus();
          },
        })),
      );
    }
    menu(
      x: number,
      y: number,
      choices: { label: string; shortcut?: string; disabled?: string | undefined; run: () => void }[],
    ) {
      dismissOpenMenu?.();
      const menu = document.createElement("div");
      menu.className = "editor-context-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Editor actions");
      const close = () => {
        menu.remove();
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", keyboard, true);
        if (dismissOpenMenu === close) dismissOpenMenu = undefined;
        this.closeMenu = undefined;
      };
      const outside = (event: PointerEvent) => {
        if (!(event.target instanceof Node) || !menu.contains(event.target)) close();
      };
      const keyboard = (event: KeyboardEvent) => {
        const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          this.view.focus();
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[index]?.focus();
        } else if (event.key === "Tab") close();
      };
      for (const choice of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.disabled = Boolean(choice.disabled);
        if (choice.disabled) button.title = choice.disabled;
        const label = document.createElement("span");
        label.textContent = choice.label;
        button.append(label);
        if (choice.shortcut) {
          const shortcut = document.createElement("kbd");
          shortcut.textContent = choice.shortcut;
          button.append(shortcut);
        }
        button.addEventListener("click", () => {
          close();
          this.view.focus();
          choice.run();
        });
        menu.append(button);
      }
      document.body.append(menu);
      const box = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, innerHeight - box.height - 4))}px`;
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", keyboard, true);
      this.closeMenu = close;
      dismissOpenMenu = close;
      menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
    private async clipboard(action: "cut" | "paste") {
      if (settings().readOnly) return;
      const source = this.view.state.doc.toString();
      const selection = this.view.state.selection.main;
      try {
        const insert = action === "paste" ? await navigator.clipboard.readText() : "";
        if (action === "cut") await navigator.clipboard.writeText(source.slice(selection.from, selection.to));
        if (
          this.disposed ||
          this.view.state.doc.toString() !== source ||
          !this.view.state.selection.main.eq(selection)
        ) {
          this.status("The source or selection changed; no clipboard edit was applied.");
          return;
        }
        if (
          new TextEncoder().encode(source.slice(0, selection.from) + insert + source.slice(selection.to)).byteLength >
          512 * 1024
        ) {
          this.status("Clipboard content would exceed the 512 KiB editor limit.");
          return;
        }
        this.view.dispatch({
          changes: { from: selection.from, to: selection.to, insert },
          selection: EditorSelection.cursor(selection.from + insert.length),
          userEvent: action === "paste" ? "input.paste" : "delete.cut",
        });
        this.view.focus();
      } catch {
        this.status(
          "Clipboard access was blocked by the browser. Use the keyboard shortcut or grant clipboard access.",
        );
      }
    }
    context(event: MouseEvent) {
      const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      event.preventDefault();
      const selection = this.view.state.selection.main;
      if (pos < selection.from || pos > selection.to) this.view.dispatch({ selection: { anchor: pos } });
      this.menu(event.clientX, event.clientY, [
        { label: "Go to definition", shortcut: "F12", run: () => void this.definition(pos) },
        {
          label: "Show type information",
          run: () => this.showType(pos),
        },
        {
          label: "Trigger suggestions",
          shortcut: "Ctrl/⌘Space",
          run: () => {
            startCompletion(this.view);
          },
        },
        { label: "Quick fixes…", shortcut: "Ctrl/⌘.", run: () => void this.actions(pos) },
        ...(settings().onFormat && !settings().readOnly
          ? [{ label: "Format file", shortcut: "Shift+Alt+F", run: () => settings().onFormat?.() }]
          : []),
        {
          label: "Find in file",
          shortcut: "Ctrl/⌘F",
          run: () => {
            openSearchPanel(this.view);
          },
        },
        {
          label: "Undo",
          shortcut: "Ctrl/⌘Z",
          disabled: settings().readOnly || !undoDepth(this.view.state) ? "No editable undo history." : undefined,
          run: () => {
            undo(this.view);
          },
        },
        {
          label: "Redo",
          shortcut: "Ctrl/⌘⇧Z",
          disabled: settings().readOnly || !redoDepth(this.view.state) ? "No editable redo history." : undefined,
          run: () => {
            redo(this.view);
          },
        },
        {
          label: "Cut selection",
          shortcut: "Ctrl/⌘X",
          disabled:
            settings().readOnly || this.view.state.selection.main.empty
              ? "Select editable source text first."
              : undefined,
          run: () => void this.clipboard("cut"),
        },
        {
          label: "Paste",
          shortcut: "Ctrl/⌘V",
          disabled:
            settings().readOnly || !navigator.clipboard?.readText
              ? "Clipboard paste is unavailable for this view."
              : undefined,
          run: () => void this.clipboard("paste"),
        },
        {
          label: "Select all",
          shortcut: "Ctrl/⌘A",
          run: () => {
            selectAll(this.view);
          },
        },
        {
          label: "Copy selection",
          disabled: !navigator.clipboard?.writeText
            ? "Clipboard copy is unavailable in this browser."
            : this.view.state.selection.main.empty
              ? "Select source text first."
              : undefined,
          run: () => {
            void navigator.clipboard
              .writeText(
                this.view.state.sliceDoc(this.view.state.selection.main.from, this.view.state.selection.main.to),
              )
              .catch(() => this.status("Copy was blocked by the browser."));
          },
        },
      ]);
      return true;
    }
  }
  const plugin = ViewPlugin.fromClass(LanguageView);
  return [
    epoch,
    plugin,
    lintGutter(),
    autocompletion({
      override: [(context) => context.view?.plugin(plugin)?.completions(context) ?? null],
      defaultKeymap: false,
    }),
    keymap.of([
      {
        key: "Escape",
        run: (view) => {
          if (closeCompletion(view)) return true;
          if (!hasHoverTooltips(view.state)) return false;
          view.dispatch({ effects: closeHoverTooltips });
          return true;
        },
      },
      { key: "Ctrl-Space", run: startCompletion },
      { key: "Meta-Space", run: startCompletion },
      {
        key: "F12",
        run: (view) => {
          void view.plugin(plugin)?.definition(view.state.selection.main.head);
          return true;
        },
      },
      {
        key: "Mod-.",
        run: (view) => {
          void view.plugin(plugin)?.actions(view.state.selection.main.head);
          return true;
        },
      },
      ...completionKeymap,
      ...lintKeymap,
    ]),
    hoverTooltip(
      async (view, pos) => {
        const value = await view.plugin(plugin)?.hover(pos);
        return value
          ? { pos: value.from, end: value.to, above: true, create: () => ({ dom: documentation(value.contents) }) }
          : null;
      },
      {
        hoverTime: 450,
        hideOnChange: true,
        hideOn: (transaction) => transaction.startState.field(epoch) !== transaction.state.field(epoch),
      },
    ),
    EditorView.domEventHandlers({
      contextmenu: (event, view) => view.plugin(plugin)?.context(event) ?? false,
      mousedown: (event, view) => {
        const apple = /Mac|iPhone|iPad|iPod/u.test(navigator.platform);
        if (!(event.metaKey || (event.ctrlKey && !apple)) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        event.preventDefault();
        void view.plugin(plugin)?.definition(pos);
        return true;
      },
    }),
  ];
}
