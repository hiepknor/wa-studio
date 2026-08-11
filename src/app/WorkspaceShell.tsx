import {
  Button,
  Inline,
  Panel,
  Sidebar,
  Stack,
  StatusBar,
  StatusMark,
  Toolbar,
} from "@hiepknor/ink-react";

import { useRuntimeConnection } from "./RuntimeConnectionContext";
import { SessionsScreen } from "@/features/sessions/SessionsScreen";

export function WorkspaceShell() {
  const { connected, disconnect, selectedSessionId } = useRuntimeConnection();
  if (!connected) throw new Error("WorkspaceShell requires a Runtime connection");

  const selectedSession =
    connected.sessions.find((session) => session.id === selectedSessionId) ?? null;

  return (
    <main className="workspace">
      <Toolbar className="workspace-toolbar" aria-label="Workspace toolbar">
        <strong>WA Studio</strong>
        <span className="muted-copy">Automation Runtime</span>
        <Inline className="toolbar-end" align="center" gap="sm">
          <StatusMark label="Runtime connected" tone="ok" />
          <Button onClick={disconnect} variant="quiet">Disconnect</Button>
        </Inline>
      </Toolbar>

      <div className="workspace-body">
        <Sidebar>
          <nav aria-label="Workspace navigation">
            <Stack gap="xs">
              <Button aria-current="page" variant="primary">Sessions</Button>
              <Button disabled variant="quiet">Groups</Button>
              <Button disabled variant="quiet">Campaigns</Button>
              <Button disabled variant="quiet">Runs</Button>
            </Stack>
          </nav>
        </Sidebar>

        <Panel aria-labelledby="sessions-title" className="workspace-panel">
          <SessionsScreen />
        </Panel>
      </div>

      <StatusBar>
        <span>Runtime: {connected.profile.baseUrl}</span>
        <span>Session: {selectedSession?.name ?? "none"}</span>
      </StatusBar>
    </main>
  );
}
