import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import type {
  RuntimeApi,
  RuntimeCampaignRun,
  RuntimeCampaignRunSummary,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import { RuntimeTransportError } from "@/shared/api/runtime-http";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { ToastProvider } from "@/shared/ui/Toast";
import { RunsScreen } from "./RunsScreen";

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

const progress = {
  total: 2,
  pending: 0,
  materialized: 0,
  processing: 1,
  dryRunCompleted: 0,
  accepted: 0,
  sent: 1,
  delivered: 0,
  read: 0,
  failed: 0,
  unknown: 0,
  blocked: 0,
  cancelled: 0,
};

const summary: RuntimeCampaignRunSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  campaignId: "22222222-2222-4222-8222-222222222222",
  campaignNameSnapshot: "Product release",
  sessionId: session.id,
  executionMode: "LIVE",
  status: "RUNNING",
  statusReason: null,
  totalTargets: 2,
  progress,
  scheduledAt: "2026-08-25T10:00:00.000Z",
  startedAt: "2026-08-25T10:00:01.000Z",
  completedAt: null,
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:02.000Z",
};

const run: RuntimeCampaignRun = {
  ...summary,
  text: "Release message snapshot",
  content: { type: "TEXT", text: "Release message snapshot" },
  targetSource: null,
  preflight: null,
  campaignRevision: 3,
  targetsRevision: 4,
};

const secondSummary: RuntimeCampaignRunSummary = {
  ...summary,
  id: "66666666-6666-4666-8666-666666666666",
  campaignId: "77777777-7777-4777-8777-777777777777",
  campaignNameSnapshot: "Retention campaign",
};

const secondRun: RuntimeCampaignRun = {
  ...run,
  ...secondSummary,
  text: "Retention message snapshot",
  content: { type: "TEXT", text: "Retention message snapshot" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function Harness({ onOpenCampaigns }: { onOpenCampaigns?: () => void }) {
  const { connect, connected, selectedSessionId } = useRuntimeConnection();
  if (!connected) {
    return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "0123456789abcdef0123456789abcdef" })}>Connect</button>;
  }
  if (!selectedSessionId) return <span>Selecting session…</span>;
  return <RunsScreen onOpenCampaigns={onOpenCampaigns} />;
}

function renderRunsWithView(
  overrides: Partial<RuntimeApi> = {},
  { onOpenCampaigns }: { onOpenCampaigns?: () => void } = {},
) {
  const api = {
    listRuns: vi.fn().mockResolvedValue({
      data: [summary],
      meta: { total: 1, limit: 50, offset: 0 },
    }),
    getCampaignRun: vi.fn().mockResolvedValue(run),
    listCampaignDeliveries: vi.fn().mockResolvedValue({
      data: [{
        id: "55555555-5555-4555-8555-555555555555",
        runId: run.id,
        groupId: "group@g.us",
        groupName: "Release group",
        status: "SENT",
        failureReason: null,
        messageJobId: "33333333-3333-4333-8333-333333333333",
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }],
      meta: { total: 1, limit: 20, offset: 0 },
    }),
    pauseCampaignRun: vi.fn().mockResolvedValue({ ...run, status: "PAUSED" }),
    resumeCampaignRun: vi.fn(),
    cancelCampaignRun: vi.fn(),
    ...overrides,
  } as unknown as RuntimeApi;

  const view = render(
    <ToastProvider>
      <RuntimeConnectionProvider
        createApi={() => api}
        probeConnection={vi.fn().mockResolvedValue({
          readySessions: 1,
          sessionCount: 1,
          sessions: [session],
        })}
      >
        <DrawerProvider><Harness onOpenCampaigns={onOpenCampaigns} /><DrawerHost /></DrawerProvider>
      </RuntimeConnectionProvider>
    </ToastProvider>,
  );
  return { api, view };
}

function renderRuns(overrides: Partial<RuntimeApi> = {}) {
  return renderRunsWithView(overrides).api;
}

afterEach(() => vi.restoreAllMocks());

