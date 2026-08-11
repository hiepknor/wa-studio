import { Button, InkProvider } from "@hiepknor/ink-react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "./RuntimeConnectionContext";
import { WorkspaceShell } from "./WorkspaceShell";
import type {
  RuntimeApi,
  RuntimeConnectionResult,
  RuntimeSession,
  RuntimeSyncRun,
} from "@/shared/api/runtime-client";

const session: RuntimeSession = {
  id: "session-id",
  name: "dev-session",
  status: "ready",
  phone: "84900000000",
  pushName: "Development",
  connectedAt: "2026-08-11T08:00:00.000Z",
  lastActiveAt: "2026-08-11T09:00:00.000Z",
  engineLoaded: true,
  lastError: null,
  restriction: null,
  gatewayCreatedAt: "2026-08-10T08:00:00.000Z",
  gatewayUpdatedAt: "2026-08-11T09:00:00.000Z",
  syncedAt: "2026-08-11T09:00:00.000Z",
};

const completedSync: RuntimeSyncRun = {
  id: "sync-id",
  sessionId: session.id,
  syncType: "FULL",
  status: "COMPLETED",
  groupsSynced: 512,
  membersSynced: 2048,
  error: null,
  requestedAt: "2026-08-11T09:00:00.000Z",
  startedAt: "2026-08-11T09:00:01.000Z",
  completedAt: "2026-08-11T09:00:10.000Z",
};

function WorkspaceHarness() {
  const { connect, connected, selectedSessionId } = useRuntimeConnection();
  if (connected) return <WorkspaceShell />;
  return (
    <>
      <span>Selected: {selectedSessionId ?? "none"}</span>
      <Button
        onClick={() => connect({ baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" })}
      >
        Connect test Runtime
      </Button>
    </>
  );
}

describe("WorkspaceShell", () => {
  it("enters the workspace, selects the ready session, starts sync, and disconnects", async () => {
    const user = userEvent.setup();
    const connectionResult: RuntimeConnectionResult = {
      sessionCount: 1,
      readySessions: 1,
      sessions: [session],
    };
    const probeConnection = vi.fn().mockResolvedValue(connectionResult);
    const requestSessionSync = vi.fn().mockResolvedValue(completedSync);
    const fakeApi = {
      getSessionSyncRun: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([session]),
      requestSessionSync,
    } as unknown as RuntimeApi;

    render(
      <InkProvider density="compact">
        <RuntimeConnectionProvider
          createApi={() => fakeApi}
          probeConnection={probeConnection}
        >
          <WorkspaceHarness />
        </RuntimeConnectionProvider>
      </InkProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Connect test Runtime" }));

    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.getByText("Session: dev-session")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sync selected session" }));

    await waitFor(() => expect(requestSessionSync).toHaveBeenCalledWith(session.id));
    expect(screen.getByRole("progressbar", { name: "Session sync: completed" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByRole("button", { name: "Connect test Runtime" })).toBeInTheDocument();
    expect(screen.getByText("Selected: none")).toBeInTheDocument();
  });

  it("ignores a refresh response that finishes after disconnect", async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((sessions: RuntimeSession[]) => void) | undefined;
    const refreshPromise = new Promise<RuntimeSession[]>((resolve) => {
      resolveRefresh = resolve;
    });
    const fakeApi = {
      getSessionSyncRun: vi.fn(),
      listSessions: vi.fn().mockReturnValue(refreshPromise),
      requestSessionSync: vi.fn(),
    } as unknown as RuntimeApi;

    render(
      <InkProvider density="compact">
        <RuntimeConnectionProvider
          createApi={() => fakeApi}
          probeConnection={vi.fn().mockResolvedValue({
            sessionCount: 1,
            readySessions: 1,
            sessions: [session],
          })}
        >
          <WorkspaceHarness />
        </RuntimeConnectionProvider>
      </InkProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Connect test Runtime" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    await act(async () => resolveRefresh?.([session]));

    expect(screen.getByText("Selected: none")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect test Runtime" })).toBeInTheDocument();
  });
});
