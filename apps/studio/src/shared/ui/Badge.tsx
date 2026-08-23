import type { HTMLAttributes, ReactNode } from "react";

import type { FeedbackTone } from "./feedback-tone";
import "./badge.css";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: FeedbackTone;
}

export function Badge({ children, className = "", tone = "neutral", ...props }: BadgeProps) {
  return (
    <span {...props} className={`ui-badge ui-badge-${tone} ${className}`.trim()}>
      {children}
    </span>
  );
}
