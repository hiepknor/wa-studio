import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import type {
  RuntimeApi,
  RuntimeGroup,
  RuntimeGroupDetail,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import { RuntimeTransportError } from "@/shared/api/runtime-http";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { ToastProvider } from "@/shared/ui/Toast";

const pollCapabilityRefresh = vi.hoisted(() => vi.fn());

vi.mock("./capability-refresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capability-refresh")>()),
  pollCapabilityRefresh,
}));

import { GroupsScreen } from "./GroupsScreen";

const session: RuntimeSession = {
  id: "session-id",
  name: "staging-session-2",
  status: "ready",
  phone: "84900000000",
  pushName: "Staging",
  connectedAt: null,
  lastActiveAt: null,
  engineLoaded: true,
  lastError: null,
  restriction: null,
  gatewayCreatedAt: "2026-08-13T01:00:00.000Z",
  gatewayUpdatedAt: "2026-08-13T01:00:00.000Z",
  syncedAt: "2026-08-13T01:00:00.000Z",
};
const secondSession: RuntimeSession = {
  ...session,
  id: "second-session-id",
  name: "other-session",
};

const group: RuntimeGroup = {
  sessionId: session.id,
  id: "group@g.us",
  name: "Staging group",
  description: null,
  ownerId: null,
  linkedParentId: null,
  participantsCount: 847,
  isAdmin: true,
  isReadOnly: false,
  isAnnounce: false,
  settingsLocked: false,
  isActive: true,
  detailsSyncedAt: "2026-08-13T01:00:00.000Z",
  syncedAt: "2026-08-13T01:00:00.000Z",
  sendCapability: {
    status: "UNKNOWN",
    reason: "MANUAL_REFRESH",
    checkedAt: "2026-08-13T00:59:00.000Z",
    invalidatedAt: "2026-08-13T01:00:00.000Z",
    revision: 8,
  },
};

const detail: RuntimeGroupDetail = { ...group };
const secondGroup: RuntimeGroup = {
  ...group,
  id: "second-group@g.us",
  name: "Second group",
};
const firstMemberPage = {
  data: [
    {
      participantId: "first@c.us",
      phoneNumber: "84900000001",
      displayName: "First member",
      identityType: "PHONE_JID" as const,
      resolvedPhoneNumber: "84900000001",
      displayNameSource: "OPENWA_CONTACT_NAME" as const,
      projectionRevision: 0,
      isAdmin: false,
      isSuperAdmin: false,
    },
  ],
  meta: { total: 30, limit: 25, offset: 0, datasetRevision: 0 },
};
const secondMemberPage = {
  data: [
    {
      participantId: "last@c.us",
      phoneNumber: "84900000030",
      displayName: "Last member",
      identityType: "PHONE_JID" as const,
      resolvedPhoneNumber: "84900000030",
      displayNameSource: "OPENWA_CONTACT_NAME" as const,
      projectionRevision: 0,
      isAdmin: false,
      isSuperAdmin: false,
    },
  ],
  meta: { total: 30, limit: 25, offset: 25, datasetRevision: 0 },
};

function GroupsHarness() {
  const { connect, connected, selectSession } = useRuntimeConnection();
  if (!connected) {
    return (
      <button
        onClick={() =>
          void connect({ baseUrl: "http://127.0.0.1:3100", apiKey: "0123456789abcdef0123456789abcdef" })
        }
        type="button"
      >
        Connect
      </button>
    );
  }
  return (
    <DrawerProvider>
      <button onClick={() => selectSession(secondSession.id)} type="button">
        Switch session
      </button>
      <GroupsScreen />
      <DrawerHost />
    </DrawerProvider>
  );
}

function renderGroups(overrides: Partial<RuntimeApi> = {}) {
  const listGroupMembers = vi.fn(({ offset }: { offset?: number }) =>
    Promise.resolve(offset === 25 ? secondMemberPage : firstMemberPage),
  );
  const api = {
    getGroup: vi.fn().mockResolvedValue(detail),
    listGroupMembers,
    listGroups: vi.fn().mockResolvedValue({
      data: [group],
      meta: { total: 1, limit: 20, offset: 0 },
    }),
    requestGroupCapabilityRefresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RuntimeApi;
  render(
    <RuntimeConnectionProvider
      createApi={() => api}
      probeConnection={vi.fn().mockResolvedValue({
        sessionCount: 2,
        readySessions: 2,
        sessions: [session, secondSession],
      })}
    >
      <ToastProvider>
        <GroupsHarness />
      </ToastProvider>
    </RuntimeConnectionProvider>,
  );
  return { api, listGroupMembers };
}

async function openInspector(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await user.click(
    await screen.findByRole("button", { name: "View Staging group" }),
  );
  await screen.findByRole("dialog", { name: "Staging group" });
  expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

async function openMembers(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: /Members/ }));
  await screen.findByText("First member");
}

