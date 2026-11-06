import { useEffect, useState } from "react";
export function ThemeSelect() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("typed-sql:theme");
    } catch {}
    return saved === "light" || saved === "dark" ? saved : "system";
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
  return (
    <select
      className="theme-select"
      aria-label="Color theme"
      value={theme}
      onChange={(event) => setTheme(event.target.value as typeof theme)}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}
