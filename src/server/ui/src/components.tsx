import { useEffect, useId, useRef, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { nextDialogFocusIndex } from "./dialog-focus";

export function Button({
  children,
  icon,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; variant?: "primary" | "danger" | "ghost"; size?: "sm" }) {
  return (
    <button className={["btn", variant, size].filter(Boolean).join(" ")} {...props}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, selected, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; selected?: boolean }) {
  return (
    <button className={["icon-btn", selected ? "sel" : "", className].filter(Boolean).join(" ")} {...props}>
      <Icon name={icon} />
    </button>
  );
}

export function Card({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {title ? <div className="section-title">{title}</div> : null}
      {children}
    </section>
  );
}

export function Counter({ children, live }: { children: ReactNode; live?: boolean }) {
  return <span className={`counter${live ? " live" : ""}`}>{children}</span>;
}

export function StateBadge({ status }: { status?: string | null }) {
  const cls = ["running", "done", "partial", "error", "killed"].includes(status ?? "") ? status : "none";
  const label = {
    running: "Running",
    done: "Done",
    partial: "Partial",
    error: "Error",
    killed: "Killed",
  }[status ?? ""] ?? (status ? status.slice(0, 1).toUpperCase() + status.slice(1) : "No runs");
  return <span className={`state ${cls}`}>{label}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`label s-${status}`}>{status}</span>;
}

const DIALOG_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useDialogFocus(onClose: () => void) {
  const dialogRef = useRef<HTMLElement | null>(null);
  // Capture during render, before React's commit phase applies descendant
  // autoFocus. A passive effect would otherwise remember the dialog input
  // instead of the control that opened the dialog.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLElement>(DIALOG_FOCUSABLE) ?? dialog).focus();
    }
    return () => {
      if (openerRef.current?.isConnected) openerRef.current.focus();
    };
  }, []);

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)]
      .filter((element) => element.getAttribute("aria-hidden") !== "true");
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = nextDialogFocusIndex(activeIndex, focusable.length, event.shiftKey);
    event.preventDefault();
    if (nextIndex < 0) dialog.focus();
    else focusable[nextIndex]?.focus();
  };
  return { dialogRef, onDialogKeyDown };
}

export function Modal({ title, children, footer, wide, project, onClose }: { title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; project?: boolean; onClose: () => void }) {
  const titleId = useId();
  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  return (
    <div className="modal-back" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} tabIndex={-1} onKeyDown={onDialogKeyDown} className={["modal", wide ? "report-dlg" : "", project ? "project-dlg" : ""].filter(Boolean).join(" ")} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dlg-head">
          <span className="dlg-title" id={titleId}>{title}</span>
          <IconButton icon="x" title="Close" aria-label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="dlg-foot">{footer}</div> : null}
      </section>
    </div>
  );
}
