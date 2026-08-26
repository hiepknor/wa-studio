import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
  targetSource: null,
  preflight: null,
  campaignRevision: 3,
  targetsRevision: 4,
};

function Harness() {
  const { connect, connected } = useRuntimeConnection();
  if (!connected) {
    return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "key" })}>Connect</button>;
  }
  return <RunsScreen />;
}

function renderRuns(overrides: Partial<RuntimeApi> = {}) {
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
        <DrawerProvider><Harness /><DrawerHost /></DrawerProvider>
      </RuntimeConnectionProvider>
    </ToastProvider>,
  );
  return api;
}

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
    }));
    expect(api.listRuns).toHaveBeenCalledTimes(1);

    const runsTable = screen.getByRole("table", { name: "Campaign runs for the active session" });
    const columns = runsTable.querySelectorAll("col");
    expect(columns).toHaveLength(6);
    expect(columns[3]).toHaveClass("runs-column-mode");
    expect(columns[3]).not.toHaveClass("priority-low");
    expect(runsTable.querySelector(".date-time-relative")).toBeInTheDocument();
    expect(within(runsTable).getByRole("progressbar", { name: "1 of 2 targets resolved" })).toBeInTheDocument();
    expect(within(runsTable).getByRole("button", { name: "Inspect run 11111111" })).toBeInTheDocument();
    expect(screen.getByText("1 durable run")).toBeInTheDocument();

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
    });

    await user.click(within(inspector).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.pauseCampaignRun).toHaveBeenCalledWith(run.id));
    expect(await within(inspector).findByText(/Paused · Runtime authoritative/)).toBeInTheDocument();
  });
});
