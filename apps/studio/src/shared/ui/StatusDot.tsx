import type { HTMLAttributes } from "react";

import type { FeedbackTone } from "./feedback-tone";
import "./status-dot.css";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  glow?: boolean;
  size?: "sm" | "md";
  tone?: FeedbackTone;
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
