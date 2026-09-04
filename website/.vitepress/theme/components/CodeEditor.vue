<script lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic, lintGutter, lintKeymap, setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defineComponent, onBeforeUnmount, onMounted, type PropType, ref, watch } from "vue";

export interface CodeEditorDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly source?: string;
}

export interface CodeEditorHover {
  readonly from: number;
  readonly to: number;
  readonly content: string;
}

export interface CodeEditorHandle {
  focusRange(from: number, to: number): void;
  measure(): void;
}

export default defineComponent({
  name: "CodeEditor",
  props: {
    modelValue: { type: String, required: true },
    language: { type: String as PropType<"sql" | "typescript">, required: true },
    sqlDialect: { type: String as PropType<"postgres" | "mysql" | "sqlite">, default: "postgres" },
    readonly: { type: Boolean, default: false },
    ariaLabel: { type: String, required: true },
    invalid: { type: Boolean, default: false },
    diagnostics: { type: Array as PropType<readonly CodeEditorDiagnostic[]>, default: () => [] },
    hovers: { type: Array as PropType<readonly CodeEditorHover[]>, default: () => [] },
  },
  emits: {
    "update:modelValue": (value: string) => typeof value === "string",
  },
  setup(props, { emit, expose }) {
    const root = ref<HTMLElement>();
    const language = new Compartment();
    const editable = new Compartment();
    const attributes = new Compartment();
    let editor: EditorView | undefined;
    let synchronizing = false;

    const languageExtension = () => {
      if (props.language !== "sql") return javascript({ typescript: true });
      const dialect = props.sqlDialect === "mysql" ? MySQL : props.sqlDialect === "sqlite" ? SQLite : PostgreSQL;
      return sql({ dialect });
    };
    const editableExtension = () => [EditorState.readOnly.of(props.readonly), EditorView.editable.of(!props.readonly)];
    const attributeExtension = () =>
      EditorView.contentAttributes.of({
        "aria-label": props.ariaLabel,
        "aria-invalid": String(props.invalid),
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
      });

    const typeHover = hoverTooltip(
      (_view, position, side) => {
        const target = props.hovers.find(({ from, to }) => position >= from && position <= to);
        if (target === undefined) return null;
        if ((position === target.from && side < 0) || (position === target.to && side > 0)) return null;
        return {
          pos: target.from,
          end: target.to,
          above: false,
          arrow: false,
          create() {
            const dom = document.createElement("div");
            dom.className = "ts-code-editor__type-hover";
            const content = document.createElement("pre");
            content.textContent = target.content;
            dom.append(content);
            return { dom };
          },
        };
      },
      { hoverTime: 180 },
    );

    function synchronizeDiagnostics() {
      if (editor === undefined) return;
      const documentLength = editor.state.doc.length;
      const diagnostics: Diagnostic[] = props.diagnostics.map((diagnostic) => ({
        from: Math.min(documentLength, Math.max(0, diagnostic.from)),
        to: Math.min(documentLength, Math.max(diagnostic.from + 1, diagnostic.to)),
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
      }));
      editor.dispatch(setDiagnostics(editor.state, diagnostics));
    }

    onMounted(() => {
      editor = new EditorView({
        parent: root.value,
        state: EditorState.create({
          doc: props.modelValue,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            indentOnInput(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            bracketMatching(),
            highlightActiveLine(),
            keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...lintKeymap]),
            lintGutter(),
            oneDark,
            language.of(languageExtension()),
            editable.of(editableExtension()),
            attributes.of(attributeExtension()),
            typeHover,
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) => {
              if (!update.docChanged || synchronizing) return;
              emit("update:modelValue", update.state.doc.toString());
            }),
          ],
        }),
      });
      synchronizeDiagnostics();
    });

    onBeforeUnmount(() => editor?.destroy());

    watch(
      () => props.modelValue,
      (value) => {
        if (editor === undefined || value === editor.state.doc.toString()) return;
        synchronizing = true;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
        synchronizing = false;
      },
    );
    watch(
      () => [props.language, props.sqlDialect] as const,
      () => editor?.dispatch({ effects: language.reconfigure(languageExtension()) }),
    );
    watch(
      () => props.readonly,
      () => editor?.dispatch({ effects: editable.reconfigure(editableExtension()) }),
    );
    watch(
      () => [props.ariaLabel, props.invalid] as const,
      () => editor?.dispatch({ effects: attributes.reconfigure(attributeExtension()) }),
    );
    watch(() => props.diagnostics, synchronizeDiagnostics, { deep: true });

    const handle: CodeEditorHandle = {
      focusRange(from, to) {
        if (editor === undefined) return;
        const length = editor.state.doc.length;
        const anchor = Math.min(length, Math.max(0, from));
        const head = Math.min(length, Math.max(anchor, to));
        editor.dispatch({
          selection: { anchor, head },
          effects: EditorView.scrollIntoView(anchor, { y: "center" }),
        });
        editor.focus();
      },
      measure() {
        editor?.requestMeasure();
      },
    };
    expose(handle);

    return { root };
  },
});
</script>

<template>
  <div ref="root" class="ts-code-editor" />
</template>
