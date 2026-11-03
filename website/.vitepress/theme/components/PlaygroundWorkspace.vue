<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  closeEditorFile,
  createPane,
  type DropEdge,
  dropEditorFile,
  type EditorLayout,
  editorPanes,
  isCloseFileShortcut,
  openInPane,
  removePane,
} from "../playground/editor-layout.js";
import type { EditorAction, EditorLocation, EditorResponse } from "../playground/editor-protocol.js";
import {
  DEFAULT_SCHEMAS,
  PLAYGROUND_DIALECT_LABELS,
  PLAYGROUND_DIALECTS,
  type PlaygroundDialect,
} from "../playground/playground.js";
import type { WorkspaceAnalysis } from "../playground/semantic-service.js";
import {
  LESSONS,
  lessonFiles,
  lessonSupportsDialect,
  validWorkspaceFiles,
  type WorkspaceFile,
  type WorkspaceFiles,
} from "../playground/workspace.js";
import {
  type ProblemsPanelState,
  type QuerySelection,
  queryAtPosition,
  querySelection,
  resolveQuerySelection,
  transitionProblemsPanel,
} from "../playground/workspace-selection.js";
import {
  decodeSharedWorkspace,
  defaultPlaygroundState,
  LEGACY_STORAGE_KEY,
  type PlaygroundState,
  restorePlaygroundState,
  WORKSPACE_STORAGE_KEY,
  type WorkspaceExample,
} from "../playground/workspace-storage.js";
import {
  panelShortcut,
  WORKSPACE_CONFIG_NAME,
  WORKSPACE_CONFIG_PATH,
  workspaceConfigSource,
} from "../playground/workspace-ui.js";
import EditorIcon from "./EditorIcon.vue";
import EditorPaneLayout from "./EditorPaneLayout.vue";
import HighlightedCode from "./HighlightedCode.vue";
import PanelResizeHandle from "./PanelResizeHandle.vue";
import ScrollArea from "./ScrollArea.vue";
import WorkspaceFileTree from "./WorkspaceFileTree.vue";
import WorkspaceTabs from "./WorkspaceTabs.vue";

