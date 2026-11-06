import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon.js";
export type Theme = "system" | "light" | "dark";
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("typed-sql:theme");
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    try {
      localStorage.setItem("typed-sql:theme", theme);
    } catch {}
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme] as const;
}
export function ThemeMenu({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: key events bubble from native menu buttons.
    <div
      className="status-theme"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          button.current?.focus();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const items = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      <button
        ref={button}
        className="status-icon"
        type="button"
        aria-label="Color theme"
        title={`Color theme: ${theme}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={theme === "system" ? "system" : theme === "dark" ? "moon" : "sun"} />
      </button>
      {open ? (
        <div className="status-menu" role="menu" aria-label="Color theme">
          {(["system", "light", "dark"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-label={`${value[0]!.toUpperCase() + value.slice(1)} theme`}
              aria-checked={theme === value}
              onClick={() => {
                onChange(value);
                setOpen(false);
                button.current?.focus();
              }}
            >
              <Icon name={value === "system" ? "system" : value === "dark" ? "moon" : "sun"} />
              <span>{value[0]!.toUpperCase() + value.slice(1)}</span>
              {theme === value ? <Icon name="check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
