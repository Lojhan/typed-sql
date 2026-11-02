<script lang="ts">
import { autocompletion, type CompletionContext, completionKeymap, pickedCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic, lintGutter, lintKeymap, setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  Decoration,
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
import { useData } from "vitepress";
import { defineComponent, onBeforeUnmount, onMounted, type PropType, ref, watch } from "vue";
import type {
  EditorAction,
  EditorCompletion,
  EditorCompletionEdits,
  EditorResponse,
} from "../playground/editor-protocol.js";

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
    cursorPosition: { type: Number, default: 0 },
    interact: { type: Function as PropType<(request: EditorAction) => Promise<EditorResponse>>, default: undefined },
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
    definition: (position: number) => Number.isInteger(position),
    inspect: (position: number) => Number.isInteger(position),
  },
  setup(props, { emit, expose }) {
    const { isDark } = useData();
    const root = ref<HTMLElement>();
    const language = new Compartment();
    const editable = new Compartment();
    const attributes = new Compartment();
    const appearance = new Compartment();
    let editor: EditorView | undefined;
    let synchronizing = false;
    const definitionMark = StateEffect.define<{ from: number; to: number } | undefined>();
    const definitionLinks = StateField.define({
      create: () => Decoration.none,
      update(value, transaction) {
        if (transaction.docChanged) return Decoration.none;
        for (const effect of transaction.effects)
          if (effect.is(definitionMark)) {
            return effect.value
              ? Decoration.set([
                  Decoration.mark({
                    class: "cm-definition-link",
                    attributes: { title: "Go to definition (Cmd/Ctrl+click)" },
                  }).range(effect.value.from, effect.value.to),
                ])
              : Decoration.none;
          }
        return value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });
    let pointerPosition: number | undefined;
    let linkRequest = 0;
    let lastProbe = "";
    function clearDefinitionLink() {
      linkRequest += 1;
      lastProbe = "";
      if (editor?.state.field(definitionLinks).size) editor.dispatch({ effects: definitionMark.of(undefined) });
    }
    function probeDefinition(modifier: boolean) {
      if (!modifier || !editor || pointerPosition === undefined || !props.interact || props.language !== "typescript") {
        clearDefinitionLink();
        return;
      }
      const view = editor;
      const word = view.state.wordAt(pointerPosition);
      if (!word) {
        clearDefinitionLink();
        return;
      }
      const document = view.state.doc;
      const probe = `${word.from}:${word.to}:${document.toString()}`;
      if (lastProbe === probe) return;
      clearDefinitionLink();
      lastProbe = probe;
      const request = ++linkRequest;
      void props.interact({ kind: "definition", position: pointerPosition }).then((target) => {
        if (request !== linkRequest || editor !== view || view.state.doc !== document) return;
        if (target && !Array.isArray(target) && "file" in target)
          view.dispatch({ effects: definitionMark.of({ from: word.from, to: word.to }) });
      });
    }
    function modifierKey(event: KeyboardEvent) {
      probeDefinition(event.metaKey || event.ctrlKey);
    }
    function leaveEditor() {
      pointerPosition = undefined;
      clearDefinitionLink();
    }

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
        "aria-readonly": String(props.readonly),
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
      });
    const appearanceExtension = () => (isDark.value ? oneDark : []);

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
            const hoverAppearance = new Compartment();
            const preview = new EditorView({
              parent: dom,
              state: EditorState.create({
                doc: target.content,
                extensions: [
                  javascript({ typescript: true }),
                  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
                  hoverAppearance.of(appearanceExtension()),
                  EditorState.readOnly.of(true),
                  EditorView.editable.of(false),
                  EditorView.contentAttributes.of({ "aria-label": "Inferred TypeScript type" }),
                  EditorView.lineWrapping,
                ],
              }),
            });
            return {
              dom,
              update() {
                preview.dispatch({ effects: hoverAppearance.reconfigure(appearanceExtension()) });
              },
              destroy() {
                preview.destroy();
              },
            };
          },
        };
      },
      { hoverTime: 180 },
    );

    async function complete(context: CompletionContext) {
      if (props.readonly || props.language !== "typescript" || !props.interact) return null;
      const word = context.matchBefore(/[\w$]*/u);
      if (
        !context.explicit &&
        (!word || word.from === word.to) &&
        context.state.sliceDoc(context.pos - 1, context.pos) !== "."
      )
        return null;
      const document = context.state.doc;
      const entries = await props.interact({ kind: "completions", position: context.pos });
      if (context.aborted || editor?.state.doc !== document || !Array.isArray(entries)) return null;
      return {
        from: word?.from ?? context.pos,
        options: entries.map((entry: EditorCompletion) => ({
          label: entry.name,
          detail: entry.source ? `Import from ${entry.source.replace("/workspace/", "")}` : entry.kind,
          type: /function|method|constructor/u.test(entry.kind)
            ? "function"
            : /property/u.test(entry.kind)
              ? "property"
              : /keyword/u.test(entry.kind)
                ? "keyword"
                : "variable",
          sortText: entry.sortText,
          apply(view: EditorView, completion: { label: string }, from: number, to: number) {
            const before = view.state.doc;
            void props
              .interact?.({ kind: "completionEdits", position: context.pos, entry } as EditorAction)
              .then((value) => {
                if (view !== editor || view.state.doc !== before) return;
                const details = value as EditorCompletionEdits | undefined;
                // An auto-import is accepted only together with its verified import edits.
                if (entry.source && !details) return;
                const range = entry.replacement ?? { from, to };
                const primary = { ...range, insert: entry.insertText ?? entry.name };
                const changes = [...(details?.edits ?? []), primary].sort((a, b) => a.from - b.from || a.to - b.to);
                if (changes.some((change, index) => index > 0 && change.from < changes[index - 1]!.to)) return;
                const selection =
                  range.from +
                  primary.insert.length +
                  changes
                    .filter((change) => change !== primary && change.from <= range.from)
                    .reduce((sum, change) => sum + change.insert.length - (change.to - change.from), 0);
                view.dispatch({
                  changes,
                  selection: { anchor: selection },
                  annotations: pickedCompletion.of(completion),
                  userEvent: "input.complete",
                });
              });
          },
        })),
      };
    }

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
          selection: { anchor: Math.min(props.modelValue.length, Math.max(0, props.cursorPosition)) },
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
            definitionLinks,
            autocompletion({ override: props.interact && props.language === "typescript" ? [complete] : undefined }),
            EditorView.domEventHandlers({
              mousemove(event, view) {
                pointerPosition = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined;
                probeDefinition(event.metaKey || event.ctrlKey);
              },
              mouseleave() {
                leaveEditor();
              },
              mousedown(event, view) {
                if (event.button !== 0 || !(event.metaKey || event.ctrlKey) || !props.interact) return false;
                const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (position === null) return false;
                event.preventDefault();
                emit("definition", position);
                return true;
              },
            }),
            keymap.of([
              {
                key: "F12",
                run: (view) => {
                  if (!props.interact) return false;
                  emit("definition", view.state.selection.main.head);
                  return true;
                },
              },
              ...completionKeymap,
              indentWithTab,
              ...defaultKeymap,
              ...historyKeymap,
              ...lintKeymap,
            ]),
            lintGutter(),
            appearance.of(appearanceExtension()),
            language.of(languageExtension()),
            editable.of(editableExtension()),
            attributes.of(attributeExtension()),
            typeHover,
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) => {
              if (update.selectionSet) emit("inspect", update.state.selection.main.head);
              if (!update.docChanged || synchronizing) return;
              emit("update:modelValue", update.state.doc.toString());
            }),
          ],
        }),
      });
      synchronizeDiagnostics();
      window.addEventListener("keydown", modifierKey);
      window.addEventListener("keyup", modifierKey);
      window.addEventListener("blur", leaveEditor);
    });

    onBeforeUnmount(() => {
      linkRequest += 1;
      window.removeEventListener("keydown", modifierKey);
      window.removeEventListener("keyup", modifierKey);
      window.removeEventListener("blur", leaveEditor);
      editor?.destroy();
      editor = undefined;
    });

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
      () => [props.ariaLabel, props.invalid, props.readonly] as const,
      () => editor?.dispatch({ effects: attributes.reconfigure(attributeExtension()) }),
    );
    watch(isDark, () => editor?.dispatch({ effects: appearance.reconfigure(appearanceExtension()) }));
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
