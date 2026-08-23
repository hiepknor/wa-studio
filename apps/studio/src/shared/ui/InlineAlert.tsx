import type { HTMLAttributes, ReactNode } from "react";

import { feedbackRole, type FeedbackTone } from "./feedback-tone";
import { StatusDot } from "./StatusDot";
import "./inline-alert.css";

interface InlineAlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  action?: ReactNode;
  children?: ReactNode;
  indicator?: boolean;
  title: ReactNode;
  tone?: FeedbackTone;
}

export function InlineAlert({
  action,
  children,
  className = "",
  indicator = false,
  role,
  title,
  tone = "danger",
  ...props
}: InlineAlertProps) {
  return (
    <div
      {...props}
      className={`inline-alert inline-alert-${tone} ${className}`.trim()}
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
