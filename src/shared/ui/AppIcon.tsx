import {
  Activity,
  CircleAlert,
  Check,
  ChevronDown,
  Copy,
  CloudDownload,
  Ellipsis,
  Info,
  KeyRound,
  PanelsTopLeft,
  Play,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings2,
  TriangleAlert,
  Trash2,
  UsersRound,
  Unplug,
  X,
  type LucideIcon,
} from "lucide-react";

import "./app-icon.css";

export type AppIconName =
  | "activity"
  | "campaigns"
  | "check"
  | "chevron-down"
  | "circle-alert"
  | "close"
  | "copy"
  | "disconnect"
  | "groups"
  | "info"
  | "key"
  | "more"
  | "refresh"
  | "runs"
  | "search"
  | "server"
  | "sessions"
  | "settings"
  | "sync"
  | "triangle-alert"
  | "trash";

export type AppIconSize = "xs" | "sm" | "md" | "lg" | "xl";

interface AppIconProps {
  className?: string;
  name: AppIconName;
  size?: AppIconSize;
}

const ICONS: Record<AppIconName, LucideIcon> = {
  activity: Activity,
  campaigns: Send,
  check: Check,
  "chevron-down": ChevronDown,
  "circle-alert": CircleAlert,
  close: X,
  copy: Copy,
  disconnect: Unplug,
  groups: UsersRound,
  info: Info,
  key: KeyRound,
  more: Ellipsis,
  refresh: RefreshCw,
  runs: Play,
  search: Search,
  server: Server,
  sessions: PanelsTopLeft,
  settings: Settings2,
  sync: CloudDownload,
  "triangle-alert": TriangleAlert,
  trash: Trash2,
};

const ICON_SIZES: Record<AppIconSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
};

export function AppIcon({ className = "", name, size = "md" }: AppIconProps) {
  const Icon = ICONS[name];
  return (
    <Icon
      aria-hidden="true"
      className={`ui-icon ui-icon-${size} ${className}`.trim()}
      focusable="false"
      size={ICON_SIZES[size]}
      strokeWidth={1.5}
    />
  );
}
