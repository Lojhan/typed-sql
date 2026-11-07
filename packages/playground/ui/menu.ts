import { type RefObject, useEffect, useRef } from "react";

/** Shared keyboard and dismissal behavior for local action menus. */
export function useMenu(open: boolean, onClose: () => void, launcher?: RefObject<HTMLElement | null>) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || !menu.current) return;
    const element = menu.current;
    const previous =
      launcher?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const items = () => [...element.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];
    items()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        if (previous?.isConnected) previous.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const choices = items();
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? choices.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
        choices[next]?.focus();
      } else if (event.key === "Tab") close.current();
    };
    const outside = (event: Event) => {
      if (event.target instanceof Node && !element.contains(event.target) && !launcher?.current?.contains(event.target))
        close.current();
    };
    const blur = () => close.current();
    element.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("blur", blur);
    return () => {
      element.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("blur", blur);
    };
  }, [open, launcher]);
  return menu;
}
