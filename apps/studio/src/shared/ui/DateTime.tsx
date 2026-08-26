import type { HTMLAttributes } from "react";

import {
  formatDateTime,
  formatExactDateTime,
  formatRelativeDateTime,
  parseDateTime,
  type DateTimePrecision,
} from "./date-time";
import "./date-time.css";

interface DateTimeProps extends Omit<HTMLAttributes<HTMLTimeElement>, "children"> {
  fallback?: string;
  precision?: DateTimePrecision;
  timeZone?: string;
  value: string | null | undefined;
  variant?: "absolute" | "relative";
}

export function DateTime({
  "aria-label": ariaLabel,
  className,
  fallback = "—",
  precision = "minute",
  timeZone,
  title,
  value,
  variant = "absolute",
  ...props
}: DateTimeProps) {
  const classes = `date-time date-time-${variant} ${className ?? ""}`.trim();
  const date = parseDateTime(value);
  if (!date || !value) return <span className={classes}>{fallback}</span>;

  const exact = formatExactDateTime(value, timeZone);
  return (
    <time
      {...props}
      aria-label={ariaLabel ?? exact}
      className={classes}
      dateTime={date.toISOString()}
      title={title ?? exact}
    >
      {variant === "relative"
        ? formatRelativeDateTime(value, { fallback, timeZone })
        : formatDateTime(value, { precision, timeZone })}
    </time>
  );
}
