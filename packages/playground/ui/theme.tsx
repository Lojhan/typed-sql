import { useEffect, useRef, useState } from "react";
import { Button, IconButton, MenuSurface } from "./components";
import { Icon } from "./icon.js";
import { useMenu } from "./menu";
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
  const button = useRef<HTMLButtonElement>(null);
  const menu = useMenu(open, () => setOpen(false), button);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: key events bubble from native menu buttons.
    <div
      className="status-theme"
      onKeyDown={(event) => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    >
      <IconButton
        ref={button}
        className="status-icon"
        aria-label="Color theme"
        title={`Color theme: ${theme}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={theme === "system" ? "system" : theme === "dark" ? "moon" : "sun"} />
      </IconButton>
      {open ? (
        <MenuSurface ref={menu} className="status-menu" role="menu" aria-label="Color theme">
          {(["system", "light", "dark"] as const).map((value) => (
            <Button
              variant="menu"
              key={value}
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
            </Button>
          ))}
        </MenuSurface>
      ) : null}
    </div>
  );
}
