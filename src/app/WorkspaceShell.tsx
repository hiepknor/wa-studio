import { useState } from "react";

import { useRuntimeConnection } from "./RuntimeConnectionContext";
import { SessionSwitcher } from "./SessionSwitcher";
import {
  DEFAULT_WORKSPACE_PAGE,
  WORKSPACE_SECTIONS,
  type WorkspacePageId,
} from "./workspace-pages";
import { SessionsScreen } from "@/features/sessions/SessionsScreen";
import { GroupsWorkspace } from "@/features/groups/GroupsWorkspace";
import { CampaignsScreen } from "@/features/campaigns/CampaignsScreen";
import { AppIcon, type AppIconName } from "@/shared/ui/AppIcon";
import { Badge } from "@/shared/ui/Badge";
import { BrandMark } from "@/shared/ui/BrandMark";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";

const PAGE_ICONS: Record<WorkspacePageId, AppIconName> = {
  activity: "activity",
  campaigns: "campaigns",
  groups: "groups",
  runs: "runs",
  sessions: "sessions",
  settings: "settings",
};

function formatSyncTime(value: string | null | undefined): string {
  if (!value) return "not synced";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function renderPage(pageId: WorkspacePageId, openGroups: () => void) {
  switch (pageId) {
    case "campaigns":
      return <CampaignsScreen />;
    case "groups":
      return <GroupsWorkspace />;
    case "sessions":
      return <SessionsScreen onOpenGroups={openGroups} />;
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
  const [disconnectConfirmationOpen, setDisconnectConfirmationOpen] = useState(false);
  if (!connected) throw new Error("WorkspaceShell requires a Runtime connection");

  const selectedSession =
    connected.sessions.find((session) => session.id === selectedSessionId) ?? null;
  const sessionCountLabel = `${connected.sessions.length} ${
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

        <div aria-label="WA Runtime connection" className="workspace-runtime-summary">
          <div className="workspace-runtime-copy">
            <span className="workspace-runtime-label">WA Runtime</span>
            <div className="workspace-runtime-state">
              <Badge tone="success">Connected</Badge>
              <span aria-hidden="true" className="workspace-runtime-divider">·</span>
              <span className="workspace-runtime-meta">{sessionCountLabel}</span>
            </div>
          </div>
          <Button
            aria-label="Disconnect WA Runtime"
            className="workspace-runtime-disconnect"
            icon="disconnect"
            onClick={() => setDisconnectConfirmationOpen(true)}
            size="sm"
            title="Disconnect WA Runtime"
            variant="danger"
          />
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
          </div>
        </header>

        <div className="workspace-body">
          <section aria-labelledby={`${activePage}-title`} className="workspace-content">
            {renderPage(activePage, () => setActivePage("groups"))}
          </section>
        </div>

        <footer aria-label="Workspace status" className="status-bar">
          <span className="status-bar-connection"><Badge tone="success">Connected</Badge><span>to {connected.profile.baseUrl}</span></span>
          <span>Last sync: {formatSyncTime(selectedSession?.syncedAt)}</span>
        </footer>
        </div>

        <DrawerHost className="workspace-drawer-host" />
        <ConfirmationDialog
          body="WA Studio will clear the current connection and in-memory credentials. This does not stop WA Runtime or any sync already running in the background."
          confirmLabel="Disconnect"
          confirmVariant="danger"
          onCancel={() => setDisconnectConfirmationOpen(false)}
          onConfirm={() => {
            setDisconnectConfirmationOpen(false);
            disconnect();
          }}
          open={disconnectConfirmationOpen}
          title="Disconnect from WA Runtime?"
        />
      </main>
    </DrawerProvider>
  );
}