const dialect = ref<PlaygroundDialect>("postgres");
const exampleByDialect = reactive<Record<PlaygroundDialect, WorkspaceExample>>({
  postgres: "commerce",
  mysql: "commerce",
  sqlite: "commerce",
});
const lesson = computed({
  get: () => exampleByDialect[dialect.value],
  set: (value: WorkspaceExample) => {
    exampleByDialect[dialect.value] = value;
  },
});
const layouts = reactive(
  Object.fromEntries(
    PLAYGROUND_DIALECTS.map((id) => [
      id,
      createPane("app.ts", ["app.ts", "queries/account.ts", "queries/account.sql"]),
    ]),
  ) as Record<PlaygroundDialect, EditorLayout>,
);
const layout = computed({
  get: () => layouts[dialect.value],
  set: (value: EditorLayout) => {
    layouts[dialect.value] = value;
  },
});
const activePaneId = ref(editorPanes(layout.value)[0]!.id);
const activePane = computed(
  () => editorPanes(layout.value).find((pane) => pane.id === activePaneId.value) ?? editorPanes(layout.value)[0]!,
);
const availableLessons = computed(() => LESSONS.filter(({ id }) => lessonSupportsDialect(id, dialect.value)));
const activeFile = computed({
  get: () => activePane.value.file,
  set: (file: string) => {
    openInPane(activePane.value, file);
  },
});
function focusPane(id: string) {
  activePaneId.value = id;
}
function selectPaneFile(id: string, file: string) {
  focusPane(id);
  activeFile.value = file;
}
function dropFile(id: string, file: string, edge: DropEdge, source?: string, before?: string) {
  if (!(file in files.value) && file !== WORKSPACE_CONFIG_PATH) return;
  if (edge !== "center" && editorPanes(layout.value).length >= 8) {
    notice.value = "Up to eight editor panes can be open.";
    return;
  }
  const result = dropEditorFile(layout.value, id, file, edge, source, before);
  layout.value = result.layout;
  activePaneId.value = result.active;
}
function closeFile(id: string, file: string) {
  layout.value = closeEditorFile(layout.value, id, file);
  if (!editorPanes(layout.value).some((pane) => pane.id === activePaneId.value))
    activePaneId.value = editorPanes(layout.value)[0]!.id;
  void nextTick(() =>
    editor.value?.focusRange(
      activePane.value.id,
      activePane.value.cursors[activeFile.value] ?? 0,
      activePane.value.cursors[activeFile.value] ?? 0,
    ),
  );
}
function closePane(id: string) {
  if (editorPanes(layout.value).length < 2) return;
  layout.value = removePane(layout.value, id)!;
  if (!editorPanes(layout.value).some((pane) => pane.id === activePaneId.value))
    activePaneId.value = editorPanes(layout.value)[0]!.id;
}
const defaults = defaultPlaygroundState();
const drafts = reactive(
  Object.fromEntries(PLAYGROUND_DIALECTS.map((id) => [id, defaults.workspaces[id].files])) as Record<
    PlaygroundDialect,
    WorkspaceFiles
  >,
);
const files = computed(() => drafts[dialect.value]);
const configSource = computed(() => workspaceConfigSource(dialect.value, files.value));
const readonlyFile = computed(() => activeFile.value === WORKSPACE_CONFIG_PATH);
const fileTabs = computed(() => [...Object.keys(files.value), WORKSPACE_CONFIG_PATH].sort());
const showFiles = ref(true);
const showInspector = ref(true);
const showProblems = ref(true);
const treeWidth = ref(200);
const inspectorWidth = ref(400);
const inspectorHeight = ref(240);
const problemsHeight = ref(160);
const shell = ref<HTMLElement>();
const shellWidth = ref(1200);
const shellHeight = ref(700);
const narrow = computed(() => shellWidth.value <= 720);
const treeMax = computed(() => Math.max(120, Math.min(400, shellWidth.value * 0.35)));
const inspectorMax = computed(() =>
  narrow.value
    ? Math.max(120, shellHeight.value * 0.55)
    : Math.max(240, shellWidth.value - (showFiles.value ? Math.min(treeWidth.value, treeMax.value) + 4 : 0) - 240),
);
const problemsMax = computed(() => Math.max(80, shellHeight.value * 0.45));
const layoutStyle = computed(() => ({
  "--pg-tree-width": `${Math.min(treeWidth.value, treeMax.value)}px`,
  "--pg-inspector-width": `${Math.min(inspectorWidth.value, inspectorMax.value)}px`,
  "--pg-inspector-height": `${Math.min(inspectorHeight.value, inspectorMax.value)}px`,
}));
const result = ref<WorkspaceAnalysis>();
const busy = ref(true);
const failure = ref("");
const notice = ref("");
const cursor = ref(-1);
const selectedQuery = ref<QuerySelection>();
const output = ref<"contract" | "sql">("contract");
const editor = ref<{ focusRange(id: string, from: number, to: number): void; measure(): void }>();
const query = computed(() => resolveQuerySelection(result.value?.queries ?? [], activeFile.value, selectedQuery.value));
const problemState = ref<ProblemsPanelState>({ open: true, finalizedProblems: [] });
const problems = computed(() => problemState.value.finalizedProblems);
const problemFiles = computed(() => [...new Set(problems.value.map(({ file }) => file))]);
const outputTabItems = [
  { value: "contract", label: "Inferred types" },
  { value: "sql", label: "SQL preview" },
] as const;
const hovers = computed(() => (busy.value ? [] : (result.value?.hovers[activeFile.value] ?? [])));
const inspected = computed(() => hovers.value.find(({ from, to }) => cursor.value >= from && cursor.value <= to));
const cleanRow = computed(() =>
  query.value?.rowType
    .replace(/;\s*/gu, ";\n  ")
    .replace(/^\{\s*/u, "{\n  ")
    .replace(/\s*\}$/u, "\n}"),
);
let worker: Worker | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;
let requestId = 0;
const pending = new Map<number, { resolve: (value: EditorResponse) => void; timeout: ReturnType<typeof setTimeout> }>();
function interact(file: string, request: EditorAction): Promise<EditorResponse> {
  if (!worker || file === WORKSPACE_CONFIG_PATH) return Promise.resolve(undefined);
  const id = ++requestId;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      resolve(undefined);
    }, 8000);
    pending.set(id, { resolve, timeout });
    worker!.postMessage({ id, request: { ...request, file }, dialect: dialect.value, files: { ...files.value } });
  });
}
async function goToDefinition(paneId: string, file: string, position: number) {
  const document = files.value[file];
  const target = (await interact(file, { kind: "definition", position })) as EditorLocation | undefined;
  if (activePane.value.id !== paneId || file !== activeFile.value || document !== files.value[file]) return;
  if (!target || !(target.file in files.value)) {
    notice.value = "No workspace definition found for this symbol.";
    return;
  }
  activeFile.value = target.file;
  await nextTick();
  editor.value?.focusRange(paneId, target.from, target.to);
}
let disposed = false;
let resizeObserver: ResizeObserver | undefined;
let applyingExample = false;
let watchedDialect = dialect.value;

