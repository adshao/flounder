import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./icons";

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

export function Modal({ title, children, footer, wide, project, onClose }: { title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; project?: boolean; onClose: () => void }) {
  return (
    <div className="modal-back" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={["modal", wide ? "report-dlg" : "", project ? "project-dlg" : ""].filter(Boolean).join(" ")} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Dialog"}>
        <div className="dlg-head">
          <span className="dlg-title">{title}</span>
          <IconButton icon="x" title="Close" aria-label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="dlg-foot">{footer}</div> : null}
      </section>
    </div>
  );
}
