import { useMemo, useState } from "react";
import { matchCommand } from "./command-model.js";
import { Icon, type IconName } from "./icon.js";
import { Modal } from "./modal.js";
export interface PaletteCommand {
  id: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  run: () => void;
}
export function CommandPalette({
  files,
  commands,
  onFile,
  onClose,
}: {
  files: string[];
  commands: PaletteCommand[];
  onFile: (file: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(0);
  const items = useMemo(() => {
    const commandOnly = query.startsWith(">");
    const term = commandOnly ? query.slice(1) : query;
    const choices = [
      ...(!commandOnly
        ? files.map((file) => ({
            id: `file:${file}`,
            label: file,
            icon: (file.endsWith(".sql") ? "file-sql" : "file-ts") as IconName,
            group: "Files",
            shortcut: "",
            run: () => onFile(file),
          }))
        : []),
      ...commands.map((command) => ({ ...command, group: "Commands", shortcut: command.shortcut ?? "" })),
    ];
    const ranked = choices
      .map((item) => ({ item, score: matchCommand(item.label, term) }))
      .filter((entry): entry is { item: (typeof choices)[number]; score: number } => entry.score !== null)
      .sort(
        (a, b) =>
          (a.item.group === b.item.group ? 0 : a.item.group === "Files" ? -1 : 1) ||
          a.score - b.score ||
          a.item.label.localeCompare(b.item.label),
      )
      .map(({ item }) => item);
    const counts = new Map<string, number>();
    return ranked.filter((item) => {
      const count = counts.get(item.group) ?? 0;
      counts.set(item.group, count + 1);
      return count < 40;
    });
  }, [query, files, commands, onFile]);
  const active = Math.min(selected, Math.max(0, items.length - 1));
  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    onClose();
    requestAnimationFrame(item.run);
  };
  return (
    <Modal label="Command palette" className="command-palette" onClose={onClose}>
      <div className="palette-search">
        <Icon name="search" />
        <input
          role="combobox"
          aria-label="Search files and commands"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="palette-options"
          aria-activedescendant={items.length ? `palette-option-${active}` : undefined}
          placeholder="Search files and commands"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const next = items.length
                ? (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
                : 0;
              setSelected(next);
              document.getElementById(`palette-option-${next}`)?.scrollIntoView({ block: "nearest" });
            }
            if (event.key === "Enter") {
              event.preventDefault();
              choose(active);
            }
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div id="palette-options" className="palette-options" role="listbox" aria-label="Files and commands">
        {items.map((item, index) => (
          <div key={item.id}>
            {index === 0 || items[index - 1]?.group !== item.group ? (
              <div className="palette-group">{item.group}</div>
            ) : null}
            <button
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={active === index}
              id={`palette-option-${index}`}
              className={active === index ? "selected" : ""}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setSelected(index)}
              onClick={() => choose(index)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
            </button>
          </div>
        ))}
        {!items.length ? <div className="quiet-empty">No matching files or commands.</div> : null}
      </div>
      <div className="palette-hint">
        <span>↑ ↓ navigate · Enter open</span>
        <span>Type &gt; for commands</span>
      </div>
    </Modal>
  );
}
