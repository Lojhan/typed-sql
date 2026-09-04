<script lang="ts">
import { computed, defineComponent, nextTick, ref, watch } from "vue";
import {
  analyzePostgresPlayground,
  DEFAULT_PLAYGROUND_SCHEMA,
  DEFAULT_PLAYGROUND_SOURCE,
  type PlaygroundFile,
} from "../playground/postgres-playground.js";
import CodeEditor, { type CodeEditorDiagnostic, type CodeEditorHandle, type CodeEditorHover } from "./CodeEditor.vue";

function sourceOffset(source: string, line: number, column: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return offset + Math.max(0, column - 1);
}

export default defineComponent({
  name: "SqlPlayground",
  components: { CodeEditor },
  setup() {
    const activeFile = ref<PlaygroundFile>("schema.sql");
    const schemaSource = ref(DEFAULT_PLAYGROUND_SCHEMA);
    const mainSource = ref(DEFAULT_PLAYGROUND_SOURCE);
    const schemaEditor = ref<CodeEditorHandle>();
    const mainEditor = ref<CodeEditorHandle>();
    const result = computed(() => analyzePostgresPlayground(schemaSource.value, mainSource.value));
    const editorDiagnostics = computed(() => {
      const grouped: Record<PlaygroundFile, CodeEditorDiagnostic[]> = { "schema.sql": [], "main.ts": [] };
      for (const diagnostic of result.value.diagnostics) {
        const source = diagnostic.file === "schema.sql" ? schemaSource.value : mainSource.value;
        const from = sourceOffset(source, diagnostic.line, diagnostic.column);
        const to = sourceOffset(
          source,
          diagnostic.endLine ?? diagnostic.line,
          diagnostic.endColumn ?? diagnostic.column,
        );
        grouped[diagnostic.file].push({
          from,
          to: Math.max(from + 1, to),
          severity: diagnostic.severity,
          message: diagnostic.suggestion ? `${diagnostic.message}\n${diagnostic.suggestion}` : diagnostic.message,
          source: diagnostic.code,
        });
      }
      return grouped;
    });
    const mainHovers = computed<readonly CodeEditorHover[]>(() =>
      result.value.queries.flatMap((query) => {
        const from = mainSource.value.indexOf(query.binding);
        return from < 0 ? [] : [{ from, to: from + query.binding.length, content: query.contract }];
      }),
    );
    const statusLabel = computed(() => {
      const count = result.value.diagnostics.length;
      if (count > 0) return `${count} problem${count === 1 ? "" : "s"}`;
      const query = result.value.queries[0];
      return query === undefined ? "No diagnostics" : `Hover ${query.binding} for its type`;
    });

    function reset() {
      schemaSource.value = DEFAULT_PLAYGROUND_SCHEMA;
      mainSource.value = DEFAULT_PLAYGROUND_SOURCE;
      activeFile.value = "schema.sql";
    }

    watch(activeFile, async (file) => {
      await nextTick();
      (file === "schema.sql" ? schemaEditor.value : mainEditor.value)?.measure();
    });

    return {
      activeFile,
      editorDiagnostics,
      mainEditor,
      mainHovers,
      mainSource,
      reset,
      result,
      schemaEditor,
      schemaSource,
      statusLabel,
    };
  },
});
</script>

<template>
  <section class="ts-playground" aria-label="Interactive PostgreSQL type inference playground">
    <header class="ts-playground__toolbar">
      <div class="ts-playground__tabs" role="tablist" aria-label="Playground files">
        <button
          v-for="file in (['schema.sql', 'main.ts'] as const)"
          :id="`playground-tab-${file}`"
          :key="file"
          class="ts-playground__tab"
          :class="{ 'is-active': activeFile === file }"
          type="button"
          role="tab"
          :aria-selected="activeFile === file"
          :aria-controls="`playground-panel-${file}`"
          @click="activeFile = file"
        >
          <span aria-hidden="true">{{ file === "schema.sql" ? "◇" : "TS" }}</span>
          {{ file }}
        </button>
      </div>
      <button class="ts-playground__reset" type="button" @click="reset">Reset</button>
    </header>

    <div class="ts-playground__workspace">
      <div class="ts-playground__editors">
        <div
          id="playground-panel-schema.sql"
          v-show="activeFile === 'schema.sql'"
          role="tabpanel"
          aria-labelledby="playground-tab-schema.sql"
        >
          <CodeEditor
            ref="schemaEditor"
            v-model="schemaSource"
            language="sql"
            aria-label="PostgreSQL schema"
            :invalid="editorDiagnostics['schema.sql'].length > 0"
            :diagnostics="editorDiagnostics['schema.sql']"
          />
        </div>
        <div
          id="playground-panel-main.ts"
          v-show="activeFile === 'main.ts'"
          role="tabpanel"
          aria-labelledby="playground-tab-main.ts"
        >
          <CodeEditor
            ref="mainEditor"
            v-model="mainSource"
            language="typescript"
            aria-label="TypeScript source"
            :invalid="editorDiagnostics['main.ts'].length > 0"
            :diagnostics="editorDiagnostics['main.ts']"
            :hovers="mainHovers"
          />
        </div>
        <footer
          class="ts-playground__editor-status"
          :class="{ 'has-errors': result.diagnostics.length > 0 }"
          aria-live="polite"
        >
          <span>{{ activeFile }}</span>
          <span>{{ statusLabel }}</span>
        </footer>
      </div>
    </div>

    <footer class="ts-playground__note">
      Hover an underlined problem for its diagnostic, or press <kbd>F8</kbd> to move between problems. Analysis
      runs locally with typed-sql’s compiler scanner and PostgreSQL grammar. The schema editor accepts
      <code>CREATE TABLE</code> and <code>CREATE TYPE … AS ENUM</code> for this focused demo.
    </footer>
  </section>
</template>
