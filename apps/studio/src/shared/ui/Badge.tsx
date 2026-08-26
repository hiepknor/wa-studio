import type { HTMLAttributes, ReactNode } from "react";

import { AppIcon } from "./AppIcon";
import type { FeedbackTone } from "./feedback-tone";
import "./badge.css";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: FeedbackTone;
  variant?: "label" | "status";
}

export function Badge({
  children,
  className = "",
  tone = "neutral",
  variant = "label",
  ...props
}: BadgeProps) {
  const alertIndicator = variant === "status" && (tone === "warning" || tone === "danger");

  return (
    <span
      {...props}
      className={`ui-badge ui-badge-${tone} ui-badge-${variant} ${className}`.trim()}
      data-tone={tone}
      data-variant={variant}
    >
      {variant === "status" && (
        alertIndicator
          ? <AppIcon className="ui-badge-icon" name="triangle-alert" size="xs" />
          : <span aria-hidden="true" className="ui-badge-dot" />
      )}
      {children}
    </span>
  );
}
