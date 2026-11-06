export type IconName =
  | "folder"
  | "file-ts"
  | "file-js"
  | "file-json"
  | "file-sql"
  | "chevron"
  | "new-file"
  | "new-folder"
  | "sidebar"
  | "schema"
  | "compare"
  | "agent"
  | "close"
  | "refresh"
  | "play"
  | "split"
  | "more"
  | "sun"
  | "moon"
  | "system"
  | "command"
  | "connection"
  | "search"
  | "check"
  | "warning"
  | "lock";
export function fileIcon(file: string): IconName {
  if (file.endsWith(".sql")) return "file-sql";
  if (/\.(?:[cm]?js|jsx)$/u.test(file)) return "file-js";
  if (/\.jsonc?$/u.test(file)) return "file-json";
  return "file-ts";
}
/** Same 16px geometry as the documentation editor's EditorIcon. */
export function Icon({ name }: { name: IconName }) {
  const paths: Partial<Record<IconName, string>> = {
    folder: "M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z",
    chevron: "m6 4 4 4-4 4",
    "new-file": "M9.5 1.5H3v13h10V5L9.5 1.5ZM9 1.5v4h4M8 8v4M6 10h4",
    "new-folder": "M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4ZM8 7v4M6 9h4",
    sidebar: "M2 2.5h12v11H2zM6 2.5v11",
    schema: "M2 2h5v4H2zM9 10h5v4H9zM4.5 6v6H9M11.5 10V4H7",
    compare: "M2 5h11l-3-3M14 11H3l3 3",
    agent: "M8 1.5 10 6l4.5 2L10 10 8 14.5 6 10 1.5 8 6 6Z",
    close: "m4 4 8 8M12 4l-8 8",
    refresh: "M13.5 5.5A5.5 5.5 0 1 0 14 9M13.5 2v4H10",
    play: "m5 2.5 8 5.5-8 5.5Z",
    split: "M2 2h12v12H2zM8 2v12",
    more: "M3 8h.01M8 8h.01M13 8h.01",
    moon: "M13.5 10.5A6 6 0 0 1 5.5 2.5a6 6 0 1 0 8 8Z",
    system: "M1.5 2.5h13v9h-13zM5 14h6M8 11.5V14",
    command:
      "M5 5V2.5a1.5 1.5 0 1 0-1.5 1.5H12a1.5 1.5 0 1 0-1.5-1.5V12a1.5 1.5 0 1 0 1.5-1.5H3.5A1.5 1.5 0 1 0 5 12V5Z",
    connection: "M5 1.5v4M11 1.5v4M3 5.5h10M4 5.5v3a4 4 0 0 0 8 0v-3M8 12.5v2",
    search: "M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-1 3 4 4",
    check: "m3 8 3 3 7-7",
    warning: "m8 2 6.5 12h-13L8 2Zm0 4v4M8 12h.01",
    lock: "M4 7h8v7H4zM5.5 7V4a2.5 2.5 0 0 1 5 0v3",
    sun: "M8 1v1M8 14v1M1 8h1M14 8h1M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1",
  };
  return (
    <svg className={`editor-icon icon-${name}`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {["file-ts", "file-js", "file-json"].includes(name) ? (
        <>
          <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" opacity=".13" />
          <text
            x="8"
            y="11"
            textAnchor="middle"
            fill="currentColor"
            fontFamily="ui-monospace,monospace"
            fontSize="8"
            fontWeight="600"
          >
            {name === "file-js" ? "JS" : name === "file-json" ? "{}" : "TS"}
          </text>
        </>
      ) : name === "file-sql" ? (
        <g stroke="currentColor">
          <ellipse cx="8" cy="4" rx="4.5" ry="2" />
          <path d="M3.5 4v7.5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4M3.5 7.5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2" />
        </g>
      ) : (
        <path d={paths[name]} stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "sun" ? <circle cx="8" cy="8" r="3" stroke="currentColor" /> : null}
    </svg>
  );
}
