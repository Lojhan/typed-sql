import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton } from "./components";
import { Icon, type IconName } from "./icon";
import "./toolbar-actions.css";

/** Secondary actions use the browser's top layer, escaping clipped editor/result panes. */
export function ToolbarActions({
  children,
  label,
  collapseBelow = 560,
  icon = "more",
  trigger,
  className = "",
  closeOnChange = false,
}: {
  children: ReactNode;
  label: string;
  collapseBelow?: number;
  icon?: IconName;
  trigger?: ReactNode;
  className?: string;
  closeOnChange?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLFieldSetElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [compact, setCompact] = useState(true);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const container = root.current?.closest(".ui-bar") ?? root.current?.parentElement;
    if (!container) return;
    const measure = () => {
      popup.current?.matches(":popover-open") && popup.current.hidePopover();
      setCompact(container.clientWidth < collapseBelow);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [collapseBelow]);
  const toggle = () => {
    const element = popup.current,
      button = launcher.current;
    if (!element || !button) return;
    if (element.matches(":popover-open")) {
      element.hidePopover();
      return;
    }
    element.showPopover();
    const box = button.getBoundingClientRect(),
      menu = element.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    const top = below >= menu.height + 8 || below >= box.top ? box.bottom + 4 : box.top - menu.height - 4;
    element.style.left = `${Math.max(8, Math.min(box.right - menu.width, window.innerWidth - menu.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(top, window.innerHeight - menu.height - 8))}px`;
  };
  return (
    <div ref={root} className={`toolbar-actions ${compact ? "is-overflow" : ""} ${className}`}>
      {trigger ? (
        <Button ref={launcher} aria-label={label} aria-expanded={open} aria-controls={id} onClick={toggle}>
          {trigger}
        </Button>
      ) : (
        <IconButton ref={launcher} aria-label={label} aria-expanded={open} aria-controls={id} onClick={toggle}>
          <Icon name={icon} />
        </IconButton>
      )}
      <fieldset
        ref={popup}
        aria-label={`${label} controls`}
        id={id}
        popover={compact ? "auto" : undefined}
        className={`toolbar-actions-content ${compact ? "ui-menu" : ""}`}
        onChange={() => {
          if (closeOnChange && popup.current?.matches(":popover-open")) {
            popup.current.hidePopover();
            launcher.current?.focus();
          }
        }}
        onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))}
        onKeyDown={(event) => {
          if (event.key === "Escape" && popup.current?.matches(":popover-open")) {
            popup.current.hidePopover();
            launcher.current?.focus();
            event.stopPropagation();
          }
        }}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("button") &&
            popup.current?.matches(":popover-open")
          )
            popup.current.hidePopover();
        }}
      >
        {children}
      </fieldset>
    </div>
  );
}
