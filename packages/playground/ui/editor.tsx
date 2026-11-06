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
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

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
const sessions = new Map<string, { state: EditorState; scroll: number }>();
const sessionCallbacks = new Map<
  string,
  { onChange: (value: string) => void; onSave: () => void; onRun: () => void }
>();
export function Editor({
  source,
  file,
  session,
  onChange,
  onSave,
  onRun,
}: {
  source: string;
  file: string;
  session: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onRun: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave, onRun });
  callbacks.current = { onChange, onSave, onRun };
  sessionCallbacks.set(session, callbacks.current);
  const initial = useRef(source);
  initial.current = source;
  useEffect(() => {
    if (!element.current) return;
    const saved = sessions.get(session);
    const current = new EditorView({
      parent: element.current,
      state:
        saved?.state ??
        EditorState.create({
          doc: initial.current,
          extensions: [
            lineNumbers(),
            highlightActiveLine(),
            drawSelection(),
            history(),
            search({ top: true }),
            bracketMatching(),
            foldGutter(),
            syntaxHighlighting(workspaceHighlightStyle),
            file.endsWith(".sql") ? sql() : javascript({ typescript: true }),
            EditorView.contentAttributes.of({ "aria-label": "Query source editor", spellcheck: "false" }),
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
      sessions.set(session, { state: current.state, scroll: current.scrollDOM.scrollTop });
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
    };
  }, [file, session]);
  useEffect(() => {
    const current = view.current;
    if (current && current.state.doc.toString() !== source)
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: source } });
  }, [source]);
  return <div className="editor-mount" ref={element} />;
}
