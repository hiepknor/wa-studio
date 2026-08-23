import { useEffect, useState } from "react";

import { useRuntimeConnection } from "./RuntimeConnectionContext";
import { SessionSwitcher } from "./SessionSwitcher";
import {
  DEFAULT_WORKSPACE_PAGE,
  WORKSPACE_SECTIONS,
  type WorkspacePageId,
} from "./workspace-pages";
import { SessionsScreen } from "@/features/sessions/SessionsScreen";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { GroupsWorkspace } from "@/features/groups/GroupsWorkspace";
import { CampaignsScreen } from "@/features/campaigns/CampaignsScreen";
import { getManagedRuntimeProvisioningProfile } from "@/shared/native/managed-runtime";
import { AppIcon, type AppIconName } from "@/shared/ui/AppIcon";
import { BrandMark } from "@/shared/ui/BrandMark";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DateTime } from "@/shared/ui/DateTime";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { StatusDot } from "@/shared/ui/StatusDot";

const PAGE_ICONS: Record<WorkspacePageId, AppIconName> = {
  activity: "activity",
  campaigns: "campaigns",
  groups: "groups",
  runs: "runs",
  sessions: "sessions",
  settings: "settings",
};

interface WorkspaceShellProps {
  getProvisioningProfile?: typeof getManagedRuntimeProvisioningProfile;
}

function renderPage(pageId: WorkspacePageId, openGroups: () => void) {
  switch (pageId) {
    case "campaigns":
      return <CampaignsScreen />;
    case "groups":
      return <GroupsWorkspace />;
    case "sessions":
      return <SessionsScreen onOpenGroups={openGroups} />;
    case "settings":
      return <SettingsScreen />;
    default:
      throw new Error(`Workspace page is not implemented: ${pageId}`);
  }
}

export function WorkspaceShell({
  getProvisioningProfile = getManagedRuntimeProvisioningProfile,
}: WorkspaceShellProps = {}) {
  const {
    connected,
    disconnect,
    managedRuntime,
    selectedSessionId,
    selectSession,
  } = useRuntimeConnection();
  const [activePage, setActivePage] = useState<WorkspacePageId>(DEFAULT_WORKSPACE_PAGE);
  const [disconnectConfirmationOpen, setDisconnectConfirmationOpen] = useState(false);
  const [openwaBaseUrl, setOpenwaBaseUrl] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void getProvisioningProfile()
      .then(profile => {
        if (!disposed) setOpenwaBaseUrl(profile?.openwaBaseUrl ?? null);
      })
      .catch(() => {
        if (!disposed) setOpenwaBaseUrl(null);
      });
    return () => {
      disposed = true;
    };
  }, [getProvisioningProfile, managedRuntime.phase]);

  if (!connected) throw new Error("WorkspaceShell requires a Runtime connection");

  const selectedSession =
    connected.sessions.find((session) => session.id === selectedSessionId) ?? null;
  const isManagedWorkspace = openwaBaseUrl !== null || managedRuntime.phase !== "unavailable";
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

        <div aria-label="Workspace connection actions" className="workspace-runtime-summary">
          <Button
            aria-label="Disconnect workspace"
            className="workspace-runtime-disconnect"
            icon="disconnect"
            onClick={() => setDisconnectConfirmationOpen(true)}
            size="md"
            title="Disconnect workspace"
            variant="danger"
          >
            Disconnect
          </Button>
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
          <span className="status-bar-connection">
            <StatusDot tone="success" />
            <span>Connected to</span>
            <span title={openwaBaseUrl ?? connected.profile.baseUrl}>
              {openwaBaseUrl ?? (isManagedWorkspace ? "" : connected.profile.baseUrl)}
            </span>
          </span>
          <span>Last sync: <DateTime fallback="not synced" value={selectedSession?.syncedAt} /></span>
        </footer>
        </div>

        <DrawerHost className="workspace-drawer-host" />
        <ConfirmationDialog
          body="WA Studio will detach this window from the local workspace. Runtime and active syncs continue in the background."
          confirmLabel="Disconnect"
          confirmVariant="danger"
          onCancel={() => setDisconnectConfirmationOpen(false)}
          onConfirm={() => {
            setDisconnectConfirmationOpen(false);
            disconnect();
          }}
          open={disconnectConfirmationOpen}
          title="Disconnect workspace?"
        />
      </main>
    </DrawerProvider>
  );
}