function saveWorkspace() {
  const saved: PlaygroundState = {
    version: 2,
    dialect: dialect.value,
    workspaces: Object.fromEntries(
      PLAYGROUND_DIALECTS.map((id) => [id, { files: { ...drafts[id] }, example: exampleByDialect[id] }]),
    ) as PlaygroundState["workspaces"],
  };
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* Editing works without storage. */
  }
}

function schedule() {
  if (!worker) return;
  const next = ++revision;
  busy.value = true;
  failure.value = "";
  clearTimeout(timer);
  timer = setTimeout(() => {
    worker?.postMessage({ revision: next, dialect: dialect.value, files: { ...files.value } });
    saveWorkspace();
  }, 180);
}

function loadLesson() {
  if (lesson.value === "custom") return;
  notice.value = "";
  applyingExample = true;
  drafts[dialect.value] = lessonFiles(dialect.value, lesson.value, DEFAULT_SCHEMAS[dialect.value]);
  activeFile.value =
    lesson.value === "commerce" || lesson.value === "errors" || lesson.value === "workspace"
      ? "app.ts"
      : "queries/account.ts";
  layout.value = createPane(
    activeFile.value,
    Object.keys(files.value).filter((file) => file.endsWith(".ts") || file.startsWith("queries/")),
  );
  activePaneId.value = editorPanes(layout.value)[0]!.id;
  applyingExample = false;
  cursor.value = -1;
  selectedQuery.value = undefined;
}

function createFile(path: string) {
  if (path === WORKSPACE_CONFIG_NAME || path === WORKSPACE_CONFIG_PATH) {
    notice.value = "The playground configuration is read only.";
    return;
  }
  if (path in files.value) {
    notice.value = "A file with this path already exists.";
    return;
  }
  const table = dialect.value === "sqlite" ? "account" : "users";
  const content = path.endsWith(".ts")
    ? `import { sql } from "@typed-sql/${dialect.value}";\n\nexport const query = sql\`SELECT id, email FROM ${table}\`;\n`
    : path.startsWith("schema/")
      ? "-- Define shared tables or scalar functions here.\n"
      : `SELECT id, email FROM ${table};\n`;
  const updated = { ...files.value, [path]: content };
  if (!validWorkspaceFiles(updated)) {
    notice.value = "The workspace size limit has been reached.";
    return;
  }
  drafts[dialect.value] = updated;
  activeFile.value = path;
}

function inspectAt(position: number) {
  cursor.value = position;
  const selected = queryAtPosition(result.value?.queries ?? [], activeFile.value, position);
  if (selected && !busy.value) selectedQuery.value = querySelection(selected);
}

