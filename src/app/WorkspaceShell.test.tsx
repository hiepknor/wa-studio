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

const standbySession: RuntimeSession = {
  ...session,
  id: "standby-session-id",
  name: "standby-session",
  status: "disconnected",
  engineLoaded: false,
};

const secondReadySession: RuntimeSession = {
  ...session,
  id: "second-session-id",
  name: "second-session",
};

const pendingSync: RuntimeSyncRun = {
  id: "pending-sync-id",
  sessionId: session.id,
  syncType: "FULL",
  status: "PENDING",
  groupsSynced: 0,
  membersSynced: 0,
  error: null,
  requestedAt: "2026-08-11T09:00:00.000Z",
  startedAt: null,
  completedAt: null,
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
      <button
        onClick={() => connect({ baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" })}
        type="button"
      >
        Connect test Runtime
      </button>
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
      <RuntimeConnectionProvider
        createApi={() => fakeApi}
        probeConnection={probeConnection}
      >
        <WorkspaceHarness />
      </RuntimeConnectionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Connect test Runtime" }));

    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active session" })).toHaveTextContent(
      /dev-session.*ready/,
    );
    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText("1 Gateway session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Groups" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );

    await user.click(screen.getByRole("button", { name: "Sync session" }));

    await waitFor(() => expect(requestSessionSync).toHaveBeenCalledWith(session.id));
    expect(screen.getByRole("progressbar", { name: "Session sync: completed" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );

    await user.click(screen.getByRole("button", { name: "Runtime" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect Runtime" }));
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
      <RuntimeConnectionProvider
        createApi={() => fakeApi}
        probeConnection={vi.fn().mockResolvedValue({
          sessionCount: 1,
          readySessions: 1,
          sessions: [session],
        })}
      >
        <WorkspaceHarness />
      </RuntimeConnectionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Connect test Runtime" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await user.click(screen.getByRole("button", { name: "Runtime" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect Runtime" }));

    await act(async () => resolveRefresh?.([session]));

    expect(screen.getByText("Selected: none")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect test Runtime" })).toBeInTheDocument();
  });

  it("uses the toolbar selector as the shared active-session context", async () => {
    const user = userEvent.setup();
    const fakeApi = {
      getSessionSyncRun: vi.fn(),
      listSessions: vi.fn(),
      requestSessionSync: vi.fn(),
    } as unknown as RuntimeApi;

    render(
      <RuntimeConnectionProvider
        createApi={() => fakeApi}
        probeConnection={vi.fn().mockResolvedValue({
          sessionCount: 2,
          readySessions: 1,
          sessions: [session, standbySession],
        })}
      >
        <WorkspaceHarness />
      </RuntimeConnectionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Connect test Runtime" }));
    const sessionCombobox = await screen.findByRole("combobox", { name: "Active session" });
    sessionCombobox.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(sessionCombobox).toHaveTextContent(/standby-session.*disconnected/);
    expect(screen.getByText("Attention required")).toBeInTheDocument();
    expect(screen.getByText("2 Gateway sessions")).toBeInTheDocument();

    await user.click(sessionCombobox);
    expect(screen.getByRole("listbox", { name: "Gateway sessions" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(sessionCombobox).toHaveFocus();
  });

  it("prevents duplicate sync runs and clears progress when the active session changes", async () => {
    const user = userEvent.setup();
    let resolveSync: ((run: RuntimeSyncRun) => void) | undefined;
    const syncPromise = new Promise<RuntimeSyncRun>((resolve) => {
      resolveSync = resolve;
    });
    const requestSessionSync = vi.fn().mockReturnValue(syncPromise);
    const fakeApi = {
      getSessionSyncRun: vi.fn(() => new Promise(() => undefined)),
      listSessions: vi.fn(),
      requestSessionSync,
    } as unknown as RuntimeApi;

    render(
      <RuntimeConnectionProvider
        createApi={() => fakeApi}
        probeConnection={vi.fn().mockResolvedValue({
          sessionCount: 2,
          readySessions: 2,
          sessions: [session, secondReadySession],
        })}
      >
        <WorkspaceHarness />
      </RuntimeConnectionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Connect test Runtime" }));
    await user.click(await screen.findByRole("button", { name: "Sync session" }));

    const startingButton = screen.getByRole("button", { name: "Starting full sync" });
    expect(startingButton).toBeDisabled();
    await user.click(startingButton);
    expect(requestSessionSync).toHaveBeenCalledTimes(1);

    await act(async () => resolveSync?.(pendingSync));
    expect(await screen.findByRole("button", { name: "Sync in progress" })).toBeDisabled();
    expect(screen.getByRole("progressbar", { name: "Session sync: pending" })).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Active session" }));
    await user.click(screen.getByRole("option", { name: /second-session/ }));

    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Sync session" })).toBeEnabled();
  });

  it("supports keyboard focus, Escape, and outside dismissal for the Runtime menu", async () => {
    const user = userEvent.setup();
    const fakeApi = {
      getSessionSyncRun: vi.fn(),
      listSessions: vi.fn(),
      requestSessionSync: vi.fn(),
    } as unknown as RuntimeApi;

    render(
      <RuntimeConnectionProvider
        createApi={() => fakeApi}
        probeConnection={vi.fn().mockResolvedValue({
          sessionCount: 1,
          readySessions: 1,
          sessions: [session],
        })}
      >
        <WorkspaceHarness />
      </RuntimeConnectionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Connect test Runtime" }));
    const runtimeButton = await screen.findByRole("button", { name: "Runtime" });
    runtimeButton.focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("menuitem", { name: "Disconnect Runtime" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(runtimeButton).toHaveFocus();

    await user.click(runtimeButton);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("heading", { name: "Sessions" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
