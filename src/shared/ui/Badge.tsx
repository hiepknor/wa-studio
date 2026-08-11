import type { HTMLAttributes, ReactNode } from "react";

import type { StatusTone } from "./StatusIndicator";
import "./badge.css";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: StatusTone;
}

export function Badge({ children, className = "", tone = "neutral", ...props }: BadgeProps) {
  return (
    <span {...props} className={`ui-badge ui-badge-${tone} ${className}`.trim()}>
      {children}
    </span>
  );
}