function handlePanelShortcut(event: KeyboardEvent) {
  if (isCloseFileShortcut(event) && shell.value?.contains(event.target as Node)) {
    event.preventDefault();
    event.stopPropagation();
    if (activeFile.value) closeFile(activePane.value.id, activeFile.value);
    return;
  }
  const panel = panelShortcut(event);
  if (!panel) return;
  event.preventDefault();
  event.stopPropagation();
  if (panel === "files") showFiles.value = !showFiles.value;
  else showInspector.value = !showInspector.value;
}

async function focusProblem(file: WorkspaceFile, from: number, to: number) {
  if (busy.value) return;
  activeFile.value = file;
  await nextTick();
  cursor.value = from;
  editor.value?.focusRange(activePane.value.id, from, to);
}

async function share() {
  const payload = { dialect: dialect.value, lesson: lesson.value, files: { ...files.value } };
  const hash = `#code=${encodeURIComponent(JSON.stringify(payload))}`;
  if (hash.length > 100_000) {
    notice.value = "This workspace is too large for a share link.";
    return;
  }
  history.replaceState(null, "", hash);
  try {
    await navigator.clipboard.writeText(location.href);
    notice.value = "Playground link copied.";
  } catch {
    notice.value = "Share link ready in your address bar.";
  }
}

onMounted(async () => {
  window.addEventListener("keydown", handlePanelShortcut, true);
  if (shell.value) {
    resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) {
        shellWidth.value = entry.contentRect.width;
        shellHeight.value = entry.contentRect.height;
      }
    });
    resizeObserver.observe(shell.value);
  }
  try {
    const parseSaved = (key: string) => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "null");
      } catch {
        return undefined;
      }
    };
    const saved = restorePlaygroundState(parseSaved(WORKSPACE_STORAGE_KEY), parseSaved(LEGACY_STORAGE_KEY));
    for (const id of PLAYGROUND_DIALECTS) {
      drafts[id] = saved.workspaces[id].files;
      exampleByDialect[id] = saved.workspaces[id].example;
    }
    dialect.value = saved.dialect;
  } catch {
    notice.value = "Saved workspace could not be loaded.";
  }
  if (location.hash.startsWith("#code=")) {
    try {
      const shared = decodeSharedWorkspace(JSON.parse(decodeURIComponent(location.hash.slice(6))));
      if (shared) {
        dialect.value = shared.dialect;
        drafts[dialect.value] = shared.workspace.files;
        lesson.value = shared.workspace.example;
      } else notice.value = "This share link does not contain a valid playground.";
    } catch {
      notice.value = "The shared playground link is malformed. Your saved workspace is still available.";
    }
  }
  if (!(activeFile.value in files.value)) activeFile.value = Object.keys(files.value)[0]!;
  // Load the compiler only on the dedicated playground, never in the homepage bundle.
  try {
    const { default: SemanticWorker } = await import("../playground/semantic.worker.ts?worker");
    if (disposed) return;
    worker = new SemanticWorker();
    worker.onmessage = ({ data }) => {
      if ("id" in data) {
        const request = pending.get(data.id);
        if (request) {
          clearTimeout(request.timeout);
          pending.delete(data.id);
          request.resolve(data.value);
        }
        return;
      }
      if (data.revision !== revision) return;
      busy.value = false;
      failure.value = data.error ?? "";
      result.value = data.result;
      problemState.value = transitionProblemsPanel(
        { ...problemState.value, open: showProblems.value },
        data.result?.problems ?? [],
        false,
      );
      showProblems.value = problemState.value.open;
      const candidate = resolveQuerySelection(data.result?.queries ?? [], activeFile.value, selectedQuery.value);
      if (candidate) selectedQuery.value = querySelection(candidate);
    };
    worker.onerror = () => {
      busy.value = false;
      result.value = undefined;
      problemState.value = { open: showProblems.value, finalizedProblems: [] };
      failure.value = "The analysis worker could not start. Reload to retry.";
    };
    schedule();
  } catch {
    busy.value = false;
    failure.value = "The playground compiler could not load. Reload to retry.";
  }
});

