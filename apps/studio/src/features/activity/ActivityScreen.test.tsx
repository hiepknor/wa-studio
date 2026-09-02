import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import {
  RuntimeConnectionContext,
  type RuntimeConnectionContextValue,
} from "@/app/RuntimeConnectionState";
import type {
  RuntimeActivityEvent,
  RuntimeApi,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import { RuntimeInvalidationProvider } from "@/shared/server-state/runtime-invalidation";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { ToastProvider } from "@/shared/ui/Toast";
import { ActivityScreen } from "./ActivityScreen";

afterEach(() => vi.restoreAllMocks());

const session: RuntimeSession = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "North America ops",
  status: "ready",
  phone: null,
  pushName: null,
  connectedAt: null,
  lastActiveAt: null,
  engineLoaded: true,
  lastError: null,
  restriction: null,
  gatewayCreatedAt: "2026-08-25T09:00:00.000Z",
  gatewayUpdatedAt: "2026-08-25T10:00:00.000Z",
  syncedAt: "2026-08-25T10:00:00.000Z",
};

const runId = "11111111-1111-4111-8111-111111111111";
const event: RuntimeActivityEvent = {
  id: "22222222-2222-4222-8222-222222222222",
  sessionId: session.id,
  eventType: "campaign_run.completed",
  eventVersion: 1,
  category: "RUN",
  severity: "SUCCESS",
  origin: "RUNTIME",
  subject: {
    type: "CAMPAIGN_RUN",
    id: runId,
    labelSnapshot: "Product release",
  },
  related: {
    campaignId: "33333333-3333-4333-8333-333333333333",
    runId,
    syncRunId: null,
    groupId: null,
  },
  correlationId: "request-42",
  metadata: { executionMode: "LIVE", status: "COMPLETED" },
  occurredAt: "2026-08-25T10:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function activityContext(
  api: RuntimeApi,
  selectedSessionId: string | null,
): RuntimeConnectionContextValue {
  return {
    connect: vi.fn(),
    connected: {
      api,
      profile: {
        apiKey: "memory-only-test-key",
        baseUrl: "https://runtime.example",
      },
      sessions: [session],
    },
    configureManagedRuntime: vi.fn(),
    disconnect: vi.fn(),
    managedConnectionError: null,
    managedConnectionFlow: "manual",
    managedRuntime: {
      phase: "unavailable",
      availability: "offline",
      capabilities: {
        canRead: false,
        canEditDrafts: false,
        canSync: false,
        canLaunchCampaign: false,
        canSend: false,
      },
      maintenance: null,
      manifest: null,
      connection: null,
      error: null,
    },
    operationalHealth: null,
    refreshOperationalHealth: vi.fn().mockResolvedValue(false),
    refreshSessions: vi.fn().mockResolvedValue(true),
    selectedSessionId,
    selectSession: vi.fn(),
  };
}

function Harness({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { connect, connected } = useRuntimeConnection();
  if (!connected) {
    return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "0123456789abcdef0123456789abcdef" })}>Connect</button>;
  }
  return <ActivityScreen onOpenRun={onOpenRun} />;
}

function renderActivity(onOpenRun: (id: string) => void) {
  const olderEvent: RuntimeActivityEvent = {
    ...event,
    id: "44444444-4444-4444-8444-444444444444",
    eventType: "campaign_run.created",
    severity: "INFO",
    occurredAt: "2026-08-24T10:00:00.000Z",
  };
  const listActivity = vi.fn<RuntimeApi["listActivity"]>()
    .mockResolvedValueOnce({
      data: [event],
      meta: { limit: 50, nextCursor: "older-cursor", retentionDays: 90 },
    })
    .mockResolvedValueOnce({
      data: [olderEvent],
      meta: { limit: 50, nextCursor: null, retentionDays: 90 },
    });
  const api = { listActivity } as unknown as RuntimeApi;
  render(
    <ToastProvider>
      <RuntimeConnectionProvider
        createApi={() => api}
        probeConnection={vi.fn().mockResolvedValue({
          readySessions: 1,
          sessionCount: 1,
          sessions: [session],
        })}
      >
        <DrawerProvider><Harness onOpenRun={onOpenRun} /><DrawerHost /></DrawerProvider>
      </RuntimeConnectionProvider>
    </ToastProvider>,
  );
  return listActivity;
}

