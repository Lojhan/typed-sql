import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { sql } from "@codemirror/lang-sql";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import {
  type EditorDiagnostic,
  type EditorLanguageCommand,
  type LanguageDiagnostic,
  type LanguageLocation,
  type LanguageRange,
  type LanguageSettings,
  languageExtensions,
  refreshEditorLanguage,
  runEditorLanguageCommand,
  type WorkingCopy,
} from "./editor-language.js";
import { canonicalWorkingCopies, offsets } from "./editor-language-model.js";
import "./editor-language.css";

export type {
  EditorDiagnostic,
  LanguageDiagnostic,
  LanguageLocation,
  LanguageRange,
  WorkingCopy,
} from "./editor-language.js";

const syntaxColors: Record<string, string> = {
  "#404740": "var(--muted)",
  "#708": "var(--syntax-keyword)",
  "#219": "var(--syntax-atom)",
  "#164": "var(--syntax-literal)",
  "#a11": "var(--syntax-string)",
  "#e40": "var(--syntax-string)",
  "#00f": "var(--syntax-definition)",
  "#30a": "var(--syntax-definition)",
  "#085": "var(--syntax-type)",
  "#167": "var(--syntax-type)",
  "#256": "var(--text)",
  "#00c": "var(--syntax-definition)",
  "#940": "var(--syntax-comment)",
  "#f00": "var(--danger)",
};
const workspaceHighlightStyle = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec) => ({
    ...spec,
    ...(spec.color ? { color: syntaxColors[String(spec.color)] ?? spec.color } : {}),
  })),
);

const activeEditors = new Map<string, EditorView>();
export function findInEditor(session: string) {
  const view = activeEditors.get(session);
  return view ? openSearchPanel(view) : false;
}
export function editorLanguageCommand(session: string, command: EditorLanguageCommand): boolean {
  const view = activeEditors.get(session);
  return view ? runEditorLanguageCommand(view, command) : false;
}
const sessions = new Map<string, { state: EditorState; scroll: number; readOnly: Compartment }>();
const sessionCallbacks = new Map<
  string,
  LanguageSettings & { onChange: (value: string) => void; onSave: () => void; onRun: () => void }