describe("RunsScreen", () => {
  it("opens a durable run, reads deliveries on demand, and applies lifecycle controls", async () => {
    const user = userEvent.setup();
    const api = renderRuns();
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Product release")).toBeInTheDocument();
    await waitFor(() => expect(api.listRuns).toHaveBeenCalledWith({
      sessionId: session.id,
      limit: 50,
      offset: 0,
      query: "",
      statuses: [],
      executionModes: [],
    }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(api.listRuns).toHaveBeenCalledTimes(1);

    const runsTable = screen.getByRole("table", { name: "Campaign runs for the active session" });
    const columns = runsTable.querySelectorAll("col");
    expect(columns).toHaveLength(6);
    expect(columns[3]).toHaveClass("runs-column-mode");
    expect(columns[3]).not.toHaveClass("priority-low");
    expect(runsTable.querySelector(".date-time-relative")).toBeInTheDocument();
    expect(within(runsTable).getByRole("progressbar", { name: "1 of 2 targets resolved" })).toBeInTheDocument();
    expect(within(runsTable).getByRole("button", { name: "Inspect run 11111111" })).toBeInTheDocument();
    expect(screen.getByText("1 run")).toBeInTheDocument();
    expect(screen.getByText("All results shown")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Product release" }));
    const inspector = await screen.findByRole("dialog", { name: "Product release" });
    expect(within(inspector).getByText("Release message snapshot")).toBeInTheDocument();
    expect(within(inspector).getByText("r3")).toBeInTheDocument();

    await user.click(within(inspector).getByRole("tab", { name: /Deliveries/ }));
    expect(await within(inspector).findByText("Release group")).toBeInTheDocument();
    const deliveries = within(inspector).getByRole("list", { name: "Per-group deliveries for this run" });
    expect(within(deliveries).getAllByRole("listitem")).toHaveLength(1);
    expect(within(deliveries).getByText("Sent")).toHaveClass("ui-badge-success");
    expect(within(inspector).getByText("1 delivery")).toBeInTheDocument();
    expect(within(inspector).getByRole("combobox", { name: "Delivery status" }).closest(".ui-field")).toHaveClass("ui-field-sm");
    expect(api.listCampaignDeliveries).toHaveBeenCalledWith({
      runId: run.id,
      limit: 20,
      offset: 0,
      query: "",
      statuses: [],
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    await user.click(within(inspector).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.pauseCampaignRun).toHaveBeenCalledWith(
      run.id,
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ));
    expect(await within(inspector).findByText(/Paused · Runtime authoritative/)).toBeInTheDocument();
  });

  it("shows the immutable image metadata and caption in the run snapshot", async () => {
    const user = userEvent.setup();
    const imageRun: RuntimeCampaignRun = {
      ...run,
      text: "Release image",
      content: {
        type: "IMAGE",
        mediaAssetId: "44444444-4444-4444-8444-444444444444",
        caption: "Release image",
        filename: "launch.png",
        mimeType: "image/png",
        byteSize: 8,
        sha256: "a".repeat(64),
      },
    };
    renderRuns({ getCampaignRun: vi.fn().mockResolvedValue(imageRun) });
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Product release" }));
    const inspector = await screen.findByRole("dialog", { name: "Product release" });

    await user.click(within(inspector).getByText("Message snapshot"));
    expect(within(inspector).getByText("launch.png")).toBeInTheDocument();
    expect(within(inspector).getByText("image/png · 8 B")).toBeInTheDocument();
    expect(within(inspector).getByText("Release image")).toBeInTheDocument();
  });

  it("reports a cancellation failure inside the active confirmation", async () => {
    const user = userEvent.setup();
    renderRuns({
      cancelCampaignRun: vi.fn().mockRejectedValue(new Error("Runtime unavailable.")),
    });
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Product release" }));
    const inspector = await screen.findByRole("dialog", { name: "Product release" });
    await user.click(within(inspector).getByRole("button", { name: "Cancel" }));
    const confirmation = screen.getByRole("dialog", { name: "Cancel this campaign run?" });

    await user.click(within(confirmation).getByRole("button", { name: "Cancel run" }));

    const alert = await within(confirmation).findByRole("alert");
    expect(alert).toHaveTextContent("Could not cancel run");
    expect(alert).toHaveTextContent("Runtime unavailable.");
    expect(screen.getAllByText("Runtime unavailable.")).toHaveLength(1);
  });

  it("dispatches only one lifecycle mutation before the busy state renders", async () => {
    const user = userEvent.setup();
    const pending = deferred<RuntimeCampaignRun>();
    const pauseCampaignRun = vi.fn().mockReturnValue(pending.promise);
    renderRuns({ pauseCampaignRun });
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Product release" }));
    const inspector = await screen.findByRole("dialog", { name: "Product release" });
    const pause = await within(inspector).findByRole("button", { name: "Pause" });

    act(() => {
      pause.click();
      pause.click();
    });

    expect(pauseCampaignRun).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ ...run, status: "PAUSED" }));
    expect(await within(inspector).findByText(/Paused · Runtime authoritative/)).toBeInTheDocument();
  });

  it("aborts an older detail poll before applying a lifecycle result", async () => {
    let detailPoll: TimerHandler | null = null;
    vi.spyOn(window, "setInterval").mockImplementation((handler, timeout) => {
      if (timeout === 3_000) detailPoll = handler;
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    const user = userEvent.setup();
    const staleDetail = deferred<RuntimeCampaignRun>();
    const getCampaignRun = vi.fn()
      .mockResolvedValueOnce(run)
      .mockReturnValueOnce(staleDetail.promise);
    const paused = { ...run, status: "PAUSED" as const };
    renderRuns({
      getCampaignRun,
      pauseCampaignRun: vi.fn().mockResolvedValue(paused),
    });
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Product release" }));
    const inspector = await screen.findByRole("dialog", { name: "Product release" });
    await within(inspector).findByText("Release message snapshot");
    await waitFor(() => expect(detailPoll).not.toBeNull());

    act(() => {
      if (typeof detailPoll === "function") detailPoll();
    });
    await waitFor(() => expect(getCampaignRun).toHaveBeenCalledTimes(2));
    const staleSignal = getCampaignRun.mock.calls[1][1]?.signal;
    await user.click(within(inspector).getByRole("button", { name: "Pause" }));
    expect(staleSignal?.aborted).toBe(true);

    await act(async () => staleDetail.resolve(run));
    expect(await within(inspector).findByText(/Paused · Runtime authoritative/)).toBeInTheDocument();
  });

  it("preserves an unknown-outcome warning while canonical run state reloads", async () => {
    const user = userEvent.setup();
    const canonical = { ...run, status: "PAUSED" as const };
    const getCampaignRun = vi.fn()
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(canonical);
    renderRuns({
      getCampaignRun,
      pauseCampaignRun: vi.fn().mockRejectedValue(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      )),
    });
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Product release" }));
    const inspector = await screen.findByRole("dialog", { name: "Product release" });
    await user.click(await within(inspector).findByRole("button", { name: "Pause" }));

    expect(await within(inspector).findByText(/did not confirm the result/)).toBeInTheDocument();
    expect(await within(inspector).findByText(/Paused · Runtime authoritative/)).toBeInTheDocument();
    expect(getCampaignRun).toHaveBeenCalledTimes(2);
  });

  it("reuses the same action key when an unconfirmed pause is retried", async () => {
    const user = userEvent.setup();
    const paused = { ...run, status: "PAUSED" as const };
    const pauseCampaignRun = vi.fn()
      .mockRejectedValueOnce(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      ))
      .mockResolvedValueOnce(paused);
    renderRuns({
      getCampaignRun: vi.fn().mockResolvedValue(run),
      pauseCampaignRun,
    });
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Product release" }));
    const inspector = await screen.findByRole("dialog", { name: "Product release" });

    await user.click(await within(inspector).findByRole("button", { name: "Pause" }));
    expect(await within(inspector).findByText(/same request key/)).toBeInTheDocument();
    await user.click(within(inspector).getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(pauseCampaignRun).toHaveBeenCalledTimes(2));
    expect(pauseCampaignRun.mock.calls[0]?.[1]).toBe(pauseCampaignRun.mock.calls[1]?.[1]);
    expect(await within(inspector).findByText(/Paused · Runtime authoritative/)).toBeInTheDocument();
  });

  it("returns an out-of-range result to the aligned last page", async () => {
    const user = userEvent.setup();
    let contracted = false;
    const listRuns = vi.fn().mockImplementation(({ offset }: { offset: number }) => {
      if (offset === 100) {
        contracted = true;
        return Promise.resolve({
          data: [],
          meta: { total: 91, limit: 50, offset },
        });
      }
      return Promise.resolve({
        data: [summary],
        meta: { total: contracted ? 91 : 101, limit: 50, offset },
      });
    });
    renderRuns({ listRuns } as unknown as Partial<RuntimeApi>);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("1–1 of 101")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(listRuns).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 50 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(listRuns).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 50,
      offset: 50,
      query: "",
      statuses: [],
      executionModes: [],
    }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(await screen.findByText("51–51 of 91")).toBeInTheDocument();
  });

  it("keeps the empty table footer and offers the product next step", async () => {
    const user = userEvent.setup();
    const onOpenCampaigns = vi.fn();
    renderRunsWithView({
      listRuns: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, limit: 50, offset: 0 },
      }),
    }, { onOpenCampaigns });
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("0 runs")).toBeInTheDocument();
    expect(screen.getByText("No results")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Campaigns" }));

    expect(onOpenCampaigns).toHaveBeenCalledOnce();
  });

  it("does not apply a completed mutation to a newly selected run", async () => {
    const user = userEvent.setup();
    const paused = deferred<RuntimeCampaignRun>();
    const api = renderRuns({
      listRuns: vi.fn().mockResolvedValue({
        data: [summary, secondSummary],
        meta: { total: 2, limit: 50, offset: 0 },
      }),
      getCampaignRun: vi.fn().mockImplementation((runId: string) =>
        Promise.resolve(runId === secondRun.id ? secondRun : run)),
      pauseCampaignRun: vi.fn().mockReturnValue(paused.promise),
    } as unknown as Partial<RuntimeApi>);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await user.click(await screen.findByRole("button", { name: "Product release" }));
    const firstInspector = await screen.findByRole("dialog", { name: "Product release" });
    expect(await within(firstInspector).findByText("Release message snapshot")).toBeInTheDocument();
    await user.click(within(firstInspector).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.pauseCampaignRun).toHaveBeenCalledWith(
      run.id,
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ));

    await user.click(screen.getByRole("button", { name: "Retention campaign" }));
    const secondInspector = await screen.findByRole("dialog", { name: "Retention campaign" });
    expect(await within(secondInspector).findByText("Retention message snapshot")).toBeInTheDocument();

    await act(async () => {
      paused.resolve({ ...run, status: "PAUSED" });
      await paused.promise;
    });

    await waitFor(() => {
      const currentInspector = screen.getByRole("dialog", { name: "Retention campaign" });
      expect(within(currentInspector).getByText("Retention message snapshot")).toBeInTheDocument();
      expect(within(currentInspector).queryByText("Release message snapshot")).not.toBeInTheDocument();
    });
  });

  it("invalidates a pending run mutation when the screen unmounts", async () => {
    const user = userEvent.setup();
    const paused = deferred<RuntimeCampaignRun>();
    const listRuns = vi.fn().mockResolvedValue({
      data: [summary],
      meta: { total: 1, limit: 50, offset: 0 },
    });
    const { api, view } = renderRunsWithView({
      listRuns,
      pauseCampaignRun: vi.fn().mockReturnValue(paused.promise),
    } as unknown as Partial<RuntimeApi>);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Product release" }));
    const inspector = await screen.findByRole("dialog", { name: "Product release" });
    await within(inspector).findByText("Release message snapshot");
    await user.click(within(inspector).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.pauseCampaignRun).toHaveBeenCalledOnce());
    const listCallsBeforeUnmount = listRuns.mock.calls.length;

    view.unmount();
    await act(async () => {
      paused.resolve({ ...run, status: "PAUSED" });
      await paused.promise;
    });

    expect(listRuns).toHaveBeenCalledTimes(listCallsBeforeUnmount);
  });

  it("aborts a delivery read when leaving the deliveries tab", async () => {
    const user = userEvent.setup();
    const deliveries = deferred<Awaited<ReturnType<RuntimeApi["listCampaignDeliveries"]>>>();
    const listCampaignDeliveries = vi.fn<RuntimeApi["listCampaignDeliveries"]>()
      .mockReturnValue(deliveries.promise);
    const api = renderRuns({ listCampaignDeliveries } as unknown as Partial<RuntimeApi>);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Product release" }));
    const inspector = await screen.findByRole("dialog", { name: "Product release" });
    await within(inspector).findByText("Release message snapshot");
    await user.click(within(inspector).getByRole("tab", { name: /Deliveries/u }));
    await waitFor(() => expect(api.listCampaignDeliveries).toHaveBeenCalledOnce());
    const signal = listCampaignDeliveries.mock.calls[0][1]?.signal;

    await user.click(within(inspector).getByRole("tab", { name: "Overview" }));

    expect(signal?.aborted).toBe(true);
    await act(async () => {
      deliveries.resolve({
        data: [],
        meta: { total: 0, limit: 20, offset: 0 },
      });
      await deliveries.promise;
    });
    expect(within(inspector).queryByRole("list", {
      name: "Per-group deliveries for this run",
    })).not.toBeInTheDocument();
  });
});
