import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import type {
  RuntimeApi,
  RuntimeGroupPage,
  RuntimeSession,
  RuntimeSyncRun,
} from "@/shared/api/runtime-client";
import { RuntimeTransportError } from "@/shared/api/runtime-http";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { ToastProvider } from "@/shared/ui/Toast";
import { GroupsScreen } from "./GroupsScreen";
import { pollSessionSync } from "@/shared/hooks/session-sync-poller";

vi.mock("@/shared/hooks/session-sync-poller", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/shared/hooks/session-sync-poller")>();
  return { ...original, pollSessionSync: vi.fn() };
});

const session: RuntimeSession = {
  id: "session-id",
  name: "prod-session",
  status: "ready",
  phone: null,
  pushName: null,
  connectedAt: null,
  lastActiveAt: null,
  engineLoaded: true,
  lastError: null,
  restriction: null,
  gatewayCreatedAt: "2026-08-13T09:00:00.000Z",
  gatewayUpdatedAt: "2026-08-13T09:00:00.000Z",
  syncedAt: "2026-08-13T09:00:00.000Z",
};

const secondSession = { ...session, id: "second-session", name: "second-session" };
const page: RuntimeGroupPage = { data: [], meta: { total: 0, limit: 20, offset: 0 } };
const pendingRun: RuntimeSyncRun = {
  id: "run-id",
  sessionId: session.id,
  syncType: "FULL",
  phase: "DISCOVERING",
  status: "PENDING",
  groupsSynced: 0,
  groupsDiscovered: 0,
  groupsScheduled: 0,
  groupsFailed: 0,
  groupsSkipped: 0,
  groupsPending: 0,
  groupsRunning: 0,
  groupsRetrying: 0,
  membersSynced: 0,
  nextAttemptAt: null,
  cooldownUntil: null,
  error: null,
  requestedAt: "2026-08-13T09:00:00.000Z",
  startedAt: null,
  completedAt: null,
};
const completedRun: RuntimeSyncRun = {
  ...pendingRun,
  phase: "COMPLETED",
  status: "COMPLETED",
  groupsSynced: 8,
  membersSynced: 240,
  startedAt: "2026-08-13T09:00:01.000Z",
  completedAt: "2026-08-13T09:00:08.000Z",
};

function Harness() {
  const { connect, connected, selectSession } = useRuntimeConnection();
  if (!connected) return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "0123456789abcdef0123456789abcdef" })}>Connect</button>;
  return (
    <DrawerProvider>
      <button onClick={() => selectSession(secondSession.id)}>Switch session</button>
      <GroupsScreen />
      <DrawerHost />
    </DrawerProvider>
  );
}

function renderGroups(overrides: Partial<RuntimeApi> = {}) {
  const api = {
    getGroup: vi.fn(),
    getCurrentGroupCapabilityRefresh: vi.fn().mockResolvedValue(null),
    getGroupCapabilityRefresh: vi.fn(),
    getSessionSyncRun: vi.fn(),
    listGroupMembers: vi.fn(),
    listGroups: vi.fn().mockResolvedValue(page),
    listSessions: vi.fn().mockResolvedValue([session, secondSession]),
    requestGroupCapabilityRefresh: vi.fn(),
    requestSessionSync: vi.fn().mockResolvedValue(pendingRun),
    ...overrides,
  } as unknown as RuntimeApi;
  render(
    <ToastProvider>
      <RuntimeConnectionProvider
        createApi={() => api}
        probeConnection={vi.fn().mockResolvedValue({ sessionCount: 2, readySessions: 2, sessions: [session, secondSession] })}
      >
        <Harness />
      </RuntimeConnectionProvider>
    </ToastProvider>,
  );
  return api;
}

async function connectAndGetActions(user: ReturnType<typeof userEvent.setup>) {
  const connectButton = screen.queryByRole("button", { name: "Connect" });
  if (connectButton) await user.click(connectButton);
  return {
    reload: await screen.findByRole("button", { name: "Reload groups" }),
    sync: screen.getByRole("button", { name: "Sync groups" }),
  };
}

afterEach(() => vi.mocked(pollSessionSync).mockReset());

