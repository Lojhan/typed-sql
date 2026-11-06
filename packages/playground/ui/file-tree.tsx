import { useEffect, useRef, useState } from "react";
import { fileIcon, Icon } from "./icon";
import { FILE_MIME, fileTree, type TreeNode } from "./layout";

interface Draft {
  parent: string;
  folder: boolean;
  name: string;
  error: string;
}
export function WorkspaceFileTree({
  files,
  folders,
  selected,
  project,
  scratch,
  onOpen,
  onCreate,
  creation,
}: {
  files: string[];
  folders: string[];
  selected: string;
  project: string;
  scratch: string;
  onOpen: (path: string) => void;
  onCreate: (path: string, folder: boolean) => Promise<void>;
  creation?: { id: string; folder: boolean } | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [parent, setParent] = useState(scratch),
    [draft, setDraft] = useState<Draft | null>(null),
    [menu, setMenu] = useState<{ x: number; y: number; parent: string } | null>(null),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const seenCreation = useRef("");
  useEffect(() => {
    if (!creation || seenCreation.current === creation.id) return;
    seenCreation.current = creation.id;
    setCollapsed(false);
    setDraft({ parent, folder: creation.folder, name: creation.folder ? "" : "query.ts", error: "" });
    setMenu(null);
  }, [creation, parent]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editIdentity = draft ? `${draft.parent}:${draft.folder}` : "";
  useEffect(() => {
    if (!editIdentity) return;
    const current = draftRef.current;
    if (!current) return;
    input.current?.focus();
    const end = current.folder ? current.name.length : current.name.lastIndexOf(".");
    input.current?.setSelectionRange(0, end > 0 ? end : current.name.length);
  }, [editIdentity]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  const begin = (folder: boolean, where = parent) => {
    setCollapsed(false);
    setParent(where);
    setDraft({ parent: where, folder, name: folder ? "" : "query.ts", error: "" });
    setMenu(null);
  };
  const submit = async () => {
    if (!draft || busy) return;
    const name = draft.name.trim();
    if (!name || name.split("/").some((part) => !part || part === ".." || part === ".") || name.includes("\\")) {
      setDraft({ ...draft, error: "Enter a relative name without . or .. segments." });
      return;
    }
    const path = [draft.parent, name].filter(Boolean).join("/");
    setBusy(true);
    try {
      await onCreate(path, draft.folder);
      setDraft(null);
    } catch (error) {
      setDraft({ ...draft, error: error instanceof Error ? error.message : String(error) });
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  const allFolders = [...new Set([...folders, ...(draft?.parent ? [draft.parent] : [])])];
  const tree = fileTree(files, allFolders);
  const editor = (where: string, depth: number) =>
    draft?.parent === where ? (
      <li className="tree-draft" key="draft">
        <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
          <span />
          <Icon name={draft.folder ? "folder" : fileIcon(draft.name)} />
          <input
            ref={input}
            aria-label={draft.folder ? "New folder name" : "New file name"}
            aria-invalid={!!draft.error}
            aria-describedby={draft.error ? "tree-name-error" : undefined}
            value={draft.name}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setDraft({ ...draft, name: event.target.value, error: "" })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
              }
            }}
            onBlur={() => {
              if (!busy) setDraft(null);
            }}
          />
        </div>
        {draft.error ? (
          <p id="tree-name-error" role="alert">
            {draft.error}
          </p>
        ) : null}
      </li>
    ) : null;
  const rows = (nodes: TreeNode[], where: string, depth = 0) => (
    <ul className="file-tree">
      {editor(where, depth)}
      {nodes.map((node) => (
        <li key={node.path}>
          {node.file ? (
            <button
              type="button"
              className={`tree-row ${selected === node.path ? "selected" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              title={node.path}
              aria-current={selected === node.path ? "page" : undefined}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(FILE_MIME, JSON.stringify({ tab: node.path }));
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => {
                setParent(node.path.split("/").slice(0, -1).join("/"));
                onOpen(node.path);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setParent(where);
                setMenu({ x: event.clientX, y: event.clientY, parent: where });
              }}
            >
              <span />
              <Icon name={fileIcon(node.path)} />
              <span className="tree-name">{node.name}</span>
            </button>
          ) : (
            <details open key={`${node.path}:${draft?.parent === node.path}`}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: native summary supports keyboard activation and context menu. */}
              <summary
                className={`tree-row ${parent === node.path ? "selected-folder" : ""}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={node.path}
                onClick={() => setParent(node.path)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setParent(node.path);
                  setMenu({ x: event.clientX, y: event.clientY, parent: node.path });
                }}
              >
                <Icon name="chevron" />
                <Icon name="folder" />
                <span className="tree-name">{node.name}</span>
              </summary>
              {rows(node.children, node.path, depth + 1)}
            </details>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <div className="tree-heading">
        <button
          type="button"
          className="explorer-section-toggle"
          aria-expanded={!collapsed}
          aria-controls="workspace-project-files"
          onClick={() => {
            setCollapsed((value) => !value);
            setMenu(null);
          }}
        >
          <Icon name="chevron" />
          <span>Files</span>
        </button>
        <div className="tree-actions">
          <button
            type="button"
            title={`New file in ${parent || project}`}
            aria-label="New file"
            onClick={() => begin(false)}
          >
            <Icon name="new-file" />
          </button>
          <button
            type="button"
            title={`New folder in ${parent || project}`}
            aria-label="New folder"
            onClick={() => begin(true)}
          >
            <Icon name="new-folder" />
          </button>
        </div>
      </div>
      <nav
        id="workspace-project-files"
        hidden={collapsed}
        aria-label="Project files"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, parent });
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left + 16, y: rect.top + 16, parent });
          }
        }}
      >
        {rows(tree, "")}
      </nav>
      {menu ? (
        <div
          className="tree-menu"
          role="menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 90) }}
        >
          <button
            type="button"
            role="menuitem"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => begin(false, menu.parent)}
          >
            <Icon name="new-file" />
            New File…
          </button>
          <button
            type="button"
            role="menuitem"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => begin(true, menu.parent)}
          >
            <Icon name="new-folder" />
            New Folder…
          </button>
        </div>
      ) : null}
    </>
  );
}
