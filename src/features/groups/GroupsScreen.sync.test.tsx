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
  status: "PENDING",
  groupsSynced: 0,
  membersSynced: 0,
  error: null,
  requestedAt: "2026-08-13T09:00:00.000Z",
  startedAt: null,
  completedAt: null,
};
const completedRun: RuntimeSyncRun = {
  ...pendingRun,
  status: "COMPLETED",
  groupsSynced: 8,
  membersSynced: 240,
  startedAt: "2026-08-13T09:00:01.000Z",
  completedAt: "2026-08-13T09:00:08.000Z",
};

function Harness() {
  const { connect, connected, selectSession } = useRuntimeConnection();
  if (!connected) return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "key" })}>Connect</button>;
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

async function connectAndOpenMenu(user: ReturnType<typeof userEvent.setup>) {
  const connectButton = screen.queryByRole("button", { name: "Connect" });
  if (connectButton) await user.click(connectButton);
  const trigger = await screen.findByRole("button", { name: "Update groups" });
  await user.click(trigger);
  return screen.getByRole("menu", { name: "Group data actions" });
}

afterEach(() => vi.mocked(pollSessionSync).mockReset());

describe("GroupsScreen Reload and Sync", () => {
  it("shows the two actions with supporting copy and keyboard focus behavior", async () => {
    const user = userEvent.setup();
    renderGroups();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    const trigger = await screen.findByRole("button", { name: "Update groups" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu", { name: "Group data actions" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    expect(within(menu).getByText("Reload groups currently stored in WA Runtime.")).toBeInTheDocument();
    expect(within(menu).getByText("Synchronize groups and members from OpenWA.")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Reload/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: /Sync/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("Reload only reloads the current read-model query", async () => {
    const user = userEvent.setup();
    const requestSessionSync = vi.fn();
    const listGroups = vi.fn().mockResolvedValue(page);
    renderGroups({ listGroups, requestSessionSync });
    const menu = await connectAndOpenMenu(user);
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));
    await user.click(within(menu).getByRole("menuitem", { name: /Reload/ }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
    expect(requestSessionSync).not.toHaveBeenCalled();
    expect(await screen.findByText("Groups reloaded.")).toBeInTheDocument();
  });

  it("requires confirmation, and Cancel does not create a run", async () => {
    const user = userEvent.setup();
    const requestSessionSync = vi.fn();
    renderGroups({ requestSessionSync });
    const menu = await connectAndOpenMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Sync/ }));
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

    const trigger = await screen.findByRole("button", { name: "Update groups" });
    expect(trigger).toHaveTextContent("Update");
    expect(trigger).not.toHaveTextContent("Reloading");
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
    const menu = await connectAndOpenMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Sync/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));

    await waitFor(() => expect(requestSessionSync).toHaveBeenCalledWith(session.id));
    expect(getSessionSyncRun).toHaveBeenCalledWith(session.id, pendingRun.id);
    expect(await screen.findByText("Sync completed.")).toBeInTheDocument();
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
    let menu = await connectAndOpenMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Sync/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));
    expect(await screen.findByText("Sync failed")).toBeInTheDocument();
    expect(screen.getByText("Safe failure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(listGroups).toHaveBeenCalledOnce();
    expect(listGroupMembers).not.toHaveBeenCalled();

    vi.mocked(pollSessionSync).mockResolvedValue({ status: "background", run: pendingRun });
    menu = await connectAndOpenMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Sync/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));
    expect(await screen.findByText("Sync continues in the background")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload groups" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Update groups" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Sync/ })).toBeEnabled();
  });

  it("keeps a completed run successful when session metadata reload fails", async () => {
    const user = userEvent.setup();
    vi.mocked(pollSessionSync).mockResolvedValue({ status: "completed", run: completedRun });
    const listGroups = vi.fn().mockResolvedValue(page);
    renderGroups({
      listGroups,
      listSessions: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
    });
    const menu = await connectAndOpenMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Sync/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));
    expect(await screen.findByText("Sync completed with an update warning."))
      .toBeInTheDocument();
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
  });

  it("ignores a late completion after the session changes", async () => {
    const user = userEvent.setup();
    let resolvePoll!: (value: { status: "completed"; run: RuntimeSyncRun }) => void;
    vi.mocked(pollSessionSync).mockReturnValue(new Promise((resolve) => { resolvePoll = resolve; }));
    const listGroups = vi.fn().mockResolvedValue(page);
    renderGroups({ listGroups });
    const menu = await connectAndOpenMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Sync/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sync" }));
    await screen.findByText(/Sync pending ·/);
    await user.click(screen.getByRole("button", { name: "Switch session" }));
    resolvePoll({ status: "completed", run: completedRun });
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: secondSession.id })));
    expect(screen.queryByText("Sync completed.")).not.toBeInTheDocument();
  });
});