describe("GroupsScreen Reload and Sync", () => {
  it("shows two direct actions with supporting titles and keyboard order", async () => {
    const user = userEvent.setup();
    renderGroups();
    const { reload, sync } = await connectAndGetActions(user);
    expect(reload).toHaveTextContent("Reload");
    expect(sync).toHaveTextContent("Sync");
    expect(reload).toHaveAttribute("title", "Reload groups currently stored in WA Runtime.");
    expect(sync).toHaveAttribute("title", "Synchronize groups and members from OpenWA.");
    expect(screen.queryByRole("menu", { name: "Group data actions" })).not.toBeInTheDocument();
    reload.focus();
    await user.tab();
    expect(sync).toHaveFocus();
  });

  it("Reload only reloads the current read-model query", async () => {
    const user = userEvent.setup();
    const requestSessionSync = vi.fn();
    const listGroups = vi.fn().mockResolvedValue(page);
    renderGroups({ listGroups, requestSessionSync });
    const { reload } = await connectAndGetActions(user);
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));
    await user.click(reload);
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
    expect(requestSessionSync).not.toHaveBeenCalled();
    expect(await screen.findByText("Groups reloaded")).toBeInTheDocument();
  });

  it("requires confirmation, and Cancel does not create a run", async () => {
    const user = userEvent.setup();
    const requestSessionSync = vi.fn();
    renderGroups({ requestSessionSync });
    const { sync } = await connectAndGetActions(user);
    await user.click(sync);
    const dialog = screen.getByRole("dialog", { name: "Sync groups and members?" });
    expect(dialog).toHaveTextContent("for prod-session from OpenWA");
    expect(dialog).toHaveTextContent("Large sessions may take several minutes");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(requestSessionSync).not.toHaveBeenCalled();
  });

  it("does not label automatic list loading as a manual reload", async () => {
    const user = userEvent.setup();
    let resolveList!: (value: RuntimeGroupPage) => void;
    const listGroups = vi.fn().mockReturnValue(new Promise<RuntimeGroupPage>((resolve) => {
      resolveList = resolve;
    }));
    renderGroups({ listGroups });
    await user.click(screen.getByRole("button", { name: "Connect" }));

    const reload = await screen.findByRole("button", { name: "Reload groups" });
    expect(reload).toHaveTextContent("Reload");
    expect(reload).not.toHaveTextContent("Reloading");
    resolveList(page);
    await waitFor(() => expect(listGroups).toHaveBeenCalledOnce());
  });

  it("confirms the active session, polls the returned run, then reloads sessions and groups", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue(page);
    const listSessions = vi.fn().mockResolvedValue([session, secondSession]);
    const requestSessionSync = vi.fn().mockResolvedValue(pendingRun);
    vi.mocked(pollSessionSync).mockImplementation(async ({ initialRun, onObservation, read }) => {
      expect(initialRun).toEqual(pendingRun);
      await read();
      onObservation({ ...pendingRun, status: "RUNNING", groupsSynced: 2 });
      return { status: "completed", run: completedRun };
    });
    const getSessionSyncRun = vi.fn().mockResolvedValue(completedRun);
    renderGroups({ getSessionSyncRun, listGroups, listSessions, requestSessionSync });
    const { sync } = await connectAndGetActions(user);
    await user.click(sync);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));

    await waitFor(() => expect(requestSessionSync).toHaveBeenCalledWith(
      session.id,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    ));
    expect(getSessionSyncRun).toHaveBeenCalledWith(
      session.id,
      pendingRun.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText("Sync completed")).toBeInTheDocument();
    await waitFor(() => expect(listSessions).toHaveBeenCalledOnce());
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
  });

  it("reports FAILED and background outcomes without reloading or reading members", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue(page);
    const listGroupMembers = vi.fn();
    vi.mocked(pollSessionSync).mockResolvedValue({
      status: "failed",
      run: { ...pendingRun, status: "FAILED", error: "Safe failure" },
    });
    renderGroups({ listGroupMembers, listGroups });
    let actions = await connectAndGetActions(user);
    await user.click(actions.sync);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));
    expect(await screen.findByText("Sync failed")).toBeInTheDocument();
    expect(screen.getByText("Safe failure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(listGroups).toHaveBeenCalledOnce();
    expect(listGroupMembers).not.toHaveBeenCalled();

    vi.mocked(pollSessionSync).mockResolvedValue({ status: "background", run: pendingRun });
    actions = await connectAndGetActions(user);
    await user.click(actions.sync);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));
    expect(await screen.findByText("Sync continues in the background")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reload groups" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Sync groups" })).toBeEnabled();
  });

  it("offers an idempotent retry when the sync response is unconfirmed", async () => {
    const user = userEvent.setup();
    const requestSessionSync = vi.fn().mockRejectedValue(new RuntimeTransportError(
      "response lost",
      { requestDispatched: true },
    ));
    renderGroups({ requestSessionSync });
    const { sync } = await connectAndGetActions(user);
    await user.click(sync);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));

    expect(await screen.findByText("Sync request not confirmed")).toBeInTheDocument();
    expect(screen.getByText(/same request key/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry request" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reload groups" })).toHaveLength(1);
    expect(requestSessionSync).toHaveBeenCalledTimes(1);
    expect(pollSessionSync).not.toHaveBeenCalled();
  });

  it("keeps a completed run successful when session metadata reload fails", async () => {
    const user = userEvent.setup();
    vi.mocked(pollSessionSync).mockResolvedValue({ status: "completed", run: completedRun });
    const listGroups = vi.fn().mockResolvedValue(page);
    renderGroups({
      listGroups,
      listSessions: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
    });
    const { sync } = await connectAndGetActions(user);
    await user.click(sync);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));
    expect(await screen.findByText("Sync completed with an update warning"))
      .toBeInTheDocument();
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
  });

  it("ignores a late completion after the session changes", async () => {
    const user = userEvent.setup();
    let resolvePoll!: (value: { status: "completed"; run: RuntimeSyncRun }) => void;
    vi.mocked(pollSessionSync).mockReturnValue(new Promise((resolve) => { resolvePoll = resolve; }));
    const listGroups = vi.fn().mockResolvedValue(page);
    renderGroups({ listGroups });
    const { sync } = await connectAndGetActions(user);
    await user.click(sync);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));
    await screen.findByText(/Sync pending ·/);
    await user.click(screen.getByRole("button", { name: "Switch session" }));
    resolvePoll({ status: "completed", run: completedRun });
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: secondSession.id }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(screen.queryByText("Sync completed")).not.toBeInTheDocument();
  });
});
