<script lang="ts">
import { computed, defineComponent, nextTick, onMounted, reactive, ref, watch } from "vue";
import { editorDiagnostics } from "../playground/editor-support.js";
import {
  DEFAULT_SCHEMAS,
  PLAYGROUND_DIALECT_LABELS,
  PLAYGROUND_DIALECTS,
  type PlaygroundDialect,
  parsePlaygroundSchema,
} from "../playground/playground.js";
import { useSchemaWorkspace } from "../playground/schema-store.js";
import CodeEditor, { type CodeEditorHandle } from "./CodeEditor.vue";

export default defineComponent({
  name: "SchemaWorkspace",
  components: { CodeEditor },
  setup() {
    const workspace = useSchemaWorkspace();
    const dialog = ref<HTMLDialogElement>();
    const editor = ref<CodeEditorHandle>();
    const drafts = reactive<Record<PlaygroundDialect, string>>({ ...DEFAULT_SCHEMAS });
    const activeSource = computed({
      get: () => drafts[workspace.activeDialect.value],
      set: (value: string) => {
        drafts[workspace.activeDialect.value] = value;
      },
    });
    const parsed = computed(() => parsePlaygroundSchema(workspace.activeDialect.value, activeSource.value));
    const diagnostics = computed(() => editorDiagnostics(activeSource.value, parsed.value.diagnostics));
    const changed = computed(() =>
      PLAYGROUND_DIALECTS.some((dialect) => drafts[dialect] !== workspace.schemas[dialect]),
    );

    function synchronizeDrafts() {
      for (const dialect of PLAYGROUND_DIALECTS) drafts[dialect] = workspace.schemas[dialect];
    }

    function save() {
      for (const dialect of PLAYGROUND_DIALECTS) workspace.update(dialect, drafts[dialect]);
      workspace.close();
    }

    function restoreDefault() {
      activeSource.value = DEFAULT_SCHEMAS[workspace.activeDialect.value];
    }

    function moveDialect(event: KeyboardEvent, dialect: PlaygroundDialect) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = PLAYGROUND_DIALECTS.indexOf(dialect);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = PLAYGROUND_DIALECTS[(index + direction + PLAYGROUND_DIALECTS.length) % PLAYGROUND_DIALECTS.length]!;
      workspace.activeDialect.value = next;
      (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`#schema-tab-${next}`)?.focus();
    }

    function close() {
      workspace.close();
    }

    onMounted(async () => {
      workspace.hydrate();
      synchronizeDrafts();
      if (workspace.isOpen.value && dialog.value !== undefined && !dialog.value.open) {
        dialog.value.showModal();
        await nextTick();
        editor.value?.measure();
      }
    });

    watch(workspace.isOpen, async (open) => {
      const element = dialog.value;
      if (element === undefined) return;
      if (open) {
        synchronizeDrafts();
        if (!element.open) element.showModal();
        await nextTick();
        editor.value?.measure();
      } else if (element.open) element.close();
    });

    watch(workspace.activeDialect, async () => {
      await nextTick();
      editor.value?.measure();
    });

    return {
      activeSource,
      changed,
      close,
      diagnostics,
      dialog,
      editor,
      labels: PLAYGROUND_DIALECT_LABELS,
      moveDialect,
      parsed,
      restoreDefault,
      save,
      workspace,
      dialects: PLAYGROUND_DIALECTS,
    };
  },
});
</script>

<template>
  <dialog ref="dialog" class="ts-schema-dialog" @cancel="close" @close="workspace.close()">
    <section class="ts-schema-workspace" aria-labelledby="schema-workspace-title">
      <header class="ts-schema-workspace__header">
        <div>
          <h2 id="schema-workspace-title">Workspace schemas</h2>
          <p>Every live example reads these browser-local definitions. Your SQL never leaves this device.</p>
        </div>
        <button class="ts-schema-workspace__close" type="button" aria-label="Close schema workspace" @click="close">×</button>
      </header>

      <nav class="ts-schema-workspace__tabs" role="tablist" aria-label="Database grammar">
        <button
          v-for="dialect in dialects"
          :id="`schema-tab-${dialect}`"
          :key="dialect"
          type="button"
          role="tab"
          :aria-selected="workspace.activeDialect.value === dialect"
          aria-controls="schema-editor-panel"
          :tabindex="workspace.activeDialect.value === dialect ? 0 : -1"
          :class="{ 'is-active': workspace.activeDialect.value === dialect }"
          @click="workspace.activeDialect.value = dialect"
          @keydown="moveDialect($event, dialect)"
        >
          {{ labels[dialect] }}
        </button>
      </nav>

      <div
        id="schema-editor-panel"
        class="ts-schema-workspace__editor"
        role="tabpanel"
        :aria-labelledby="`schema-tab-${workspace.activeDialect.value}`"
      >
        <CodeEditor
          ref="editor"
          v-model="activeSource"
          language="sql"
          :sql-dialect="workspace.activeDialect.value"
          :aria-label="`${labels[workspace.activeDialect.value]} schema`"
          :invalid="diagnostics.length > 0"
          :diagnostics="diagnostics"
        />
      </div>

      <footer class="ts-schema-workspace__footer">
        <p :class="{ 'has-errors': parsed.diagnostics.length > 0 }" aria-live="polite">
          <template v-if="parsed.diagnostics.length > 0">
            {{ parsed.diagnostics.length }} schema problem{{ parsed.diagnostics.length === 1 ? "" : "s" }}
          </template>
          <template v-else-if="changed">Ready to apply</template>
          <template v-else>Saved locally in this browser</template>
          <small>Supports CREATE TABLE and PostgreSQL CREATE TYPE … AS ENUM.</small>
        </p>
        <div class="ts-schema-workspace__actions">
          <button type="button" @click="restoreDefault">Restore default</button>
          <button class="is-primary" type="button" :disabled="!changed" @click="save">Apply changes</button>
        </div>
      </footer>
    </section>
  </dialog>
</template>
