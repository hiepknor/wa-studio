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
  RuntimeGroup,
  RuntimeGroupDetail,
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

const group: RuntimeGroup = {
  sessionId: session.id,
  id: "120363000000000000@g.us",
  name: "Release room",
  description: "Coordinates the weekly release.",
  ownerId: null,
  linkedParentId: null,
  participantsCount: 2,
  isAdmin: true,
  isReadOnly: false,
  isAnnounce: false,
  settingsLocked: false,
  isActive: true,
  detailsSyncedAt: "2026-08-11T09:00:00.000Z",
  syncedAt: "2026-08-11T09:00:00.000Z",
  sendCapability: {
    status: "ALLOWED",
    reason: "session_is_admin",
    checkedAt: "2026-08-11T09:00:00.000Z",
    invalidatedAt: null,
    revision: 1,
  },
};

const groupDetail: RuntimeGroupDetail = {
  ...group,
};

const groupMemberPage = {
  data: [
    {
      participantId: "84900000000@c.us",
      phoneNumber: "84900000000",
      displayName: "Hiep Mai",
      isAdmin: true,
      isSuperAdmin: false,
    },
  ],
  meta: { total: 1, limit: 25, offset: 0 },
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
    expect(screen.getByRole("button", { name: "Groups" })).toBeEnabled();
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

  it("browses paginated groups, inspects members, and queues capability refresh", async () => {
    const user = userEvent.setup();
    const secondGroup = { ...group, id: "second@g.us", name: "Product room" };
    const listGroups = vi
      .fn()
      .mockResolvedValueOnce({ data: [group], meta: { total: 21, limit: 20, offset: 0 } })
      .mockResolvedValueOnce({ data: [secondGroup], meta: { total: 21, limit: 20, offset: 20 } });
    const getGroup = vi.fn().mockResolvedValue(groupDetail);
    const listGroupMembers = vi.fn().mockResolvedValue(groupMemberPage);
    const requestGroupCapabilityRefresh = vi.fn().mockResolvedValue(undefined);
    const fakeApi = {
      getGroup,
      getSessionSyncRun: vi.fn(),
      listGroupMembers,
      listGroups,
      listSessions: vi.fn(),
      requestGroupCapabilityRefresh,
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
    await user.click(await screen.findByRole("button", { name: "Groups" }));

    expect(await screen.findByRole("heading", { name: "Groups" })).toBeInTheDocument();
    await waitFor(() => expect(listGroups).toHaveBeenCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
    }));
    expect(screen.getByText("1–1 of 21")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View Release room" }));
    await waitFor(() => expect(getGroup).toHaveBeenCalledWith(session.id, group.id));
    await waitFor(() => expect(listGroupMembers).toHaveBeenCalledWith({
      sessionId: session.id,
      groupId: group.id,
      limit: 25,
      offset: 0,
    }));
    expect(await screen.findByRole("dialog", { name: "Release room" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(await screen.findByText("Hiep Mai")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Send readiness" })).toBeInTheDocument();
    expect(screen.getByText("The active session is a group administrator.")).toBeInTheDocument();
    expect(screen.getByText("session_is_admin")).toBeInTheDocument();
    expect(screen.getByText("1 synced of 2")).toBeInTheDocument();
    expect(screen.getByText(/1 synchronized member records are available for 2 participants/))
      .toBeInTheDocument();
    expect(screen.getByText("All members")).toBeInTheDocument();
    expect(screen.getByText("Unlocked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy group ID" }));
    expect(screen.getByRole("button", { name: "Copied group ID" })).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(group.id);

    await user.click(screen.getByRole("button", { name: "Refresh capability" }));
    await waitFor(() => expect(requestGroupCapabilityRefresh).toHaveBeenCalledWith(
      session.id,
      group.id,
    ));
    await waitFor(() => expect(getGroup).toHaveBeenCalledTimes(2));
    expect(listGroupMembers).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Runtime is still processing/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 20,
    }));
    expect(await screen.findByText("Product room")).toBeInTheDocument();
  });

  it("pages and searches the synchronized member dataset on the server", async () => {
    const user = userEvent.setup();
    let resolveStaleSearch: ((value: typeof groupMemberPage) => void) | undefined;
    const staleSearch = new Promise<typeof groupMemberPage>((resolve) => {
      resolveStaleSearch = resolve;
    });
    const nowOutOfRangePage = {
      data: [],
      meta: { total: 1, limit: 25, offset: 25 },
    };
    const freshSearchPage = {
      data: [{
        participantId: "server-result@c.us",
        phoneNumber: "84888888888",
        displayName: "Backend-selected result",
        isAdmin: false,
        isSuperAdmin: false,
      }],
      meta: { total: 1, limit: 25, offset: 0 },
    };
    const listGroupMembers = vi.fn((input: {
      offset?: number;
      query?: string;
    }) => {
      if (input.query === "needle") return staleSearch;
      if (input.query === "fresh") return Promise.resolve(freshSearchPage);
      if (input.query === "no matches") return Promise.resolve({
        data: [],
        meta: { total: 0, limit: 25, offset: 0 },
      });
      if (input.offset === 25) return Promise.resolve(nowOutOfRangePage);
      return Promise.resolve({
        ...groupMemberPage,
        meta: { total: 30, limit: 25, offset: 0 },
      });
    });
    const fakeApi = {
      getGroup: vi.fn().mockResolvedValue(groupDetail),
      getSessionSyncRun: vi.fn(),
      listGroupMembers,
      listGroups: vi.fn().mockResolvedValue({
        data: [group],
        meta: { total: 1, limit: 20, offset: 0 },
      }),
      listSessions: vi.fn(),
      requestGroupCapabilityRefresh: vi.fn(),
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
    await user.click(await screen.findByRole("button", { name: "Groups" }));
    await user.click(await screen.findByRole("button", { name: "View Release room" }));

    expect(await screen.findByText("1–1 of 30")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next member page" }));
    await waitFor(() => expect(listGroupMembers).toHaveBeenCalledWith({
      sessionId: session.id,
      groupId: group.id,
      limit: 25,
      offset: 25,
    }));
    await waitFor(() => expect(listGroupMembers).toHaveBeenLastCalledWith({
      sessionId: session.id,
      groupId: group.id,
      limit: 25,
      offset: 0,
    }));
    expect(screen.getByText("Hiep Mai")).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search synchronized members" });
    await user.clear(search);
    await user.type(search, "needle");
    await waitFor(() => expect(listGroupMembers).toHaveBeenLastCalledWith({
      sessionId: session.id,
      groupId: group.id,
      limit: 25,
      offset: 0,
      query: "needle",
    }));

    await user.clear(search);
    await user.type(search, "fresh");
    expect(await screen.findByText("Backend-selected result")).toBeInTheDocument();
    expect(screen.getByText("1 matches")).toBeInTheDocument();

    await act(async () => {
      resolveStaleSearch?.({
        data: [{
          participantId: "stale@c.us",
          phoneNumber: "84777777777",
          displayName: "Stale response",
          isAdmin: false,
          isSuperAdmin: false,
        }],
        meta: { total: 1, limit: 25, offset: 0 },
      });
    });
    expect(screen.queryByText("Stale response")).not.toBeInTheDocument();
    expect(screen.getByText("Backend-selected result")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "   ");
    await waitFor(() => expect(listGroupMembers).toHaveBeenLastCalledWith({
      sessionId: session.id,
      groupId: group.id,
      limit: 25,
      offset: 0,
    }));

    await user.clear(search);
    await user.type(search, "no matches");
    await waitFor(() => expect(listGroupMembers).toHaveBeenLastCalledWith({
      sessionId: session.id,
      groupId: group.id,
      limit: 25,
      offset: 0,
      query: "no matches",
    }));
    expect(await screen.findByText("No synchronized members match this search."))
      .toBeInTheDocument();
  });

  it("does not show a late member response from a previously selected group", async () => {
    const user = userEvent.setup();
    const secondGroup = { ...group, id: "second@g.us", name: "Product room" };
    let resolveFirstGroup: ((value: typeof groupMemberPage) => void) | undefined;
    const firstGroupMembers = new Promise<typeof groupMemberPage>((resolve) => {
      resolveFirstGroup = resolve;
    });
    const secondGroupMembers = {
      data: [{
        participantId: "product@c.us",
        phoneNumber: "84666666666",
        displayName: "Product member",
        isAdmin: false,
        isSuperAdmin: false,
      }],
      meta: { total: 1, limit: 25, offset: 0 },
    };
    const fakeApi = {
      getGroup: vi.fn((_sessionId: string, groupId: string) => Promise.resolve(
        groupId === secondGroup.id ? { ...groupDetail, ...secondGroup } : groupDetail,
      )),
      getSessionSyncRun: vi.fn(),
      listGroupMembers: vi.fn(({ groupId }: { groupId: string }) =>
        groupId === secondGroup.id ? Promise.resolve(secondGroupMembers) : firstGroupMembers),
      listGroups: vi.fn().mockResolvedValue({
        data: [group, secondGroup],
        meta: { total: 2, limit: 20, offset: 0 },
      }),
      listSessions: vi.fn(),
      requestGroupCapabilityRefresh: vi.fn(),
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
    await user.click(await screen.findByRole("button", { name: "Groups" }));
    await user.click(await screen.findByRole("button", { name: "View Release room" }));
    await waitFor(() => expect(fakeApi.listGroupMembers).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await user.click(screen.getByRole("button", { name: "View Product room" }));
    expect(await screen.findByText("Product member")).toBeInTheDocument();

    await act(async () => {
      resolveFirstGroup?.(groupMemberPage);
    });
    expect(screen.queryByText("Hiep Mai")).not.toBeInTheDocument();
    expect(screen.getByText("Product member")).toBeInTheDocument();
  });

  it("keeps the selected group name visible when detail loading fails", async () => {
    const user = userEvent.setup();
    const longName = "Nhóm điều phối ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 không được mất tên";
    const longNameGroup = { ...group, name: longName };
    const getGroup = vi.fn().mockRejectedValue(new Error("Runtime detail unavailable."));
    const fakeApi = {
      getGroup,
      getSessionSyncRun: vi.fn(),
      listGroupMembers: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, limit: 25, offset: 0 },
      }),
      listGroups: vi.fn().mockResolvedValue({
        data: [longNameGroup],
        meta: { total: 1, limit: 20, offset: 0 },
      }),
      listSessions: vi.fn(),
      requestGroupCapabilityRefresh: vi.fn(),
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
    await user.click(await screen.findByRole("button", { name: "Groups" }));
    await user.click(await screen.findByRole("button", { name: `View ${longName}` }));

    expect(await screen.findByRole("dialog", { name: longName })).toBeInTheDocument();
    expect(await screen.findByText("Runtime detail unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: longName })).toHaveAttribute("title", longName);
  });
});
