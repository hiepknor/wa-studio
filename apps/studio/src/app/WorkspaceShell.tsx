import { useEffect, useState } from "react";

import { useRuntimeConnection } from "./RuntimeConnectionContext";
import { SessionSwitcher } from "./SessionSwitcher";
import {
  DEFAULT_WORKSPACE_PAGE,
  SETTINGS_WORKSPACE_PAGE,
  WORKSPACE_SECTIONS,
  findWorkspacePage,
  type WorkspacePageId,
} from "./workspace-pages";
import { SessionsScreen } from "@/features/sessions/SessionsScreen";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { GroupsWorkspace } from "@/features/groups/GroupsWorkspace";
import { CampaignsScreen } from "@/features/campaigns/CampaignsScreen";
import { RunsScreen } from "@/features/runs/RunsScreen";
import { ActivityScreen } from "@/features/activity/ActivityScreen";
import {
  getManagedRuntimeProvisioningProfile,
  type ManagedRuntimePhase,
} from "@/shared/native/managed-runtime";
import { AppIcon, type AppIconName } from "@/shared/ui/AppIcon";
import { BrandMark } from "@/shared/ui/BrandMark";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { StatusDot } from "@/shared/ui/StatusDot";
import type { FeedbackTone } from "@/shared/ui/feedback-tone";
import studioPackage from "../../package.json";

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

interface WorkspaceLocation {
  page: WorkspacePageId;
  eventId?: string;
  runId?: string;
}

const WORKSPACE_VIEW_STORAGE_KEY = "wa-studio-view";
const WORKSPACE_RAIL_STORAGE_KEY = "wa-studio-rail-collapsed";

function storedWorkspacePage(): WorkspacePageId {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_PAGE;
  try {
    const storedPage = window.localStorage.getItem(WORKSPACE_VIEW_STORAGE_KEY);
    if (storedPage) return findWorkspacePage(storedPage as WorkspacePageId).id;
  } catch {
    // Local persistence is an enhancement; the shell remains usable without it.
  }
  return DEFAULT_WORKSPACE_PAGE;
}

function storedRailCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(WORKSPACE_RAIL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function runtimeStatus(phase: ManagedRuntimePhase): {
  label: string;
  tone: FeedbackTone;
} {
  switch (phase) {
    case "degraded":
      return { label: "degraded", tone: "danger" };
    case "databaseStarting":
    case "discovering":
    case "migrating":
    case "provisioningRequired":
    case "reconfiguring":
    case "restoring":
    case "runtimeStarting":
    case "stopping":
    case "updating":
      return { label: "working", tone: "warning" };
    case "ready":
    case "unavailable":
      return { label: "healthy", tone: "success" };
  }
}

function renderPage(
  location: WorkspaceLocation,
  navigate: (location: WorkspaceLocation) => void,
) {
  switch (location.page) {
    case "campaigns":
      return <CampaignsScreen onOpenRun={(runId) => navigate({ page: "runs", runId })} />;
    case "groups":
      return <GroupsWorkspace />;
    case "sessions":
      return <SessionsScreen onOpenGroups={() => navigate({ page: "groups" })} />;
    case "settings":
      return <SettingsScreen />;
    case "runs":
      return <RunsScreen initialRunId={location.runId} onRunSelectionChange={(runId) => navigate({ page: "runs", ...(runId ? { runId } : {}) })} />;
    case "activity":
      return (
        <ActivityScreen
          initialEventId={location.eventId}
          onEventSelectionChange={(eventId) => navigate({
            page: "activity",
            ...(eventId ? { eventId } : {}),
          })}
          onOpenRun={(runId) => navigate({ page: "runs", runId })}
        />
      );
    default:
      throw new Error(`Workspace page is not implemented: ${location.page}`);
  }
}

export function WorkspaceShell({
  getProvisioningProfile = getManagedRuntimeProvisioningProfile,
}: WorkspaceShellProps = {}) {
  const {
    connected,
    managedRuntime,
    selectedSessionId,
    selectSession,
  } = useRuntimeConnection();
  const [location, setLocation] = useState<WorkspaceLocation>(() => ({
    page: storedWorkspacePage(),
  }));
  const [railCollapsed, setRailCollapsed] = useState(storedRailCollapsed);
  const activePage = location.page;
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
  const activePageLabel = findWorkspacePage(activePage).label;
  const runtime = runtimeStatus(managedRuntime.phase);

  function navigate(nextLocation: WorkspaceLocation) {
    setLocation(nextLocation);
    try {
      window.localStorage.setItem(WORKSPACE_VIEW_STORAGE_KEY, nextLocation.page);
    } catch {
      // Navigation does not depend on persistence being available.
    }
  }

  function toggleRail() {
    setRailCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(WORKSPACE_RAIL_STORAGE_KEY, String(next));
      } catch {
        // Collapsing the rail does not depend on persistence being available.
      }
      return next;
    });
  }

  return (
    <DrawerProvider className="workspace-frame">
      <main
        className={`workspace${railCollapsed ? " workspace-rail-collapsed" : ""}`}
        data-rail-collapsed={railCollapsed || undefined}
      >
        <aside className="workspace-sidebar">
          <div className="workspace-brand-lockup">
            <BrandMark />
            <strong className="workspace-brand">WA Studio</strong>
            <button
              aria-expanded={!railCollapsed}
              aria-label={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="workspace-rail-toggle"
              onClick={toggleRail}
              title={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              type="button"
            >
              <AppIcon name="chevron-right" />
            </button>
          </div>

          <nav aria-label="Workspace navigation" className="workspace-navigation">
            {WORKSPACE_SECTIONS.map((section) => (
              <section className="workspace-nav-section" key={section.id}>
                <strong className="workspace-nav-label">{section.label}</strong>
                <div className="workspace-nav-items">
                  {section.pages.map((page) => (
                    <button
                      aria-current={page.id === activePage ? "page" : undefined}
                      className="workspace-nav-button"
                      data-variant={page.id === activePage ? "secondary" : "quiet"}
                      disabled={!page.available}
                      key={page.id}
                      onClick={() => navigate({ page: page.id })}
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

          <div className="workspace-sidebar-bottom">
            <button
              aria-current={activePage === SETTINGS_WORKSPACE_PAGE.id ? "page" : undefined}
              aria-label={SETTINGS_WORKSPACE_PAGE.label}
              className="workspace-nav-button workspace-settings-button"
              data-variant={activePage === SETTINGS_WORKSPACE_PAGE.id ? "secondary" : "quiet"}
              onClick={() => navigate({ page: SETTINGS_WORKSPACE_PAGE.id })}
              type="button"
            >
              <AppIcon className="workspace-nav-icon" name="settings" />
              <span className="workspace-nav-text">{SETTINGS_WORKSPACE_PAGE.label}</span>
            </button>
            <div aria-label="Workspace build" className="workspace-build-line">
              <StatusDot tone="success" />
              <span>Local workspace</span>
              <span className="workspace-build-version">v{studioPackage.version}</span>
            </div>
          </div>
        </aside>

        <div className="workspace-main">
          <header aria-label="Workspace toolbar" className="workspace-toolbar">
            <div className="workspace-toolbar-context">
              <span className="workspace-toolbar-copy">
                <span className="workspace-breadcrumb">Active workspace</span>
                <strong className="workspace-current-page">{activePageLabel}</strong>
              </span>
            </div>

            <div className="workspace-toolbar-actions">
              <SessionSwitcher
                onManageSessions={() => navigate({ page: "sessions" })}
                onSelect={selectSession}
                selectedSessionId={selectedSessionId}
                sessions={connected.sessions}
              />
            </div>
          </header>

          <div className="workspace-body">
            <section aria-labelledby={`${activePage}-title`} className="workspace-content">
              {renderPage(location, navigate)}
            </section>
          </div>

          <footer aria-label="Workspace status" className="status-bar">
            <span className="status-bar-connection">
              <StatusDot tone="success" />
              <span>{isManagedWorkspace ? "Connected locally" : "Connected to"}</span>
              {!isManagedWorkspace && (
                <strong title={connected.profile.baseUrl}>{connected.profile.baseUrl}</strong>
              )}
            </span>
            <span aria-hidden="true" className="status-bar-separator" />
            <span>
              <span>Session:</span>
              <strong title={selectedSession?.id}>{selectedSession?.name ?? "none"}</strong>
            </span>
            <span aria-hidden="true" className="status-bar-separator" />
            <span className="status-bar-runtime" data-tone={runtime.tone}>
              <span>WA Runtime</span>
              <strong>{runtime.label}</strong>
            </span>
          </footer>
        </div>

        <DrawerHost className="workspace-drawer-host" />
      </main>
    </DrawerProvider>
  );
}
