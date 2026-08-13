import type { HTMLAttributes, ReactNode } from "react";

import "./inline-alert.css";

interface InlineAlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  action?: ReactNode;
  children?: ReactNode;
  title: ReactNode;
  tone?: "info" | "success" | "warning" | "danger";
}

export function InlineAlert({
  action,
  children,
  className = "",
  role,
  title,
  tone = "danger",
  ...props
}: InlineAlertProps) {
  return (
    <div
      {...props}
      className={`inline-alert inline-alert-${tone} ${className}`.trim()}
      role={role ?? (tone === "danger" ? "alert" : "status")}
    >
      <div className="inline-alert-copy">
        <strong>{title}</strong>
        {children && <span>{children}</span>}
      </div>
      {action && <div className="inline-alert-action">{action}</div>}
    </div>
  );
}