watch(
  files,
  () => {
    const switchingDialect = watchedDialect !== dialect.value;
    watchedDialect = dialect.value;
    if (worker && !applyingExample && !switchingDialect) {
      lesson.value = "custom";
      notice.value = "";
    }
    // A shared URL is a snapshot. Subsequent edits belong to the saved local workspace.
    if (worker && location.hash.startsWith("#code="))
      history.replaceState(null, "", location.pathname + location.search);
    schedule();
  },
  { deep: true, flush: "sync" },
);
watch(
  () => [activePane.value.id, activeFile.value],
  () => {
    cursor.value = activePane.value.cursors[activeFile.value] ?? -1;
    if (selectedQuery.value?.file !== activeFile.value) {
      const candidate = resolveQuerySelection(result.value?.queries ?? [], activeFile.value);
      selectedQuery.value = candidate ? querySelection(candidate) : undefined;
    }
  },
);
watch(dialect, () => {
  activePaneId.value = editorPanes(layout.value)[0]!.id;
  selectedQuery.value = undefined;
  if (!readonlyFile.value && !(activeFile.value in files.value)) activeFile.value = Object.keys(files.value)[0]!;
});
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("keydown", handlePanelShortcut, true);
  clearTimeout(timer);
  resizeObserver?.disconnect();
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.resolve(undefined);
  }
  pending.clear();
  worker?.terminate();
});
</script>

