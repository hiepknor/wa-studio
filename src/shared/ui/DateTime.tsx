import type { HTMLAttributes } from "react";

import {
  formatDateTime,
  formatExactDateTime,
  parseDateTime,
  type DateTimePrecision,
} from "./date-time";
import "./date-time.css";

interface DateTimeProps extends Omit<HTMLAttributes<HTMLTimeElement>, "children"> {
  fallback?: string;
  precision?: DateTimePrecision;
  timeZone?: string;
  value: string | null | undefined;
}

export function DateTime({
  "aria-label": ariaLabel,
  className,
  fallback = "—",
  precision = "minute",
  timeZone,
  title,
  value,
  ...props
}: DateTimeProps) {
  const classes = `date-time ${className ?? ""}`.trim();
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
      {formatDateTime(value, { precision, timeZone })}
    </time>
  );
}
