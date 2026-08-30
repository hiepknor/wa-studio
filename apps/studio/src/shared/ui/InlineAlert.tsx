import type { HTMLAttributes, ReactNode } from "react";

import { feedbackRole, type FeedbackTone } from "./feedback-tone";
import { StatusDot } from "./StatusDot";
import "./inline-alert.css";

export interface InlineAlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  action?: ReactNode;
  children?: ReactNode;
  indicator?: boolean;
  layout?: "inline" | "stacked";
  title: ReactNode;
  tone?: FeedbackTone;
  variant?: "flush" | "panel" | "quiet";
}

export function InlineAlert({
  action,
  children,
  className = "",
  indicator = false,
  layout = "inline",
  role,
  title,
  tone = "danger",
  variant = "panel",
  ...props
}: InlineAlertProps) {
  return (
    <div
      {...props}
      className={`inline-alert inline-alert-${tone} ${className}`.trim()}
      data-has-action={Boolean(action) || undefined}
      data-has-indicator={indicator || undefined}
      data-layout={layout}
      data-variant={variant}
      role={role ?? feedbackRole(tone)}
    >
      {indicator && <StatusDot glow tone={tone} />}
      <div className="inline-alert-copy">
        <strong>{title}</strong>
        {children && <span>{children}</span>}
      </div>
      {action && <div className="inline-alert-action">{action}</div>}
    </div>
  );
}
