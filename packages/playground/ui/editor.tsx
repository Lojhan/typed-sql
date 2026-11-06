import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { sql } from "@codemirror/lang-sql";
import { bracketMatching, defaultHighlightStyle, foldGutter, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

export function Editor({
  source,
  file,
  onChange,
  onSave,
  onRun,
}: {
  source: string;
  file: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onRun: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave, onRun });
  callbacks.current = { onChange, onSave, onRun };
  const initial = useRef(source);
  initial.current = source;
  useEffect(() => {
    if (!element.current) return;
    const current = new EditorView({
      parent: element.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          foldGutter(),
          syntaxHighlighting(defaultHighlightStyle),
          file.endsWith(".sql") ? sql() : javascript({ typescript: true }),
          EditorView.contentAttributes.of({ "aria-label": "Query source editor", spellcheck: "false" }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            {
              key: "Mod-Enter",
              run: () => {
                callbacks.current.onRun();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "'SFMono-Regular', Consolas, monospace",
              lineHeight: "1.8",
            },
            ".cm-content": { padding: "20px 0" },
            ".cm-line": { padding: "0 24px" },
            ".cm-gutters": { backgroundColor: "#fafbf9", borderRight: "1px solid #edf0e9", color: "#9aa493" },
            ".cm-activeLine": { backgroundColor: "#f1f5ed" },
            "&.cm-focused": { outline: "none" },
          }),
        ],
      }),
    });
    view.current = current;
    return () => {
      current.destroy();
      view.current = null;
    };
  }, [file]);
  useEffect(() => {
    const current = view.current;
    if (current && current.state.doc.toString() !== source)
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: source } });
  }, [source]);
  return <div className="editor-mount" ref={element} />;
}
