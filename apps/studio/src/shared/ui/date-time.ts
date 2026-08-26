export type DateTimePrecision = "minute" | "second";

export interface FormatDateTimeOptions {
  fallback?: string;
  precision?: DateTimePrecision;
  timeZone?: string;
  withTimeZone?: boolean;
}

const LOCALE = "en-GB";
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function parseDateTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatter({
  precision = "minute",
  timeZone,
  withTimeZone = false,
}: FormatDateTimeOptions): Intl.DateTimeFormat {
  const key = `${precision}:${timeZone ?? "local"}:${withTimeZone}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;

  const next = new Intl.DateTimeFormat(LOCALE, {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "short",
    ...(precision === "second" ? { second: "2-digit" as const } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(withTimeZone ? { timeZoneName: "shortOffset" as const } : {}),
    year: "numeric",
  });
  formatterCache.set(key, next);
  return next;
}

export function formatDateTime(
  value: string | null | undefined,
  options: FormatDateTimeOptions = {},
): string {
  const date = parseDateTime(value);
  if (!date) return options.fallback ?? "—";

  const parts = new Map(
    formatter(options).formatToParts(date).map((part) => [part.type, part.value]),
  );
  const seconds = options.precision === "second" ? `:${parts.get("second")}` : "";
  const timeZone = options.withTimeZone ? ` ${parts.get("timeZoneName")}` : "";
  return `${parts.get("day")} ${parts.get("month")} ${parts.get("year")} · ${parts.get("hour")}:${parts.get("minute")}${seconds}${timeZone}`;
}

export function formatRelativeDateTime(
  value: string | null | undefined,
  {
    fallback = "—",
    now = new Date(),
    timeZone,
  }: {
    fallback?: string;
    now?: Date;
    timeZone?: string;
  } = {},
): string {
  const date = parseDateTime(value);
  if (!date) return fallback;

  const elapsedMs = Math.max(0, now.getTime() - date.getTime());
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return "Just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`;

  const elapsedHours = Math.floor(elapsedMs / 3_600_000);
  if (elapsedHours < 24) return `${elapsedHours} hr ago`;

  const timeFormatter = new Intl.DateTimeFormat(LOCALE, {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
  if (elapsedHours < 48) return `Yesterday, ${timeFormatter.format(date)}`;

  const elapsedDays = Math.floor(elapsedMs / 86_400_000);
  if (elapsedDays < 7) return `${elapsedDays} days ago`;

  const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
    day: "2-digit",
    month: "short",
    ...(timeZone ? { timeZone } : {}),
  });
  return `${dateFormatter.format(date)}, ${timeFormatter.format(date)}`;
}

export function formatExactDateTime(
  value: string,
  timeZone?: string,
): string {
  return formatDateTime(value, {
    precision: "second",
    timeZone,
    withTimeZone: true,
  });
}