describe("GroupsScreen capability refresh", () => {
  afterEach(() => {
    pollCapabilityRefresh.mockReset();
    vi.restoreAllMocks();
  });

  it("presents stale definitive capability as warning in both list and inspector", async () => {
    const user = userEvent.setup();
    const staleAllowedGroup = {
      ...group,
      sendCapability: {
        ...group.sendCapability,
        status: "ALLOWED" as const,
      },
    };
    renderGroups({
      getGroup: vi.fn().mockResolvedValue(staleAllowedGroup),
      listGroups: vi.fn().mockResolvedValue({
        data: [staleAllowedGroup],
        meta: { total: 1, limit: 20, offset: 0 },
      }),
    });

    await user.click(screen.getByRole("button", { name: "Connect" }));

    const listStatus = await screen.findByLabelText("Allowed, stale");
    expect(listStatus).toHaveClass("ui-badge-warning");
    expect(listStatus).toHaveTextContent("Allowed · stale");
    expect(screen.getByText("847").closest("td")).toHaveClass(
      "data-cell-number",
    );

    await user.click(
      screen.getByRole("button", { name: "View Staging group" }),
    );

    const capabilityCard = await screen.findByRole("heading", {
      name: "Send readiness",
    });
    const inspectorStatus = capabilityCard
      .closest("section")
      ?.querySelector<HTMLElement>("[aria-label='Allowed, stale']");
    expect(inspectorStatus).toHaveClass("ui-badge-warning");
    expect(inspectorStatus).toHaveTextContent("Allowed");
    expect(capabilityCard.closest("section")).toHaveTextContent("Stale");
  });

  it("shows requested then timeout semantics while preserving the member page", async () => {
    const user = userEvent.setup();
    let resolvePoll:
      | ((result: { status: "timed-out"; detail: null; error: null }) => void)
      | undefined;
    pollCapabilityRefresh.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
    );
    const { listGroupMembers } = renderGroups();
    await openInspector(user);
    expect(listGroupMembers).not.toHaveBeenCalled();
    await openMembers(user);
    const search = screen.getByRole("searchbox", {
      name: "Search synchronized members",
    });
    await user.type(search, "needle");
    await waitFor(() =>
      expect(listGroupMembers).toHaveBeenLastCalledWith({
        sessionId: session.id,
        groupId: group.id,
        limit: 25,
        offset: 0,
        query: "needle",
      }, expect.objectContaining({ signal: expect.any(AbortSignal) })),
    );
    await user.click(screen.getByRole("button", { name: "Next member page" }));
    expect(await screen.findByText("Last member")).toBeInTheDocument();
    expect(screen.getByText("26–26 of 30")).toBeInTheDocument();
    const memberCallsBeforeRefresh = listGroupMembers.mock.calls.length;

    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await user.click(
      screen.getByRole("button", { name: "Refresh capability" }),
    );

    expect(await screen.findByText("Refresh requested")).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for WA Runtime to publish a new result…"),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("heading", { name: "Send readiness" })
        .closest("section"),
    ).toContainElement(
      screen.getByText("Refresh requested").closest("[role='status']"),
    );
    expect(screen.queryByText("Capability updated")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refreshing capability…" }),
    ).toBeDisabled();
    expect(listGroupMembers).toHaveBeenCalledTimes(memberCallsBeforeRefresh);

    await act(async () =>
      resolvePoll?.({ status: "timed-out", detail: null, error: null }),
    );

    expect(screen.getByText("Refresh still processing")).toBeInTheDocument();
    expect(screen.getByText("Reopen or retry shortly.")).toBeInTheDocument();
    expect(screen.queryByText("Capability updated")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Members/ }));
    expect(screen.getByText("Last member")).toBeInTheDocument();
    expect(screen.getByText("26–26 of 30")).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search synchronized members" }),
    ).toHaveValue("needle");
    expect(listGroupMembers).toHaveBeenCalledTimes(memberCallsBeforeRefresh);
  });

  it("keeps POST failures retryable without reading detail or members again", async () => {
    const user = userEvent.setup();
    const requestGroupCapabilityRefresh = vi
      .fn()
      .mockRejectedValue(
        new Error("Could not refresh send capability (HTTP 503)."),
      );
    const { api, listGroupMembers } = renderGroups({
      requestGroupCapabilityRefresh,
    });
    await openInspector(user);
    const detailCalls = vi.mocked(api.getGroup).mock.calls.length;
    const memberCalls = listGroupMembers.mock.calls.length;

    await user.click(
      screen.getByRole("button", { name: "Refresh capability" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not refresh send capability (HTTP 503).",
    );
    expect(
      screen.getByRole("button", { name: "Refresh capability" }),
    ).toBeEnabled();
    expect(api.getGroup).toHaveBeenCalledTimes(detailCalls);
    expect(listGroupMembers).toHaveBeenCalledTimes(memberCalls);
    expect(pollCapabilityRefresh).not.toHaveBeenCalled();
  });

  it("continues observing capability state after the POST result is unconfirmed", async () => {
    const user = userEvent.setup();
    const refreshed = {
      ...detail,
      sendCapability: {
        ...detail.sendCapability,
        checkedAt: "2026-08-13T01:01:00.000Z",
        invalidatedAt: null,
        revision: 9,
        status: "ALLOWED" as const,
      },
    };
    pollCapabilityRefresh.mockResolvedValue({
      detail: refreshed,
      status: "completed",
    });
    renderGroups({
      requestGroupCapabilityRefresh: vi.fn().mockRejectedValue(
        new RuntimeTransportError("response lost", { requestDispatched: true }),
      ),
    });
    await openInspector(user);

    await user.click(screen.getByRole("button", { name: "Refresh capability" }));

    expect(await screen.findByText("Capability updated")).toBeInTheDocument();
    expect(pollCapabilityRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("The latest capability result is now shown.")).toBeInTheDocument();
  });

  it("aborts and ignores the pending refresh when the inspector closes", async () => {
    const user = userEvent.setup();
    pollCapabilityRefresh.mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ status: "cancelled" }),
            { once: true },
          );
        }),
    );
    renderGroups();
    await openInspector(user);
    await user.click(
      screen.getByRole("button", { name: "Refresh capability" }),
    );
    expect(await screen.findByText("Refresh requested")).toBeInTheDocument();
    const signal = pollCapabilityRefresh.mock.calls[0][0].signal as AbortSignal;

    await user.click(screen.getByRole("button", { name: "Close drawer" }));

    expect(signal.aborted).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("invalidates the pending refresh synchronously when the session changes", async () => {
    const user = userEvent.setup();
    pollCapabilityRefresh.mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ status: "cancelled" }),
            { once: true },
          );
        }),
    );
    renderGroups();
    await openInspector(user);
    await user.click(
      screen.getByRole("button", { name: "Refresh capability" }),
    );
    expect(await screen.findByText("Refresh requested")).toBeInTheDocument();
    const signal = pollCapabilityRefresh.mock.calls[0][0].signal as AbortSignal;

    act(() => screen.getByRole("button", { name: "Switch session" }).click());

    expect(signal.aborted).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("aborts the old flow before opening a different group", async () => {
    const user = userEvent.setup();
    pollCapabilityRefresh.mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ status: "cancelled" }),
            { once: true },
          );
        }),
    );
    renderGroups({
      getGroup: vi.fn((_sessionId: string, groupId: string) =>
        Promise.resolve(
          groupId === secondGroup.id ? { ...detail, ...secondGroup } : detail,
        ),
      ),
      listGroups: vi.fn().mockResolvedValue({
        data: [group, secondGroup],
        meta: { total: 2, limit: 20, offset: 0 },
      }),
    });
    await openInspector(user);
    await user.click(
      screen.getByRole("button", { name: "Refresh capability" }),
    );
    expect(await screen.findByText("Refresh requested")).toBeInTheDocument();
    const signal = pollCapabilityRefresh.mock.calls[0][0].signal as AbortSignal;

    act(() =>
      screen.getByRole("button", { name: "View Second group" }).click(),
    );

    expect(signal.aborted).toBe(true);
    expect(
      await screen.findByRole("dialog", { name: "Second group" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Capability updated")).not.toBeInTheDocument();
  });
});
