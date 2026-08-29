import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import type {
  RuntimeApi,
  RuntimeGroup,
  RuntimeGroupMember,
  RuntimeGroupMemberListInput,
  RuntimeGroupMemberPage,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { ToastProvider } from "@/shared/ui/Toast";
import { GroupsScreen } from "./GroupsScreen";

const session: RuntimeSession = {
  id: "session-id",
  name: "staging-session",
  status: "ready",
  phone: null,
  pushName: null,
  connectedAt: null,
  lastActiveAt: null,
  engineLoaded: true,
  lastError: null,
  restriction: null,
  gatewayCreatedAt: "2026-08-14T01:00:00.000Z",
  gatewayUpdatedAt: "2026-08-14T01:00:00.000Z",
  syncedAt: "2026-08-14T01:00:00.000Z",
};

const secondSession: RuntimeSession = {
  ...session,
  id: "second-session-id",
  name: "second-session",
};

function group(
  id = "group@g.us",
  name = "Release group",
  sessionId = session.id,
): RuntimeGroup {
  return {
    sessionId,
    id,
    name,
    description: null,
    ownerId: null,
    linkedParentId: null,
    participantsCount: 847,
    isAdmin: true,
    isReadOnly: false,
    isAnnounce: false,
    settingsLocked: false,
    isActive: true,
    detailsSyncedAt: "2026-08-14T01:00:00.000Z",
    syncedAt: "2026-08-14T01:00:00.000Z",
    sendCapability: {
      status: "ALLOWED",
      reason: "session_is_admin",
      checkedAt: "2026-08-14T01:00:00.000Z",
      invalidatedAt: null,
      revision: 1,
    },
  };
}

const firstGroup = group();
const secondSessionGroup = group(
  "second@g.us",
  "Second session group",
  secondSession.id,
);

function member(
  participantId: string,
  displayName: string | null,
  overrides: Partial<RuntimeGroupMember> = {},
): RuntimeGroupMember {
  return {
    participantId,
    phoneNumber: participantId.split("@")[0],
    displayName,
    identityType: "PHONE_JID",
    resolvedPhoneNumber: participantId.split("@")[0],
    displayNameSource: "OPENWA_CONTACT_NAME",
    projectionRevision: 10,
    isAdmin: false,
    isSuperAdmin: false,
    ...overrides,
  };
}

function memberPage(
  data: RuntimeGroupMember[],
  {
    datasetRevision = 10,
    offset = 0,
    total = data.length,
  }: { datasetRevision?: number; offset?: number; total?: number } = {},
): RuntimeGroupMemberPage {
  return {
    data,
    meta: { total, limit: 25, offset, datasetRevision },
  };
}

function Harness() {
  const { connect, connected, selectSession } = useRuntimeConnection();
  if (!connected) {
    return (
      <button
        onClick={() =>
          void connect({ baseUrl: "http://127.0.0.1:3100", apiKey: "0123456789abcdef0123456789abcdef" })
        }
      >
        Connect
      </button>
    );
  }
  return (
    <DrawerProvider>
      <button onClick={() => selectSession(secondSession.id)}>
        Switch session
      </button>
      <GroupsScreen />
      <DrawerHost />
    </DrawerProvider>
  );
}

function renderMembers(listGroupMembers: RuntimeApi["listGroupMembers"]) {
  const api = {
    getGroup: vi.fn((_sessionId: string, groupId: string) =>
      Promise.resolve(
        groupId === secondSessionGroup.id ? secondSessionGroup : firstGroup,
      ),
    ),
    listGroupMembers,
    listGroups: vi.fn(({ sessionId }: { sessionId: string }) =>
      Promise.resolve({
        data: [sessionId === secondSession.id ? secondSessionGroup : firstGroup],
        meta: { total: 1, limit: 20, offset: 0 },
      }),
    ),
    getCurrentGroupCapabilityRefresh: vi.fn().mockResolvedValue(null),
    getGroupCapabilityRefresh: vi.fn(),
    requestGroupCapabilityRefresh: vi.fn(),
  } as unknown as RuntimeApi;
  const view = render(
    <RuntimeConnectionProvider
      createApi={() => api}
      probeConnection={vi.fn().mockResolvedValue({
        sessionCount: 2,
        readySessions: 2,
        sessions: [session, secondSession],
      })}
    >
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </RuntimeConnectionProvider>,
  );
  return { api, ...view };
}

async function openMembers(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await user.click(
    await screen.findByRole("button", { name: "View Release group" }),
  );
  await user.click(screen.getByRole("tab", { name: /Members/ }));
}

describe("GroupsScreen Contacts v2 members", () => {
  it("renders distinct empty dataset and empty server-search states", async () => {
    const listGroupMembers = vi.fn().mockResolvedValue(
      memberPage([], { datasetRevision: 0 }),
    );
    const user = userEvent.setup();
    renderMembers(listGroupMembers);
    await openMembers(user);

    expect(
      await screen.findByText("No member details available."),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole("searchbox", { name: "Search synchronized members" }),
      "  missing  ",
    );
    expect(
      await screen.findByText("No synchronized members match this search."),
    ).toBeInTheDocument();
    expect(listGroupMembers).toHaveBeenLastCalledWith({
      sessionId: session.id,
      groupId: firstGroup.id,
      limit: 25,
      offset: 0,
      query: "missing",
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("renders deterministic enriched identity fallbacks without trusting LID phoneNumber", async () => {
    const page = memberPage([
      member("84900000001@c.us", "  Named member  "),
      member("123456789@lid", null, {
        phoneNumber: "123456789",
        identityType: "LID",
        resolvedPhoneNumber: null,
        displayNameSource: null,
      }),
      member("other@newsletter", "   ", {
        phoneNumber: "deprecated-other",
        identityType: null,
        resolvedPhoneNumber: null,
        displayNameSource: "RESOLVED_ALIAS_PUSH_NAME",
      }),
    ]);
    const listGroupMembers = vi.fn().mockResolvedValue(page);
    const user = userEvent.setup();
    renderMembers(listGroupMembers);
    await openMembers(user);

    expect(await screen.findByText("Named member")).toBeInTheDocument();
    expect(screen.getAllByText("Unnamed member")).toHaveLength(2);
    expect(screen.getByText("84900000001")).toBeInTheDocument();
    expect(screen.getByText("84900000001@c.us")).toBeInTheDocument();
    expect(screen.getByText("123456789@lid")).toBeInTheDocument();
    expect(screen.queryByText("123456789")).not.toBeInTheDocument();
    expect(screen.getByText("other@newsletter")).toBeInTheDocument();
    expect(screen.queryByText("deprecated-other")).not.toBeInTheDocument();
    expect(
      screen.queryByText("RESOLVED_ALIAS_PUSH_NAME"),
    ).not.toBeInTheDocument();
  });

  it("keeps stable projected pages and paginates from meta.total", async () => {
    const listGroupMembers = vi.fn((input: RuntimeGroupMemberListInput) =>
      Promise.resolve(
        input.offset === 25
          ? memberPage([member("last@c.us", "Last member")], {
              datasetRevision: 88,
              offset: 25,
              total: 30,
            })
          : memberPage([member("first@c.us", "First member")], {
              datasetRevision: 88,
              total: 30,
            }),
      ),
    );
    const user = userEvent.setup();
    renderMembers(listGroupMembers);
    await openMembers(user);
    expect(await screen.findByText("First member")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next member page" }));

    expect(await screen.findByText("Last member")).toBeInTheDocument();
    expect(screen.getByText("26–26 of 30")).toBeInTheDocument();
    expect(listGroupMembers).toHaveBeenCalledTimes(2);
  });

  it("rejects a changed next page, resets to page zero, and never mixes revisions", async () => {
    const responses = [
      memberPage([member("old-first@c.us", "Old first")], {
        datasetRevision: 5,
        total: 30,
      }),
      memberPage([member("mixed@c.us", "Must not render")], {
        datasetRevision: 6,
        offset: 25,
        total: 30,
      }),
      memberPage([member("new-first@c.us", "New first")], {
        datasetRevision: 6,
        total: 30,
      }),
    ];
    const listGroupMembers = vi.fn((_input: RuntimeGroupMemberListInput) =>
      Promise.resolve(responses.shift()!),
    );
    const user = userEvent.setup();
    renderMembers(listGroupMembers);
    await openMembers(user);
    expect(await screen.findByText("Old first")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next member page" }));

    expect(await screen.findByText("New first")).toBeInTheDocument();
    expect(screen.queryByText("Must not render")).not.toBeInTheDocument();
    expect(listGroupMembers.mock.calls.map(([input]) => input.offset)).toEqual([
      0,
      25,
      0,
    ]);
  });

  it("bounds revision recovery when projection changes again during page-zero reload", async () => {
    const responses = [
      memberPage([member("initial@c.us", "Initial")], {
        datasetRevision: 20,
        total: 30,
      }),
      memberPage([member("discarded@c.us", "Discarded")], {
        datasetRevision: 21,
        offset: 25,
        total: 30,
      }),
      memberPage([member("latest@c.us", "Latest snapshot")], {
        datasetRevision: 22,
        total: 30,
      }),
    ];
    const listGroupMembers = vi.fn((_input: RuntimeGroupMemberListInput) =>
      Promise.resolve(responses.shift()!),
    );
    const user = userEvent.setup();
    renderMembers(listGroupMembers);
    await openMembers(user);
    expect(await screen.findByText("Initial")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next member page" }));

    expect(await screen.findByText("Latest snapshot")).toBeInTheDocument();
    expect(listGroupMembers).toHaveBeenCalledTimes(3);
  });

  it("ignores a late page response after a trimmed server-side search changes revision", async () => {
    let resolveOldPage: ((page: RuntimeGroupMemberPage) => void) | undefined;
    const oldPage = new Promise<RuntimeGroupMemberPage>((resolve) => {
      resolveOldPage = resolve;
    });
    let searchCalls = 0;
    const listGroupMembers = vi.fn((input: RuntimeGroupMemberListInput) => {
      if (input.offset === 25) return oldPage;
      if (input.query === "needle") {
        searchCalls += 1;
        return Promise.resolve(
          memberPage([member("search@c.us", "Search result")], {
            datasetRevision: 31,
            total: 1,
          }),
        );
      }
      return Promise.resolve(
        memberPage([member("initial@c.us", "Initial")], {
          datasetRevision: 30,
          total: 30,
        }),
      );
    });
    const user = userEvent.setup();
    renderMembers(listGroupMembers);
    await openMembers(user);
    expect(await screen.findByText("Initial")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next member page" }));

    await user.type(
      screen.getByRole("searchbox", { name: "Search synchronized members" }),
      "  needle  ",
    );
    expect(await screen.findByText("Search result")).toBeInTheDocument();
    expect(searchCalls).toBe(2);
    expect(listGroupMembers).toHaveBeenLastCalledWith({
      sessionId: session.id,
      groupId: firstGroup.id,
      limit: 25,
      offset: 0,
      query: "needle",
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    await act(async () =>
      resolveOldPage?.(
        memberPage([member("late@c.us", "Late stale page")], {
          datasetRevision: 31,
          offset: 25,
          total: 30,
        }),
      ),
    );
    expect(screen.queryByText("Late stale page")).not.toBeInTheDocument();
    expect(screen.getByText("Search result")).toBeInTheDocument();
  });

  it("clamps an out-of-range offset and handles empty datasets and searches", async () => {
    let datasetEmpty = false;
    const listGroupMembers = vi.fn((input: RuntimeGroupMemberListInput) => {
      if (input.query === "missing") {
        return Promise.resolve(memberPage([], { datasetRevision: 40 }));
      }
      if (input.offset === 25) {
        datasetEmpty = true;
        return Promise.resolve(
          memberPage([], { datasetRevision: 40, offset: 25, total: 1 }),
        );
      }
      return Promise.resolve(
        memberPage(
          datasetEmpty
            ? [member("only@c.us", "Only member")]
            : [member("first@c.us", "First")],
          { datasetRevision: 40, total: datasetEmpty ? 1 : 26 },
        ),
      );
    });
    const user = userEvent.setup();
    renderMembers(listGroupMembers);
    await openMembers(user);
    expect(await screen.findByText("First")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next member page" }));
    expect(await screen.findByText("Only member")).toBeInTheDocument();
    expect(screen.getByText("1–1 of 1")).toBeInTheDocument();

    await user.type(
      screen.getByRole("searchbox", { name: "Search synchronized members" }),
      "missing",
    );
    expect(
      await screen.findByText("No synchronized members match this search."),
    ).toBeInTheDocument();
  });

  it("invalidates pending member responses on session change and unmount", async () => {
    let resolveFirstSession: ((page: RuntimeGroupMemberPage) => void) | undefined;
    const pending = new Promise<RuntimeGroupMemberPage>((resolve) => {
      resolveFirstSession = resolve;
    });
    const listGroupMembers = vi.fn((input: RuntimeGroupMemberListInput) =>
      input.sessionId === secondSession.id
        ? Promise.resolve(
            memberPage([member("second@c.us", "Second session member")], {
              datasetRevision: 50,
            }),
          )
        : pending,
    );
    const user = userEvent.setup();
    const { unmount } = renderMembers(listGroupMembers);
    await openMembers(user);
    await waitFor(() => expect(listGroupMembers).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Switch session" }));
    await user.click(
      await screen.findByRole("button", { name: "View Second session group" }),
    );
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    expect(await screen.findByText("Second session member")).toBeInTheDocument();

    await act(async () =>
      resolveFirstSession?.(
        memberPage([member("stale@c.us", "Stale first session")], {
          datasetRevision: 51,
        }),
      ),
    );
    expect(screen.queryByText("Stale first session")).not.toBeInTheDocument();
    unmount();
  });
});
