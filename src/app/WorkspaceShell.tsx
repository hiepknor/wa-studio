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
  findWorkspacePage,
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
  const activePageDefinition = findWorkspacePage(activePage);

  return (
    <main className="workspace">
      <Toolbar className="workspace-toolbar" aria-label="Workspace toolbar">
        <strong>WA Studio</strong>
        <div className="workspace-session-context">
          <span className="workspace-context-label" aria-hidden="true">Session</span>
          <Select
            className="workspace-session-select"
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
        <Inline className="toolbar-end" align="center" gap="sm" wrap={false}>
          <StatusMark label="Runtime connected" tone="ok" />
          <StatusMark
            label={selectedSession ? `Session ${selectedSession.status}` : "No active session"}
            tone={sessionTone(selectedSession?.status)}
          />
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
      </Toolbar>

      <div className="workspace-body">
        <Sidebar>
          <nav aria-label="Workspace navigation">
            {WORKSPACE_SECTIONS.map((section) => (
              <section className="workspace-nav-section" key={section.id}>
                <span className="workspace-nav-label">{section.label}</span>
                <Stack gap="xs">
                  {section.pages.map((page) => (
                    <Button
                      aria-current={page.id === activePage ? "page" : undefined}
                      disabled={!page.available}
                      key={page.id}
                      onClick={() => setActivePage(page.id)}
                      title={page.available ? undefined : `${page.label} is planned for a later slice`}
                      variant={page.id === activePage ? "primary" : "quiet"}
                    >
                      {page.label}
                    </Button>
                  ))}
                </Stack>
              </section>
            ))}
          </nav>
        </Sidebar>

        <Panel aria-labelledby={`${activePage}-title`} className="workspace-panel">
          {renderPage(activePage)}
        </Panel>
      </div>

      <StatusBar>
        <span>Runtime: connected</span>
        <span>Page: {activePageDefinition.label}</span>
        <span>Session: {selectedSession?.name ?? "none"} · {selectedSession?.status ?? "unavailable"}</span>
        <span>Synced: {formatSyncTime(selectedSession?.syncedAt)}</span>
      </StatusBar>
    </main>
  );
}
