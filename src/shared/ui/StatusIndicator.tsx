import type { HTMLAttributes, ReactNode } from "react";

import type { FeedbackTone } from "./feedback-tone";
import "./status-indicator.css";

export type StatusTone = FeedbackTone;

interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  glow?: boolean;
  size?: "sm" | "md";
  tone?: StatusTone;
}

interface StatusIndicatorProps extends StatusDotProps {
  children: ReactNode;
}

export function StatusDot({
  className = "",
  glow = false,
  size = "sm",
  tone = "neutral",
  ...props
}: StatusDotProps) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={`status-dot status-dot-${size} status-tone-${tone} ${glow ? "status-dot-glow" : ""} ${className}`.trim()}
    />
  );
}

export function StatusIndicator({
  children,
  className = "",
  glow = false,
  size = "sm",
  tone = "neutral",
  ...props
}: StatusIndicatorProps) {
  return (
    <span
      {...props}
      className={`status-indicator status-indicator-${size} status-tone-${tone} ${className}`.trim()}
    >
      <StatusDot glow={glow} size={size} tone={tone} />
      <span>{children}</span>
    </span>
  );
}
