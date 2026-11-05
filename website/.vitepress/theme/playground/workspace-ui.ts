import { ENVIRONMENT_FILE } from "./environment-model.js";
import type { PlaygroundDialect } from "./playground.js";
import { WORKSPACE_LIMITS, type WorkspaceFiles } from "./workspace.js";

// Reserved virtual path: displayed in the tree but never sent to analysis or persistence.
export const WORKSPACE_CONFIG_PATH = "__playground__/config.ts";
export const WORKSPACE_CONFIG_NAME = "playground.config.ts";

export const BROWSER_COMPILER_SETTINGS = {
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  moduleDetection: "Force",
  strict: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  allowSyntheticDefaultImports: false,
  lib: ["lib.es2022.d.ts"],
} as const;

export function workspaceConfigSource(dialect: PlaygroundDialect, files: WorkspaceFiles): string {
  const paths = Object.keys(files).sort();
  return `// Read-only configuration for this browser playground.\n// SQL imports are playground query factories; SQL is not executed.\nexport default ${JSON.stringify(
    {
      dialect,
      sqlModule: `@typed-sql/${dialect}`,
      sqlFiles: paths.filter((path) => path.endsWith(".sql")),
      typescriptFiles: paths.filter((path) => path.endsWith(".ts")),
      typePolicy: "grammar defaults",
      engineSettings: files[ENVIRONMENT_FILE] === undefined ? "grammar defaults" : ENVIRONMENT_FILE,
      compilerOptions: BROWSER_COMPILER_SETTINGS,
      limits: WORKSPACE_LIMITS,
    },
    null,
    2,
  )};\n`;
}

export function panelShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
): "files" | "inspector" | undefined {
  if (
    event.isComposing ||
    event.shiftKey ||
    event.metaKey === event.ctrlKey ||
    (event.code !== "KeyB" && event.key.toLowerCase() !== "b")
  )
    return undefined;
  return event.altKey ? "inspector" : "files";
}

export type WorkspacePanel = "files" | "inspector";
export interface WorkspacePanelState {
  desktop: Record<WorkspacePanel, boolean>;
  mobile: WorkspacePanel | null;
}
export function visibleWorkspacePanels(state: WorkspacePanelState, mobile: boolean): Record<WorkspacePanel, boolean> {
  return mobile ? { files: state.mobile === "files", inspector: state.mobile === "inspector" } : state.desktop;
}
export function toggleWorkspacePanel(
  state: WorkspacePanelState,
  panel: WorkspacePanel,
  mobile: boolean,
): WorkspacePanelState {
  return mobile
    ? { ...state, mobile: state.mobile === panel ? null : panel }
    : { ...state, desktop: { ...state.desktop, [panel]: !state.desktop[panel] } };
}
