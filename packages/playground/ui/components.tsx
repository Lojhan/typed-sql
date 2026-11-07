import type { ComponentProps, ReactNode } from "react";
import { Icon, type IconName } from "./icon";
import "./components.css";

const classes = (...values: (string | undefined | false)[]) => values.filter(Boolean).join(" ");
type ButtonProps = ComponentProps<"button"> & {
  iconOnly?: boolean;
  compact?: boolean;
  variant?: "default" | "primary" | "danger" | "row" | "menu" | "link" | "cell" | "tab" | "section";
};

/** Native semantics with one geometry contract for each kind of control. */
export function Button({
  className,
  type = "button",
  variant = "default",
  iconOnly = false,
  compact = false,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={classes("ui-button", iconOnly && "ui-icon-button", className)}
      data-variant={variant}
      data-compact={compact || undefined}
    />
  );
}
export function IconButton({
  className,
  "aria-label": label,
  title = label,
  ...props
}: Omit<ButtonProps, "variant"> & { "aria-label": string }) {
  return <Button {...props} iconOnly aria-label={label} title={title} className={className} />;
}
export function Tab({
  children,
  onClose,
  closeLabel,
  containerProps,
  ...props
}: Omit<ButtonProps, "variant"> & {
  onClose?: () => void;
  closeLabel?: string;
  containerProps?: ComponentProps<"div">;
}) {
  return (
    <div {...containerProps} className={classes("ui-tab", containerProps?.className)}>
      <Button {...props} role="tab" variant="tab">
        {children}
      </Button>
      {onClose ? (
        <IconButton className="tab-close" aria-label={closeLabel ?? "Close tab"} onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      ) : null}
    </div>
  );
}
export function TabBar({ children, actions, className, ...props }: ComponentProps<"div"> & { actions?: ReactNode }) {
  return (
    <Bar className={classes("ui-tabbar", className)} padding="none">
      <div {...props} className="ui-tabs" role="tablist">
        {children}
      </div>
      {actions}
    </Bar>
  );
}
export function TreeButton({ className, ...props }: Omit<ButtonProps, "variant">) {
  return <Button {...props} variant="row" className={classes("ui-tree-row", className)} />;
}
export function TreeSummary({ className, ...props }: ComponentProps<"summary">) {
  return <summary {...props} className={classes("ui-tree-row", className)} />;
}
export function TreeDraftRow({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={classes("ui-tree-row", className)} />;
}
export function TreeLabel({ className, ...props }: ComponentProps<"span">) {
  return <span {...props} className={classes("ui-tree-label", className)} />;
}
export function WorkspaceTab({
  name,
  path = name,
  icon,
  selected,
  dirty,
  onOpen,
  onClose,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  name: string;
  path?: string;
  icon: IconName;
  selected: boolean;
  dirty?: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <Tab
      containerProps={{ ...props, className: classes("pane-tab", selected && "selected", className) }}
      aria-selected={selected}
      title={path}
      onClick={onOpen}
      onClose={onClose}
      closeLabel={`Close ${name}`}
    >
      <Icon name={icon} />
      <span className="ui-tab-label">{name}</span>
      {dirty ? <span className="dirty-mark">●</span> : null}
    </Tab>
  );
}
export function Input({
  className,
  variant = "default",
  ...props
}: ComponentProps<"input"> & { variant?: "default" | "plain" }) {
  return <input {...props} data-variant={variant} className={classes("ui-input", className)} />;
}
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...props} className={classes("ui-select", className)} />;
}
export function TextArea({
  className,
  variant = "default",
  ...props
}: ComponentProps<"textarea"> & { variant?: "default" | "plain" }) {
  return <textarea {...props} data-variant={variant} className={classes("ui-textarea", className)} />;
}
export function FieldLabel({ className, ...props }: ComponentProps<"label">) {
  // biome-ignore lint/a11y/noLabelWithoutControl: callers provide a nested native control or htmlFor through these props.
  return <label {...props} className={classes("ui-field-label", className)} />;
}
export function FormField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <FieldLabel className="ui-form-field">
      <span>{label}</span>
      {children}
    </FieldLabel>
  );
}

/** A single-row section; wrap is explicit for toolbars that must fit narrow panes. */
export function Bar({
  className,
  wrap = false,
  as: Element = "div",
  separator = "bottom",
  padding = "default",
  ...props
}: ComponentProps<"div"> & {
  wrap?: boolean;
  as?: "div" | "header" | "footer";
  separator?: "top" | "bottom" | "none" | "frame";
  padding?: "default" | "none";
}) {
  return (
    <Element
      {...props}
      data-padding={padding}
      data-separator={separator}
      className={classes("ui-bar", wrap && "ui-wrap", className)}
    />
  );
}
export function ControlGroup({ className, wrap = false, ...props }: ComponentProps<"div"> & { wrap?: boolean }) {
  return <div {...props} className={classes("ui-control-group", wrap && "ui-wrap", className)} />;
}
export function BarLabel({
  className,
  truncate = false,
  as: Element = "span",
  ...props
}: ComponentProps<"span"> & { truncate?: boolean; as?: "span" | "strong" }) {
  return <Element {...props} className={classes("ui-bar-label", truncate && "ui-truncate", className)} />;
}
export function View({
  className,
  as: Element = "section",
  ...props
}: ComponentProps<"section"> & { as?: "section" | "main" }) {
  return <Element {...props} className={classes("ui-view", className)} />;
}
export function Panel({
  className,
  padding = "default",
  ...props
}: ComponentProps<"section"> & { padding?: "default" | "none" }) {
  return <section {...props} data-padding={padding} className={classes("ui-panel", className)} />;
}
export function FormPanel({
  className,
  padding = "default",
  ...props
}: ComponentProps<"form"> & { padding?: "default" | "none" }) {
  return <form {...props} data-padding={padding} className={classes("ui-panel", className)} />;
}
export function MenuTrigger({
  className,
  "aria-label": label,
  title = label,
  ...props
}: ComponentProps<"summary"> & { "aria-label": string }) {
  return <summary {...props} aria-label={label} title={title} className={classes("ui-menu-trigger", className)} />;
}
export function MenuSurface({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={classes("ui-menu", className)} />;
}
export function EmptyState({ className, error = false, ...props }: ComponentProps<"div"> & { error?: boolean }) {
  return <div {...props} className={classes("ui-empty", error && "error-empty", className)} />;
}
export function Notice({
  children,
  tone = "info",
  onDismiss,
}: {
  children: ReactNode;
  tone?: "info" | "error" | "warning";
  onDismiss?: () => void;
}) {
  return (
    <Bar
      wrap
      className={classes("workspace-banner", tone !== "info" && tone)}
      role={tone === "error" ? "alert" : "status"}
    >
      <BarLabel>{children}</BarLabel>
      {onDismiss ? (
        <IconButton aria-label={`Dismiss ${tone === "info" ? "notice" : tone}`} onClick={onDismiss}>
          <Icon name="close" />
        </IconButton>
      ) : null}
    </Bar>
  );
}
export function SectionHeader({
  label,
  expanded,
  controls,
  onToggle,
  actions,
  count,
}: {
  label: string;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  actions?: ReactNode;
  count?: number;
}) {
  return (
    <Bar className="tree-heading ui-section-header">
      <Button
        variant="section"
        className="explorer-section-toggle"
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onToggle}
      >
        <Icon name="chevron" />
        <span>{label}</span>
        {count === undefined ? null : <span className="explorer-count">{count}</span>}
      </Button>
      {actions ? <ControlGroup className="tree-actions">{actions}</ControlGroup> : null}
    </Bar>
  );
}
