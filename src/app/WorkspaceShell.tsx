import { useState } from "react";

import { useRuntimeConnection } from "./RuntimeConnectionContext";
import { SessionSwitcher } from "./SessionSwitcher";
import {
  DEFAULT_WORKSPACE_PAGE,
  WORKSPACE_SECTIONS,
  type WorkspacePageId,
} from "./workspace-pages";
import { SessionsScreen } from "@/features/sessions/SessionsScreen";
import { GroupsScreen } from "@/features/groups/GroupsScreen";
import { AppIcon, type AppIconName } from "@/shared/ui/AppIcon";
import { BrandMark } from "@/shared/ui/BrandMark";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/shared/ui/DropdownMenu";
import { StatusDot, StatusIndicator, type StatusTone } from "@/shared/ui/StatusIndicator";

const PAGE_ICONS: Record<WorkspacePageId, AppIconName> = {
  activity: "activity",
  campaigns: "campaigns",
  groups: "groups",
  runs: "runs",
  sessions: "sessions",
  settings: "settings",
};

function sessionTone(status: string | undefined): StatusTone {
  if (status === "ready") return "success";
  if (status === "failed" || status === "disconnected") return "danger";
  if (status === "initializing" || status === "authenticating") return "warning";
  return "neutral";
}

function formatSyncTime(value: string | null | undefined): string {
  if (!value) return "not synced";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function renderPage(pageId: WorkspacePageId) {
  switch (pageId) {
    case "groups":
      return <GroupsScreen />;
    case "sessions":
      return <SessionsScreen />;
    default:
      throw new Error(`Workspace page is not implemented: ${pageId}`);
  }
}

export function WorkspaceShell() {
  const {
    connected,
    disconnect,
    selectedSessionId,
    selectSession,
  } = useRuntimeConnection();
  const [activePage, setActivePage] = useState<WorkspacePageId>(DEFAULT_WORKSPACE_PAGE);
  if (!connected) throw new Error("WorkspaceShell requires a Runtime connection");

  const selectedSession =
    connected.sessions.find((session) => session.id === selectedSessionId) ?? null;
  const sessionCountLabel = `${connected.sessions.length} Gateway ${
    connected.sessions.length === 1 ? "session" : "sessions"
  }`;
  const activePageLabel = WORKSPACE_SECTIONS.flatMap((section) => section.pages).find(
    (page) => page.id === activePage,
  )?.label;

  return (
    <DrawerProvider className="workspace-frame">
      <main className="workspace">
      <aside className="workspace-sidebar">
        <div className="workspace-brand-lockup">
          <BrandMark />
          <span>
            <strong className="workspace-brand">WA Studio</strong>
            <small>runtime workspace</small>
          </span>
        </div>

        <nav aria-label="Workspace navigation" className="workspace-navigation">
          {WORKSPACE_SECTIONS.map((section) => (
            <section className="workspace-nav-section" key={section.id}>
              <strong className="workspace-nav-label">{section.label}</strong>
              <div className="stack stack-xs">
                {section.pages.map((page) => (
                  <button
                    aria-current={page.id === activePage ? "page" : undefined}
                    className="workspace-nav-button"
                    data-variant={page.id === activePage ? "secondary" : "quiet"}
                    disabled={!page.available}
                    key={page.id}
                    onClick={() => setActivePage(page.id)}
                    title={page.available ? undefined : `${page.label} is planned for a later slice`}
                    type="button"
                  >
                    <AppIcon className="workspace-nav-icon" name={PAGE_ICONS[page.id]} />
                    <span className="workspace-nav-text">{page.label}</span>
                    {!page.available && (
                      <span aria-hidden="true" className="workspace-nav-meta">soon</span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </nav>

        <div className="workspace-runtime-summary">
          <span className="workspace-runtime-label">WA Runtime status</span>
          <StatusIndicator glow tone={sessionTone(selectedSession?.status)}>
            {selectedSession?.status === "ready" ? "Operational" : "Attention required"}
          </StatusIndicator>
          <span className="workspace-runtime-meta">{sessionCountLabel}</span>
        </div>
      </aside>

        <div className="workspace-main">
        <header aria-label="Workspace toolbar" className="workspace-toolbar">
          <div className="workspace-toolbar-context">
            <span className="workspace-toolbar-copy">
              <span className="workspace-breadcrumb">WA Studio</span>
              <strong className="workspace-current-page">{activePageLabel}</strong>
            </span>
          </div>

          <div className="workspace-toolbar-actions">
            <SessionSwitcher
              onSelect={selectSession}
              selectedSessionId={selectedSessionId}
              sessions={connected.sessions}
            />

            <DropdownMenu
              ariaLabel="WA Runtime connection"
              trigger={(triggerProps) => (
                <button className="workspace-runtime-button" {...triggerProps} type="button">
                  <StatusDot glow tone={sessionTone(selectedSession?.status)} />
                  <span className="workspace-runtime-text">WA Runtime</span>
                  <AppIcon className="workspace-runtime-chevron" name="chevron-down" size="xs" />
                </button>
              )}
            >
              <div className="runtime-menu-context" role="presentation">
                <span>WA Runtime endpoint</span>
                <code>{connected.profile.baseUrl}</code>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="button-danger" onSelect={disconnect}>
                Disconnect WA Runtime
              </DropdownMenuItem>
            </DropdownMenu>
          </div>
        </header>

        <div className="workspace-body">
          <section aria-labelledby={`${activePage}-title`} className="workspace-content">
            {renderPage(activePage)}
          </section>
        </div>

        <footer className="status-bar">
          <span><StatusDot glow tone="success" />Connected to {connected.profile.baseUrl}</span>
          <span className="status-bar-session">session: {selectedSession?.name ?? "none"}</span>
          <span>Last sync: {formatSyncTime(selectedSession?.syncedAt)}</span>
        </footer>
        </div>

        <DrawerHost className="workspace-drawer-host" />
      </main>
    </DrawerProvider>
  );
}
