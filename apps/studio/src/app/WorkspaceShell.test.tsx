import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "./RuntimeConnectionContext";
import { WorkspaceShell } from "./WorkspaceShell";
import type {
  RuntimeApi,
  RuntimeConnectionResult,
  RuntimeGroup,
  RuntimeGroupCapabilityRefresh,
  RuntimeGroupDetail,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import type { ManagedRuntimeProvisioningProfile } from "@/shared/native/managed-runtime";
import { ToastProvider } from "@/shared/ui/Toast";

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

const capabilityOperation: RuntimeGroupCapabilityRefresh = {
  sessionId: session.id,
  groupId: group.id,
  requestRevision: 1,
  status: "PENDING",
  source: "MANUAL",
  attemptCount: 0,
  requestedAt: "2026-08-11T09:00:00.000Z",
  startedAt: null,
  nextAttemptAt: "2026-08-11T09:00:00.000Z",
  completedAt: null,
  errorCode: null,
};

const groupMemberPage = {
  data: [
    {
      participantId: "84900000000@c.us",
      phoneNumber: "84900000000",
      displayName: "Hiep Mai",
      identityType: "PHONE_JID" as const,
      resolvedPhoneNumber: "84900000000",
      displayNameSource: "OPENWA_CONTACT_NAME" as const,
      projectionRevision: 0,
      isAdmin: true,
      isSuperAdmin: false,
    },
  ],
  meta: { total: 1, limit: 25, offset: 0, datasetRevision: 0 },
};

interface WorkspaceHarnessProps {
  getProvisioningProfile?: () => Promise<ManagedRuntimeProvisioningProfile | null>;
}

const noProvisioningProfile = async () => null;

function WorkspaceHarness({
  getProvisioningProfile = noProvisioningProfile,
}: WorkspaceHarnessProps = {}) {
  const { connect, connected, selectedSessionId } = useRuntimeConnection();
  if (connected)
    return (
      <ToastProvider>
        <WorkspaceShell getProvisioningProfile={getProvisioningProfile} />
      </ToastProvider>
    );
  return (
    <>
      <span>Selected: {selectedSessionId ?? "none"}</span>
      <button
        onClick={() =>
          connect({ baseUrl: "http://127.0.0.1:3100", apiKey: "0123456789abcdef0123456789abcdef" })
        }
        type="button"
      >
        Connect test WA Runtime
      </button>
    </>
  );
}

describe("WorkspaceShell", () => {
  beforeEach(() => window.localStorage.clear());

  it("enters the product shell, selects the ready session, and disconnects from Sessions", async () => {
    const user = userEvent.setup();
    const connectionResult: RuntimeConnectionResult = {
      sessionCount: 1,
      readySessions: 1,
      sessions: [session],
    };
    const probeConnection = vi.fn().mockResolvedValue(connectionResult);
    const fakeApi = {
      getOperationalHealth: vi.fn().mockResolvedValue({
        status: "operational",
        service: "wa-runtime",
        version: "0.1.0",
        instanceId: "test",
        dependencies: { postgres: true, queue: { backend: "postgres", ready: true } },
        processes: { worker: "healthy", scheduler: "healthy" },
        components: {
          openwa: {
            status: "COMPATIBLE",
            expectedRelease: "0.23.3",
            observedRelease: "0.23.3",
            checkedAt: "2026-08-29T00:00:00.000Z",
            lastSuccessfulAt: "2026-08-29T00:00:00.000Z",
            reason: null,
          },
        },
      }),
      getSessionSyncRun: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([session]),
      requestSessionSync: vi.fn(),
    } as unknown as RuntimeApi;

    render(
      <RuntimeConnectionProvider
        createApi={() => fakeApi}
        probeConnection={probeConnection}
      >
        <WorkspaceHarness
          getProvisioningProfile={async () => ({
            openwaBaseUrl: "https://openwa.onio.cc",
            openwaAllowedSessionIds: [session.id],
            allowLiveSends: false,
            eventInboxBaseUrl: "https://wa-events.onio.cc",
          })}
        />
      </RuntimeConnectionProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    );

    expect(await screen.findByRole("button", { name: "Groups" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Current view")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Active session" }),
    ).toHaveTextContent("dev-session");
    await user.click(screen.getByRole("button", { name: "Active session" }));
    expect(screen.getByRole("combobox", { name: "Search sessions" })).toHaveFocus();
    const sessionListbox = screen.getByRole("listbox", { name: "Gateway sessions" });
    expect(within(sessionListbox).getByText("Development · 84900000000"))
      .toBeInTheDocument();
    const optionStatus = within(sessionListbox).getByText("ready")
      .closest(".workspace-session-status");
    expect(optionStatus).toHaveAttribute("data-tone", "success");
    expect(optionStatus).not.toHaveClass("ui-badge");
    expect(optionStatus?.querySelector(".status-dot.status-tone-success"))
      .toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Active session" })).toHaveFocus();
    expect(screen.getByLabelText("Workspace build")).toHaveTextContent(/Local workspace.*v0\.2\.0/);
    const shell = screen.getByRole("main");
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(shell).toHaveAttribute("data-rail-collapsed", "true");
    expect(window.localStorage.getItem("wa-studio-rail-collapsed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(shell).not.toHaveAttribute("data-rail-collapsed");
    const statusBar = screen.getByLabelText("Workspace status");
    expect(await within(statusBar).findByText("Connected locally")).toBeInTheDocument();
    expect(statusBar.querySelector(".status-dot.status-tone-success")).toBeInTheDocument();
    expect(within(statusBar).getByText("dev-session")).toBeInTheDocument();
    expect(within(statusBar).getByText("healthy")).toBeInTheDocument();
    expect(within(statusBar).queryByText(/127\.0\.0\.1:3100/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Groups" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Groups" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Runs" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Activity" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Groups" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
    expect(screen.queryByRole("button", { name: "Disconnect workspace" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
    const sessionsTable = screen.getByRole("table", {
      name: "WA Runtime sessions",
    });
    expect(within(sessionsTable).getByText(session.name)).toHaveClass(
      "data-primary-text",
    );
    expect(
      within(sessionsTable).getByText(`${session.pushName} · ${session.phone}`),
    ).toHaveClass("data-secondary-text");
    expect(
      within(sessionsTable).getByText(session.name).closest("td"),
    ).toHaveClass("data-cell-primary");
    expect(screen.getByText("Selected").closest("td")).toHaveClass(
      "data-cell-action",
    );

    expect(
      screen.getByRole("button", { name: "Reload sessions" }),
    ).toHaveTextContent("Reload");
    expect(
      screen.queryByRole("button", { name: /Sync/i }),
    ).not.toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "WA Runtime" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Disconnect workspace" }),
    );
    const disconnectDialog = screen.getByRole("dialog", {
      name: "Disconnect workspace?",
    });
    expect(disconnectDialog).toHaveTextContent("Runtime and active syncs continue");
    await user.click(
      within(disconnectDialog).getByRole("button", { name: "Disconnect" }),
    );
    expect(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Selected: none")).toBeInTheDocument();
  });

  it("cross-navigates from an Activity event to its durable run", async () => {
    const user = userEvent.setup();
    const runId = "11111111-1111-4111-8111-111111111111";
    const campaignId = "22222222-2222-4222-8222-222222222222";
    const progress = {
      total: 1, pending: 0, materialized: 0, processing: 0, dryRunCompleted: 0,
      accepted: 0, sent: 0, delivered: 1, read: 0, failed: 0, unknown: 0,
      blocked: 0, cancelled: 0,
    };
    const getCampaignRun = vi.fn().mockResolvedValue({
      id: runId,
      campaignId,
      campaignNameSnapshot: "Product release",
      sessionId: session.id,
      executionMode: "LIVE",
      status: "COMPLETED",
      statusReason: null,
      text: "Immutable message",
      targetSource: null,
      preflight: null,
      campaignRevision: 2,
      targetsRevision: 3,
      totalTargets: 1,
      progress,
      scheduledAt: "2026-08-25T10:00:00.000Z",
      startedAt: "2026-08-25T10:00:01.000Z",
      completedAt: "2026-08-25T10:00:02.000Z",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:00:02.000Z",
    });
    const fakeApi = {
      getCampaignRun,
      getSessionSyncRun: vi.fn(),
      listActivity: vi.fn().mockResolvedValue({
        data: [{
          id: "33333333-3333-4333-8333-333333333333",
          sessionId: session.id,
          eventType: "campaign_run.completed",
          eventVersion: 1,
          category: "RUN",
          severity: "SUCCESS",
          origin: "RUNTIME",
          subject: { type: "CAMPAIGN_RUN", id: runId, labelSnapshot: "Product release" },
          related: { campaignId, runId, syncRunId: null, groupId: null },
          correlationId: null,
          metadata: {},
          occurredAt: "2026-08-25T10:00:02.000Z",
        }],
        meta: { limit: 50, nextCursor: null, retentionDays: 90 },
      }),
      listRuns: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, limit: 50, offset: 0 },
      }),
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

    await user.click(screen.getByRole("button", { name: "Connect test WA Runtime" }));
    await user.click(await screen.findByRole("button", { name: "Activity" }));
    await user.click(await screen.findByRole("button", { name: "Campaign run completed" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Campaign run completed" }))
      .getByRole("button", { name: "Open run" }));

    expect(await screen.findByRole("heading", { name: "Runs" })).toBeInTheDocument();
    await waitFor(() =>
      expect(getCampaignRun).toHaveBeenCalledWith(
        runId,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(await screen.findByRole("dialog", { name: "Product release" })).toBeInTheDocument();
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

    await user.click(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    );
    await user.click(await screen.findByRole("button", { name: "Sessions" }));
    await user.click(
      await screen.findByRole("button", { name: "Reload sessions" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Disconnect workspace" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Disconnect",
      }),
    );

    await act(async () => resolveRefresh?.([session]));

    expect(screen.getByText("Selected: none")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    ).toBeInTheDocument();
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

    await user.click(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    );
    const sessionTrigger = await screen.findByRole("button", {
      name: "Active session",
    });
    sessionTrigger.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(sessionTrigger).toHaveTextContent("standby-session");
    expect(within(screen.getByLabelText("Workspace status"))
      .getByText("standby-session")).toBeInTheDocument();

    await user.click(sessionTrigger);
    expect(
      screen.getByRole("listbox", { name: "Gateway sessions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage sessions" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(sessionTrigger).toHaveFocus();
  });

  it("requires confirmation before disconnecting and restores focus after Cancel or Escape", async () => {
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

    await user.click(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    );
    await user.click(await screen.findByRole("button", { name: "Sessions" }));
    const disconnectButton = await screen.findByRole("button", {
      name: "Disconnect workspace",
    });
    await user.click(disconnectButton);
    const dialog = screen.getByRole("dialog", {
      name: "Disconnect workspace?",
    });
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(disconnectButton).toHaveFocus();

    await user.click(disconnectButton);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Sessions" }),
    ).toBeInTheDocument();
    expect(disconnectButton).toHaveFocus();
  });

  it("browses paginated groups, inspects members, and queues capability refresh", async () => {
    const user = userEvent.setup();
    const secondGroup = { ...group, id: "second@g.us", name: "Product room" };
    const listGroups = vi
      .fn()
      .mockResolvedValueOnce({
        data: [group],
        meta: { total: 21, limit: 20, offset: 0 },
      })
      .mockResolvedValueOnce({
        data: [group],
        meta: { total: 21, limit: 20, offset: 0 },
      })
      .mockResolvedValueOnce({
        data: [secondGroup],
        meta: { total: 21, limit: 20, offset: 20 },
      });
    const refreshedDetail = {
      ...groupDetail,
      detailsSyncedAt: "2026-08-11T09:01:00.000Z",
      sendCapability: {
        ...groupDetail.sendCapability,
        checkedAt: "2026-08-11T09:01:00.000Z",
      },
    };
    const getGroup = vi
      .fn()
      .mockResolvedValueOnce(groupDetail)
      .mockResolvedValue(refreshedDetail);
    const listGroupMembers = vi.fn().mockResolvedValue(groupMemberPage);
    const requestGroupCapabilityRefresh = vi.fn().mockResolvedValue(capabilityOperation);
    const fakeApi = {
      getGroup,
      getCurrentGroupCapabilityRefresh: vi.fn().mockResolvedValue(null),
      getGroupCapabilityRefresh: vi.fn().mockResolvedValue({
        ...capabilityOperation,
        status: "COMPLETED",
        nextAttemptAt: null,
        completedAt: "2026-08-11T09:01:00.000Z",
      }),
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

    await user.click(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    );
    await user.click(await screen.findByRole("button", { name: "Groups" }));

    expect(
      await screen.findByRole("heading", { name: "Groups" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Groups synchronized for ${session.name}.`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload groups" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync groups" })).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Participants" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Record synced" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(listGroups).toHaveBeenCalledWith(
        {
          sessionId: session.id,
          limit: 20,
          offset: 0,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.getByText("1–1 of 21")).toBeInTheDocument();
    expect(screen.getByText(group.name)).toHaveClass("data-primary-text");
    expect(screen.getByText(group.id)).toHaveClass("data-identifier");
    expect(screen.getByText(group.id).closest("td")).toHaveClass(
      "data-cell-primary",
    );
    expect(
      screen.getByRole("button", { name: `View ${group.name}` }).closest("td"),
    ).toHaveClass("data-cell-action");

    await user.click(screen.getByRole("button", { name: "View Release room" }));
    await waitFor(() =>
      expect(getGroup).toHaveBeenCalledWith(
        session.id,
        group.id,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(listGroupMembers).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("tab", { name: /Members/ }));
    await waitFor(() =>
      expect(listGroupMembers).toHaveBeenCalledWith(
        {
          sessionId: session.id,
          groupId: group.id,
          limit: 25,
          offset: 0,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      await screen.findByRole("dialog", { name: "Release room" }),
    ).toHaveAttribute("aria-modal", "true");
    expect(await screen.findByText("Hiep Mai")).toBeInTheDocument();
    expect(screen.getByText("1 synced of 2")).toBeInTheDocument();
    expect(
      screen.getByText(
        /1 synchronized member records are available for 2 participants/,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    expect(
      screen.getByRole("heading", { name: "Send readiness" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The active session is a group administrator."),
    ).toBeInTheDocument();
    expect(screen.getByText("session_is_admin")).toBeInTheDocument();
    expect(screen.getByText("All members")).toBeInTheDocument();
    expect(screen.getByText("Unlocked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy group ID" }));
    expect(
      screen.getByRole("button", { name: "Copied group ID" }),
    ).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(group.id);

    await user.click(
      screen.getByRole("button", { name: "Refresh capability" }),
    );
    await waitFor(() =>
      expect(requestGroupCapabilityRefresh).toHaveBeenCalledWith(
        session.id,
        group.id,
        expect.stringMatching(/^[0-9a-f-]{36}$/u),
      ),
    );
    expect(screen.getByText("Refresh requested")).toBeInTheDocument();
    expect(
      screen.getByText("WA Runtime has queued this capability check."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Capability updated")).not.toBeInTheDocument();
    await waitFor(() => expect(getGroup).toHaveBeenCalledTimes(2));
    expect(listGroupMembers).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Capability updated")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(listGroups).toHaveBeenLastCalledWith(
        {
          sessionId: session.id,
          limit: 20,
          offset: 20,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(await screen.findByText("Product room")).toBeInTheDocument();
  });

  it("pages and searches the synchronized member dataset on the server", async () => {
    const user = userEvent.setup();
    let resolveStaleSearch:
      ((value: typeof groupMemberPage) => void) | undefined;
    const staleSearch = new Promise<typeof groupMemberPage>((resolve) => {
      resolveStaleSearch = resolve;
    });
    const nowOutOfRangePage = {
      data: [],
      meta: { total: 1, limit: 25, offset: 25, datasetRevision: 0 },
    };
    const freshSearchPage = {
      data: [
        {
          participantId: "server-result@c.us",
          phoneNumber: "84888888888",
          displayName: "Backend-selected result",
          identityType: "PHONE_JID" as const,
          resolvedPhoneNumber: "84888888888",
          displayNameSource: "OPENWA_CONTACT_NAME" as const,
          projectionRevision: 0,
          isAdmin: false,
          isSuperAdmin: false,
        },
      ],
      meta: { total: 1, limit: 25, offset: 0, datasetRevision: 0 },
    };
    const listGroupMembers = vi.fn(
      (input: { offset?: number; query?: string }) => {
        if (input.query === "needle") return staleSearch;
        if (input.query === "fresh") return Promise.resolve(freshSearchPage);
        if (input.query === "no matches")
          return Promise.resolve({
            data: [],
            meta: { total: 0, limit: 25, offset: 0, datasetRevision: 0 },
          });
        if (input.offset === 25) return Promise.resolve(nowOutOfRangePage);
        return Promise.resolve({
          ...groupMemberPage,
          meta: { total: 30, limit: 25, offset: 0, datasetRevision: 0 },
        });
      },
    );
    const fakeApi = {
      getGroup: vi.fn().mockResolvedValue(groupDetail),
      getCurrentGroupCapabilityRefresh: vi.fn().mockResolvedValue(null),
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

    await user.click(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    );
    await user.click(await screen.findByRole("button", { name: "Groups" }));
    await user.click(
      await screen.findByRole("button", { name: "View Release room" }),
    );
    await user.click(await screen.findByRole("tab", { name: /Members/ }));

    expect(await screen.findByText("1–1 of 30")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next member page" }));
    await waitFor(() =>
      expect(listGroupMembers).toHaveBeenCalledWith(
        {
          sessionId: session.id,
          groupId: group.id,
          limit: 25,
          offset: 25,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() =>
      expect(listGroupMembers).toHaveBeenCalledWith(
        {
          sessionId: session.id,
          groupId: group.id,
          limit: 25,
          offset: 0,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(await screen.findByText("Hiep Mai")).toBeInTheDocument();

    const search = screen.getByRole("searchbox", {
      name: "Search synchronized members",
    });
    await user.clear(search);
    await user.type(search, "needle");
    await waitFor(() =>
      expect(listGroupMembers).toHaveBeenLastCalledWith(
        {
          sessionId: session.id,
          groupId: group.id,
          limit: 25,
          offset: 0,
          query: "needle",
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    await user.clear(search);
    await user.type(search, "fresh");
    expect(
      await screen.findByText("Backend-selected result"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 matches")).toBeInTheDocument();

    await act(async () => {
      resolveStaleSearch?.({
        data: [
          {
            participantId: "stale@c.us",
            phoneNumber: "84777777777",
            displayName: "Stale response",
            identityType: "PHONE_JID",
            resolvedPhoneNumber: "84777777777",
            displayNameSource: "OPENWA_CONTACT_NAME",
            projectionRevision: 0,
            isAdmin: false,
            isSuperAdmin: false,
          },
        ],
        meta: { total: 1, limit: 25, offset: 0, datasetRevision: 0 },
      });
    });
    expect(screen.queryByText("Stale response")).not.toBeInTheDocument();
    expect(screen.getByText("Backend-selected result")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "   ");
    await waitFor(() =>
      expect(listGroupMembers).toHaveBeenLastCalledWith(
        {
          sessionId: session.id,
          groupId: group.id,
          limit: 25,
          offset: 0,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    await user.clear(search);
    await user.type(search, "no matches");
    await waitFor(() =>
      expect(listGroupMembers).toHaveBeenLastCalledWith(
        {
          sessionId: session.id,
          groupId: group.id,
          limit: 25,
          offset: 0,
          query: "no matches",
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      await screen.findByText("No synchronized members match this search."),
    ).toBeInTheDocument();
  });

  it("does not show a late member response from a previously selected group", async () => {
    const user = userEvent.setup();
    const secondGroup = { ...group, id: "second@g.us", name: "Product room" };
    let resolveFirstGroup:
      ((value: typeof groupMemberPage) => void) | undefined;
    const firstGroupMembers = new Promise<typeof groupMemberPage>((resolve) => {
      resolveFirstGroup = resolve;
    });
    const secondGroupMembers = {
      data: [
        {
          participantId: "product@c.us",
          phoneNumber: "84666666666",
          displayName: "Product member",
          identityType: "PHONE_JID" as const,
          resolvedPhoneNumber: "84666666666",
          displayNameSource: "OPENWA_CONTACT_NAME" as const,
          projectionRevision: 0,
          isAdmin: false,
          isSuperAdmin: false,
        },
      ],
      meta: { total: 1, limit: 25, offset: 0, datasetRevision: 0 },
    };
    const fakeApi = {
      getGroup: vi.fn((_sessionId: string, groupId: string) =>
        Promise.resolve(
          groupId === secondGroup.id
            ? { ...groupDetail, ...secondGroup }
            : groupDetail,
        ),
      ),
      getCurrentGroupCapabilityRefresh: vi.fn().mockResolvedValue(null),
      getSessionSyncRun: vi.fn(),
      listGroupMembers: vi.fn(({ groupId }: { groupId: string }) =>
        groupId === secondGroup.id
          ? Promise.resolve(secondGroupMembers)
          : firstGroupMembers,
      ),
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

    await user.click(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    );
    await user.click(await screen.findByRole("button", { name: "Groups" }));
    await user.click(
      await screen.findByRole("button", { name: "View Release room" }),
    );
    await user.click(await screen.findByRole("tab", { name: /Members/ }));
    await waitFor(() =>
      expect(fakeApi.listGroupMembers).toHaveBeenCalledTimes(1),
    );
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await user.click(screen.getByRole("button", { name: "View Product room" }));
    await user.click(await screen.findByRole("tab", { name: /Members/ }));
    expect(await screen.findByText("Product member")).toBeInTheDocument();

    await act(async () => {
      resolveFirstGroup?.(groupMemberPage);
    });
    expect(screen.queryByText("Hiep Mai")).not.toBeInTheDocument();
    expect(screen.getByText("Product member")).toBeInTheDocument();
  });

  it("keeps the selected group name visible when detail loading fails", async () => {
    const user = userEvent.setup();
    const longName =
      "Nhóm điều phối ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 không được mất tên";
    const longNameGroup = { ...group, name: longName };
    const getGroup = vi
      .fn()
      .mockRejectedValue(new Error("Runtime detail unavailable."));
    const fakeApi = {
      getGroup,
      getCurrentGroupCapabilityRefresh: vi.fn().mockResolvedValue(null),
      getSessionSyncRun: vi.fn(),
      listGroupMembers: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, limit: 25, offset: 0, datasetRevision: 0 },
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

    await user.click(
      screen.getByRole("button", { name: "Connect test WA Runtime" }),
    );
    await user.click(await screen.findByRole("button", { name: "Groups" }));
    await user.click(
      await screen.findByRole("button", { name: `View ${longName}` }),
    );

    expect(
      await screen.findByRole("dialog", { name: longName }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Runtime detail unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: longName })).toHaveAttribute(
      "title",
      longName,
    );
  });

  it("guards workspace navigation while a group list draft is dirty", async () => {
    const user = userEvent.setup();
    const fakeApi = {
      getSessionSyncRun: vi.fn(),
      listGroupLists: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, limit: 50, offset: 0 },
      }),
      listGroups: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, limit: 20, offset: 0 },
      }),
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
    await user.click(screen.getByRole("button", { name: "Connect test WA Runtime" }));
    await user.click(await screen.findByRole("combobox", { name: "Group scope" }));
    await user.click(screen.getByRole("button", { name: "New list" }));
    const editor = screen.getByRole("dialog", { name: "New list" });
    await user.type(within(editor).getByRole("textbox", { name: "Name" }), "Guarded draft");

    act(() => screen.getByRole("button", { name: "Campaigns", hidden: true }).click());
    const guard = screen.getByRole("dialog", { name: "Leave group list draft?" });
    await user.click(within(guard).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("button", { name: "Groups", hidden: true })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("dialog", { name: "New list" })).toBeInTheDocument();

    act(() => screen.getByRole("button", { name: "Campaigns", hidden: true }).click());
    await user.click(screen.getByRole("button", { name: "Discard and continue" }));
    expect(await screen.findByRole("button", { name: "Campaigns" })).toHaveAttribute("aria-current", "page");
  });

  it("guards active-session changes while a group list draft is dirty", async () => {
    const user = userEvent.setup();
    const fakeApi = {
      getSessionSyncRun: vi.fn(),
      listGroupLists: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, limit: 50, offset: 0 },
      }),
      listGroups: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, limit: 20, offset: 0 },
      }),
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
    await user.click(screen.getByRole("button", { name: "Connect test WA Runtime" }));
    await user.click(await screen.findByRole("combobox", { name: "Group scope" }));
    await user.click(screen.getByRole("button", { name: "New list" }));
    const editor = screen.getByRole("dialog", { name: "New list" });
    await user.type(within(editor).getByRole("textbox", { name: "Name" }), "Session guard");

    act(() => screen.getByRole("button", { name: "Active session", hidden: true }).click());
    const listbox = screen.getByRole("listbox", { name: "Gateway sessions", hidden: true });
    act(() => within(listbox).getByRole("option", { name: /standby-session/, hidden: true }).click());
    expect(screen.getByRole("dialog", { name: "Leave group list draft?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active session", hidden: true })).toHaveTextContent("dev-session");

    await user.click(screen.getByRole("button", { name: "Discard and continue" }));
    expect(screen.getByRole("button", { name: "Active session" })).toHaveTextContent("standby-session");
  });
});
