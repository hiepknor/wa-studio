import {
  Button,
  Inline,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Panel,
  Select,
  Sidebar,
  Stack,
  StatusBar,
  StatusMark,
  Toolbar,
  VisuallyHidden,
} from "@hiepknor/ink-react";
import { useState } from "react";

import { useRuntimeConnection } from "./RuntimeConnectionContext";
import {
  DEFAULT_WORKSPACE_PAGE,
  WORKSPACE_SECTIONS,
  type WorkspacePageId,
} from "./workspace-pages";
import { SessionsScreen } from "@/features/sessions/SessionsScreen";

function sessionTone(status: string | undefined): "ok" | "warning" | "danger" | "neutral" {
  if (status === "ready") return "ok";
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

  return (
    <main className="workspace">
      <Toolbar aria-label="Workspace toolbar">
        <Inline className="workspace-toolbar-row" align="center" justify="between" wrap={false}>
          <Inline className="workspace-toolbar-context" align="center" gap="md" wrap={false}>
            <strong className="workspace-brand">WA Studio</strong>
            <div className="workspace-session-switcher">
              <Select
                disabled={connected.sessions.length === 0}
                label={<VisuallyHidden>Active session</VisuallyHidden>}
                onValueChange={selectSession}
                options={connected.sessions.map((session) => ({
                  label: `${session.name} · ${session.status}`,
                  value: session.id,
                }))}
                placeholder="No session"
                value={selectedSessionId ?? undefined}
              />
            </div>
          </Inline>

          <Inline align="center" gap="sm" wrap={false}>
            <span className="workspace-health">
              <StatusMark
                label={selectedSession?.status === "ready" ? "Operational" : "Attention required"}
                tone={sessionTone(selectedSession?.status)}
              />
            </span>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="quiet">Runtime</Button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem disabled>{connected.profile.baseUrl}</MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={disconnect}>Disconnect Runtime</MenuItem>
              </MenuContent>
            </Menu>
          </Inline>
        </Inline>
      </Toolbar>

      <div className="workspace-body">
        <Sidebar>
          <nav aria-label="Workspace navigation">
            <Stack gap="lg">
              {WORKSPACE_SECTIONS.map((section) => (
                <section key={section.id}>
                  <Stack gap="xs">
                    <strong className="muted-copy">{section.label}</strong>
                    {section.pages.map((page) => (
                      <Button
                        aria-current={page.id === activePage ? "page" : undefined}
                        className="workspace-nav-button"
                        disabled={!page.available}
                        key={page.id}
                        onClick={() => setActivePage(page.id)}
                        title={page.available ? undefined : `${page.label} is planned for a later slice`}
                        variant={page.id === activePage ? "secondary" : "quiet"}
                      >
                        {page.label}
                      </Button>
                    ))}
                  </Stack>
                </section>
              ))}
            </Stack>
          </nav>
        </Sidebar>

        <Panel aria-labelledby={`${activePage}-title`} className="workspace-content">
          {renderPage(activePage)}
        </Panel>
      </div>

      <StatusBar>
        <span>{sessionCountLabel}</span>
        <span>Last sync: {formatSyncTime(selectedSession?.syncedAt)}</span>
      </StatusBar>
    </main>
  );
}