describe("ActivityScreen", () => {
  it("inspects sanitized events, follows run relationships, and loads older cursor pages", async () => {
    const user = userEvent.setup();
    const onOpenRun = vi.fn();
    const listActivity = renderActivity(onOpenRun);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Campaign run completed")).toBeInTheDocument();
    expect(screen.getByText("Activity is retained for 90 days.")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Retained operational activity for the active session" });
    expect(table).toHaveClass("activity-table");
    const columns = table.querySelectorAll("colgroup col");
    expect(columns).toHaveLength(5);
    expect(columns[0]).toHaveClass("activity-column-event");
    expect(columns[1]).toHaveClass("activity-column-subject");
    expect(columns[2]).toHaveClass("activity-column-severity");
    expect(columns[3]).toHaveClass("activity-column-occurred");
    expect(columns[4]).toHaveClass("activity-column-action");
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Event",
      "Subject",
      "Severity",
      "Occurred",
      "Inspect",
    ]);
    expect(within(table).getByRole("columnheader", { name: "Occurred" })).toHaveClass("data-column-time");
    expect(within(table).getByText("Product release")).toHaveClass("activity-subject-name");
    expect(within(table).getByRole("button", { name: "Inspect Campaign run completed" })).toBeInTheDocument();
    expect(listActivity).toHaveBeenCalledWith({
      sessionId: session.id,
      limit: 50,
      query: "",
      categories: [],
      severities: [],
      cursor: undefined,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    await user.click(screen.getByRole("button", { name: "Campaign run completed" }));
    const inspector = await screen.findByRole("dialog", { name: "Campaign run completed" });
    expect(within(inspector).getByText("request-42")).toBeInTheDocument();
    expect(within(inspector).queryByText(/payload/i)).not.toBeInTheDocument();
    await user.click(within(inspector).getByRole("button", { name: "Open run" }));
    expect(onOpenRun).toHaveBeenCalledWith(runId);

    await user.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(listActivity).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 50,
      query: "",
      categories: [],
      severities: [],
      cursor: "older-cursor",
    }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(await screen.findByText("Campaign run created")).toBeInTheDocument();
    expect(screen.getByText("Info")).toHaveClass("ui-badge-info");
  });

  it("ignores a response from the session that was cleared while loading", async () => {
    const pending = deferred<Awaited<ReturnType<RuntimeApi["listActivity"]>>>();
    const listActivity = vi.fn<RuntimeApi["listActivity"]>().mockReturnValue(pending.promise);
    const api = { listActivity } as unknown as RuntimeApi;
    const content = (selectedSessionId: string | null) => (
      <RuntimeConnectionContext.Provider value={activityContext(api, selectedSessionId)}>
        <RuntimeInvalidationProvider>
          <DrawerProvider><ActivityScreen /><DrawerHost /></DrawerProvider>
        </RuntimeInvalidationProvider>
      </RuntimeConnectionContext.Provider>
    );
    const view = render(content(session.id));
    await waitFor(() => expect(listActivity).toHaveBeenCalledOnce());
    const signal = listActivity.mock.calls[0][1]?.signal;

    view.rerender(content(null));

    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText("Select a session to view activity.")).toBeInTheDocument();
    await act(async () => {
      pending.resolve({
        data: [event],
        meta: { limit: 50, nextCursor: null, retentionDays: 90 },
      });
      await pending.promise;
    });

    expect(screen.queryByText("Campaign run completed")).not.toBeInTheDocument();
    expect(screen.getByText("Retention is Runtime controlled.")).toBeInTheDocument();
  });

  it("resolves a deep-linked event outside the current page and follows a cleared location", async () => {
    const getActivityEvent = vi.fn<RuntimeApi["getActivityEvent"]>().mockResolvedValue(event);
    const api = {
      getActivityEvent,
      listActivity: vi.fn<RuntimeApi["listActivity"]>().mockResolvedValue({
        data: [],
        meta: { limit: 50, nextCursor: null, retentionDays: 90 },
      }),
    } as unknown as RuntimeApi;
    const content = (initialEventId: string | null) => (
      <RuntimeConnectionContext.Provider value={activityContext(api, session.id)}>
        <RuntimeInvalidationProvider>
          <DrawerProvider>
            <ActivityScreen initialEventId={initialEventId} />
            <DrawerHost />
          </DrawerProvider>
        </RuntimeInvalidationProvider>
      </RuntimeConnectionContext.Provider>
    );
    const view = render(content(event.id));

    const inspector = await screen.findByRole("dialog", { name: "Campaign run completed" });
    expect(getActivityEvent).toHaveBeenCalledWith(
      session.id,
      event.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(within(inspector).getByText("WA Runtime")).toBeInTheDocument();
    expect(within(inspector).getByText("v1")).toBeInTheDocument();

    view.rerender(content(null));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Campaign run completed" }))
        .not.toBeInTheDocument();
    });
  });

  it("applies a UTC start when the operator selects a retained time range", async () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const listActivity = vi.fn<RuntimeApi["listActivity"]>().mockResolvedValue({
      data: [event],
      meta: { limit: 50, nextCursor: null, retentionDays: 90 },
    });
    const api = { listActivity } as unknown as RuntimeApi;
    const user = userEvent.setup();
    render(
      <RuntimeConnectionContext.Provider value={activityContext(api, session.id)}>
        <RuntimeInvalidationProvider>
          <DrawerProvider><ActivityScreen /><DrawerHost /></DrawerProvider>
        </RuntimeInvalidationProvider>
      </RuntimeConnectionContext.Provider>,
    );
    await waitFor(() => expect(listActivity).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("radio", { name: "Last 7 days" }));
    await waitFor(() => expect(listActivity).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 50,
      query: "",
      categories: [],
      severities: [],
      from: "2026-08-26T12:00:00.000Z",
      cursor: undefined,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(screen.getByText("1 applied")).toBeInTheDocument();
    nowSpy.mockRestore();
  });
});