<template>
  <div class="pg-workspace">
    <div class="pg-accessible-title"><slot name="title" /></div>

    <section ref="shell" class="pg-shell" aria-label="typed-sql playground">
      <header class="pg-toolbar">
        <label class="pg-select"><select v-model="dialect" aria-label="Database grammar"><option v-for="id in PLAYGROUND_DIALECTS" :key="id" :value="id">{{ PLAYGROUND_DIALECT_LABELS[id] }}</option></select></label>
        <span class="pg-divider" />
        <label class="pg-select pg-lesson"><select v-model="lesson" aria-label="Playground example" @change="loadLesson"><option v-if="lesson === 'custom'" value="custom">Custom workspace</option><option v-for="item in availableLessons" :key="item.id" :value="item.id">{{ item.title }}</option></select></label>
        <div class="pg-actions"><button type="button" :disabled="lesson === 'custom'" :title="lesson === 'custom' ? 'Choose an example to reset' : 'Reset example'" @click="loadLesson">↺ Reset</button><button class="pg-share" type="button" @click="share">↗ Share</button></div>
      </header>
      <div class="pg-workbench" :style="layoutStyle">
        <WorkspaceFileTree v-show="showFiles" id="pg-file-tree" :files="fileTabs" :active-file="activeFile" :problems="problemFiles" @select="activeFile = $event" @create="createFile" />
        <PanelResizeHandle v-if="showFiles" v-model="treeWidth" orientation="vertical" :min="120" :max="treeMax" label="Resize file tree" />
        <div class="pg-panels">
        <EditorPaneLayout ref="editor" class="pg-editor-layout" :node="layout" :active="activePane.id" :files="files" :dialect="dialect" :config="configSource" :analysis="result" :busy="busy" :multiple="editorPanes(layout).length > 1" :interact="interact" @focus-pane="focusPane" @select-file="selectPaneFile" @edit="(file, value) => { if (file in files) files[file] = value; }" @inspect="(id, position) => { if (id === activePane.id) inspectAt(position); }" @definition="goToDefinition" @drop-file="dropFile" @close-pane="closePane" @close-file="closeFile" />
        <PanelResizeHandle v-if="showInspector" :model-value="narrow ? inspectorHeight : inspectorWidth" :orientation="narrow ? 'horizontal' : 'vertical'" :min="narrow ? 120 : 240" :max="inspectorMax" reverse label="Resize type inspector" @update:model-value="value => narrow ? inspectorHeight = value : inspectorWidth = value" />
        <aside v-show="showInspector" id="pg-inspector" class="pg-inspector" aria-label="Type inference">
          <WorkspaceTabs v-model="output" :items="outputTabItems" id-prefix="pg-output" panel-id="pg-output-panel" aria-label="Query output" />
          <ScrollArea id="pg-output-panel" class="pg-output" label="Query output" role="tabpanel" :aria-labelledby="`pg-output-${output}`" :aria-busy="busy">
            <template v-if="busy"><div class="pg-empty">Analyzing your workspace…</div></template>
            <template v-else-if="failure"><div class="pg-empty pg-error">{{ failure }}</div></template>
            <template v-else>
              <template v-if="query">
              <template v-if="output === 'contract'">
                <div class="pg-output-heading">Result row</div>
                <pre class="pg-row-type">{{ cleanRow }}</pre>
                <div class="pg-output-heading pg-params-heading">Parameters</div>
                <pre class="pg-param-type">{{ query.parameterType }}</pre>
              </template>
              <template v-else><HighlightedCode :source="query.sql.trim()" language="sql" :dialect="dialect" class="pg-rendered-sql" /></template>
              </template>
              <div v-else class="pg-empty">No query contract for this file.<p>Inspect a symbol or place the cursor inside a query.</p></div>
            </template>
          </ScrollArea>
          <ScrollArea class="pg-type-detail" label="Type at cursor"><div class="pg-output-heading">Type at cursor</div><HighlightedCode v-if="!busy && inspected" :source="inspected.content" /><p v-else>Select a symbol to inspect its type.</p></ScrollArea>
        </aside>
        </div>
      </div>
      <PanelResizeHandle v-if="problems.length && showProblems" v-model="problemsHeight" orientation="horizontal" :min="60" :max="problemsMax" reverse label="Resize problems panel" />
      <ScrollArea v-if="problems.length && showProblems" id="pg-problems" class="pg-problems" label="Problems" :style="{ height: `${Math.min(problemsHeight, problemsMax)}px` }" :aria-busy="busy" aria-label="Workspace problems"><button v-for="(problem, index) in problems" :key="index" type="button" :disabled="busy" @click="focusProblem(problem.file, problem.from, problem.to)"><span class="pg-error">{{ problem.code }}</span><span>{{ problem.message }}</span><small>{{ problem.file }}:{{ problem.line }}</small></button></ScrollArea>
      <footer class="pg-status" aria-label="Editor status and panels">
        <div class="pg-status-group">
          <button class="pg-dock-toggle" type="button" :aria-expanded="showFiles" aria-controls="pg-file-tree" aria-label="Toggle file tree" title="Toggle file tree (Cmd+B)" @click="showFiles = !showFiles"><EditorIcon name="collapse" /></button>
          <button v-if="problems.length" class="pg-error pg-problems-toggle" type="button" :aria-expanded="showProblems" aria-controls="pg-problems" @click="showProblems = !showProblems"><EditorIcon name="chevron" :class="{ 'is-open': showProblems }" /><span>{{ problems.length }} problem{{ problems.length === 1 ? '' : 's' }}</span></button>
          <span v-else :class="{ 'pg-error': failure }" role="status">{{ busy ? 'Checking…' : failure ? 'Analysis unavailable' : 'No problems' }}</span>
          <span v-if="notice" role="status">{{ notice }}</span>
        </div>
        <div class="pg-status-group">
          <span v-if="readonlyFile" class="pg-readonly"><EditorIcon name="lock" />Read only</span>
          <a href="./getting-started/compiler-and-editor" title="The browser uses TypeScript 6; the TypeScript 7 CLI check is authoritative.">Browser TypeScript {{ result?.version ?? '6' }}</a>
          <button class="pg-dock-toggle pg-dock-toggle--right" type="button" :aria-expanded="showInspector" aria-controls="pg-inspector" aria-label="Toggle type inspector" aria-keyshortcuts="Meta+Alt+B Control+Alt+B" title="Toggle type inspector (Cmd+Alt+B; Ctrl+Alt+B in Chrome)" @click="showInspector = !showInspector"><EditorIcon name="collapse" /></button>
        </div>
      </footer>
    </section>

  </div>
</template>
