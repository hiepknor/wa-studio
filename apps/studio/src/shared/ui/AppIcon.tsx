import {
  Copy,
  CloudDownload,
  Eye,
  KeyRound,
  PencilLine,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import "./app-icon.css";

export type AppIconName =
  | "activity"
  | "campaigns"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "circle-alert"
  | "close"
  | "copy"
  | "disconnect"
  | "edit"
  | "groups"
  | "info"
  | "key"
  | "list-plus"
  | "more"
  | "refresh"
  | "runs"
  | "search"
  | "server"
  | "sessions"
  | "settings"
  | "sync"
  | "triangle-alert"
  | "trash"
  | "view";

export type AppIconSize = "xs" | "sm" | "md" | "lg";

export interface AppIconProps {
  className?: string;
  name: AppIconName;
  size?: AppIconSize;
}

const FALLBACK_ICONS: Partial<Record<AppIconName, LucideIcon>> = {
  copy: Copy,
  edit: PencilLine,
  key: KeyRound,
  refresh: RefreshCw,
  sync: CloudDownload,
  trash: Trash2,
  view: Eye,
};

// Product-owned WARP icons keep core navigation, selector, and state
// silhouettes independent from third-party icon packages.
const WARP_ICONS: Partial<Record<AppIconName, ReactNode>> = {
  activity: <path d="M3 12h4l2-6 4 12 2-6h6" />,
  campaigns: (
    <>
      <path d="m4 13 13-7v12L4 13Z" />
      <path d="M8 15v4h4v-2M17 10h3M18 5l2-2M18 18l2 2" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  "chevron-down": <path d="m9 18 6-6-6-6" transform="rotate(90 12 12)" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "circle-alert": (
    <>
      <path d="M12 3 2.7 20h18.6L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  disconnect: <path d="M5 16.5a8 8 0 0 1 11.5-9M8.5 19.5a4.6 4.6 0 0 1 4.8-6.8M12 22h.01M3 3l18 18" />,
  groups: (
    <>
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9" r="2" />
      <path d="M3.5 19c.4-3.2 2.3-5 5.5-5s5.1 1.8 5.5 5M14 15c3.5-.7 5.7.7 6.5 4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  "list-plus": (
    <>
      <path d="M4 6h10M4 12h8M4 18h7" />
      <path d="M17 13v6M14 16h6" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  runs: (
    <>
      <path d="m9 6 9 6-9 6V6Z" />
      <circle cx="12" cy="12" r="10" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m16 16 5 5" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="6" rx="2" />
      <rect x="4" y="14" width="16" height="6" rx="2" />
      <path d="M8 7h.01M8 17h.01M12 7h5M12 17h5" />
    </>
  ),
  sessions: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m7 10 2 2-2 2M12 15h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  "triangle-alert": (
    <>
      <path d="M12 3 2.7 20h18.6L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
};

const ICON_SIZES: Record<AppIconSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
};

export function AppIcon({ className = "", name, size = "md" }: AppIconProps) {
  const warpIcon = WARP_ICONS[name];
  const classes = `ui-icon ui-icon-${size} ${className}`.trim();
  if (warpIcon) {
    return (
      <svg
        aria-hidden="true"
        className={classes}
        focusable="false"
        height={ICON_SIZES[size]}
        viewBox="0 0 24 24"
        width={ICON_SIZES[size]}
      >
        {warpIcon}
      </svg>
    );
  }

  const Icon = FALLBACK_ICONS[name];
  if (!Icon) return null;
  return (
    <Icon
      aria-hidden="true"
      className={classes}
      focusable="false"
      size={ICON_SIZES[size]}
      strokeWidth={1.7}
    />
  );
}