>();
export function Editor({
  source,
  file,
  session,
  onChange,
  onSave,
  onRun,
  revision = "",
  readOnly = false,
  active = false,
  languageEnabled = true,
  reveal,
  diagnostics = [],
  workingCopies = [],
  onNavigate,
  onFormat,
  onLanguageStatus,
  onDiagnostics,
}: {
  source: string;
  file: string;
  session: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onRun: () => void;
  revision?: string;
  readOnly?: boolean;
  active?: boolean;
  languageEnabled?: boolean;
  reveal?: LanguageRange;
  diagnostics?: readonly EditorDiagnostic[];
  workingCopies?: readonly WorkingCopy[];
  onNavigate?: (location: LanguageLocation) => void;
  onFormat?: () => void;
  onLanguageStatus?: (message: string) => void;
  onDiagnostics?: (source: string, diagnostics: readonly LanguageDiagnostic[]) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [languageMessage, setLanguageMessage] = useState("");
  const readOnlyConfiguration = useRef<Compartment | null>(null);
  const settings: LanguageSettings & { onChange: (value: string) => void; onSave: () => void; onRun: () => void } = {
    file,
    revision,
    readOnly,
    enabled: languageEnabled,
    diagnostics,
    workingCopies,
    onChange,
    onSave,
    onRun,
    ...(onNavigate ? { onNavigate } : {}),
    ...(onFormat ? { onFormat } : {}),
    ...(onDiagnostics ? { onDiagnostics } : {}),
    onLanguageStatus: (message) => {
      setLanguageMessage(message);
      onLanguageStatus?.(message);
    },
  };
  const callbacks = useRef(settings);
  callbacks.current = settings;
  sessionCallbacks.set(session, callbacks.current);
  const initial = useRef(source);
  initial.current = source;
  useEffect(() => {
    if (!element.current) return;
    callbacks.current.onLanguageStatus?.("");
    const saved = sessions.get(session);
    sessions.delete(session);
    const readOnlySetting = saved?.readOnly ?? new Compartment();
    readOnlyConfiguration.current = readOnlySetting;
    const current = new EditorView({
      parent: element.current,
      state:
        saved?.state ??
        EditorState.create({
          doc: initial.current,
          extensions: [
            readOnlySetting.of([
              EditorState.readOnly.of(callbacks.current.readOnly),
              EditorView.editable.of(!callbacks.current.readOnly),
            ]),
            lineNumbers(),
            languageExtensions(() => sessionCallbacks.get(session) ?? callbacks.current),
            highlightActiveLine(),
            drawSelection(),
            history(),
            search({ top: true }),
            bracketMatching(),
            foldGutter(),
            syntaxHighlighting(workspaceHighlightStyle),
            file.endsWith(".sql")
              ? sql()
              : javascript({ typescript: /\.(?:[cm]?ts|tsx)$/u.test(file), jsx: /\.[jt]sx$/u.test(file) }),
            EditorView.contentAttributes.of({
              "aria-label": "Query source editor",
              spellcheck: "false",
              tabindex: "0",
            }),
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  sessionCallbacks.get(session)?.onSave();
                  return true;
                },
              },
              {
                key: "Mod-Enter",
                run: () => {
                  sessionCallbacks.get(session)?.onRun();
                  return true;
                },
              },
              ...searchKeymap,
              ...defaultKeymap,
              ...historyKeymap,
              indentWithTab,
            ]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) sessionCallbacks.get(session)?.onChange(update.state.doc.toString());
            }),
            EditorView.theme({
              "&": {
                height: "100%",
                fontSize: "13px",
                overflow: "hidden",
                color: "var(--text)",
                backgroundColor: "var(--editor)",
              },
              ".cm-scroller": {
                overflow: "auto",
                minHeight: "0",
                flex: "1 1 0",
                fontFamily: "'SFMono-Regular', Consolas, monospace",
                lineHeight: "1.8",
              },
              ".cm-line": { padding: "0 24px" },
              ".cm-gutters": {
                backgroundColor: "var(--bg)",
                borderRight: "1px solid var(--border)",
                color: "var(--muted)",
              },
              ".cm-panels": {
                backgroundColor: "var(--bg)",
                color: "var(--text)",
                borderColor: "var(--border)",
                flexShrink: "0",
              },
              ".cm-searchMatch": {
                backgroundColor: "var(--editor-selection-inactive)",
                outline: "1px solid var(--accent)",
              },
              ".cm-searchMatch-selected": { backgroundColor: "var(--editor-selection)" },
              ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
              ".cm-selectionBackground": { backgroundColor: "var(--editor-selection-inactive)" },
              ".cm-content ::selection, .cm-content::selection": { color: "inherit" },
              "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
                backgroundColor: "var(--editor-selection)",
              },
              ".cm-content": { padding: "20px 0", caretColor: "var(--text)" },
              "&.cm-focused": { outline: "none" },
            }),
          ],
        }),
    });
    view.current = current;
    activeEditors.set(session, current);
    if (saved) current.scrollDOM.scrollTop = saved.scroll;
    else {
      try {
        const cursor = JSON.parse(localStorage.getItem(`typed-sql:cursor:${session}`) ?? "null");
        if (cursor && Number.isInteger(cursor.anchor))
          current.dispatch({ selection: { anchor: Math.min(current.state.doc.length, Math.max(0, cursor.anchor)) } });
      } catch {}
    }
    const observer = new ResizeObserver(() => current.requestMeasure());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      activeEditors.delete(session);
      sessions.set(session, { state: current.state, scroll: current.scrollDOM.scrollTop, readOnly: readOnlySetting });
      while (sessions.size > 32) {
        const oldest = sessions.keys().next().value!;
        sessions.delete(oldest);
        sessionCallbacks.delete(oldest);
      }
      try {
        localStorage.setItem(
          `typed-sql:cursor:${session}`,
          JSON.stringify({ anchor: current.state.selection.main.anchor }),
        );
      } catch {}
      current.destroy();
      view.current = null;
      readOnlyConfiguration.current = null;
    };
  }, [file, session]);
  useEffect(() => {
    const current = view.current;
    const normalized = source.replace(/\r\n?/gu, "\n");
    if (current && current.state.doc.toString() !== normalized)
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: normalized } });
  }, [source]);
  useEffect(() => {
    const current = activeEditors.get(session);
    if (current && readOnlyConfiguration.current)
      current.dispatch({
        effects: readOnlyConfiguration.current.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      });
  }, [readOnly, session]);
  const diagnosticsKey = JSON.stringify(diagnostics);
  const workingCopyKey = JSON.stringify(canonicalWorkingCopies(workingCopies, file));
  useEffect(() => {
    activeEditors.get(session)?.dispatch({
      effects: refreshEditorLanguage({ revision, diagnosticsKey, workingCopyKey, enabled: languageEnabled }),
    });
  }, [revision, diagnosticsKey, workingCopyKey, languageEnabled, session]);
  useEffect(() => {
    if (active) activeEditors.get(session)?.focus();
  }, [active, session]);
  useEffect(() => {
    const current = activeEditors.get(session);
    if (!current || !reveal) return;
    const range = offsets(current.state.doc.toString(), reveal);
    if (!range) return;
    current.dispatch({
      selection: EditorSelection.range(range.from, range.to),
      effects: EditorView.scrollIntoView(range.from, { y: "center" }),
    });
    current.focus();
  }, [reveal, session]);
  return (
    <div className="editor-mount">
      <div className="editor-language-mount" ref={element} />
      {languageMessage ? (
        <div className="editor-language-status" role="status">
          {languageMessage}
        </div>
      ) : null}
    </div>
  );
}
