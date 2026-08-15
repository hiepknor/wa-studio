import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import {
  RuntimeRequestError,
  type RuntimeApi,
  type RuntimeCampaign,
  type RuntimeCampaignPreflight,
  type RuntimeCampaignTarget,
  type RuntimeGroup,
  type RuntimeSession,
} from "@/shared/api/runtime-client";
import { ToastProvider } from "@/shared/ui/Toast";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { CampaignsScreen } from "./CampaignsScreen";

const session: RuntimeSession = {
  id: "session-id", name: "Primary", status: "ready", phone: null, pushName: null,
  connectedAt: null, lastActiveAt: null, engineLoaded: true, lastError: null,
  restriction: null, gatewayCreatedAt: "2026-08-14T00:00:00.000Z",
  gatewayUpdatedAt: "2026-08-14T00:00:00.000Z", syncedAt: "2026-08-14T00:00:00.000Z",
};

const campaign: RuntimeCampaign = {
  id: "campaign-id", sessionId: session.id, name: "Release", text: "Ship it",
  scheduleType: "IMMEDIATE", scheduledAt: null, status: "DRAFT", targetCount: 1,
  revision: 3, targetsRevision: 4, createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

const deniedTarget: RuntimeCampaignTarget = {
  groupId: "denied@g.us", groupName: "Denied room", enabled: false,
  sendCapability: { status: "DENIED", reason: "not_admin", checkedAt: null, invalidatedAt: null, revision: 2 },
};

const unknownGroup: RuntimeGroup = {
  sessionId: session.id, id: "unknown@g.us", name: "Unknown room", description: null,
  ownerId: null, linkedParentId: null, participantsCount: 3, isAdmin: false,
  isReadOnly: false, isAnnounce: false, settingsLocked: false, isActive: false,
  detailsSyncedAt: null, syncedAt: "2026-08-14T00:00:00.000Z",
  sendCapability: { status: "UNKNOWN", reason: "not_checked", checkedAt: null, invalidatedAt: null, revision: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function Harness() {
  const { connect, connected } = useRuntimeConnection();
  if (!connected) return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "key" })}>Connect</button>;
  return <CampaignsScreen />;
}

function renderCampaigns(overrides: Partial<RuntimeApi> = {}, initial: RuntimeCampaign[] = [campaign]) {
  const api = {
    listCampaigns: vi.fn().mockResolvedValue({ data: initial, meta: { total: initial.length, limit: 50, offset: 0 } }),
    listCampaignTargets: vi.fn().mockResolvedValue({ data: [deniedTarget] }),
    listGroups: vi.fn().mockResolvedValue({ data: [unknownGroup], meta: { total: 1, limit: 50, offset: 0 } }),
    getCampaign: vi.fn().mockResolvedValue(campaign),
    createCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    replaceCampaignTargets: vi.fn(),
    preflightCampaign: vi.fn(),
    ...overrides,
  } as unknown as RuntimeApi;
  render(
    <ToastProvider>
      <RuntimeConnectionProvider
        createApi={() => api}
        probeConnection={vi.fn().mockResolvedValue({ readySessions: 1, sessionCount: 1, sessions: [session] })}
      >
        <DrawerProvider><Harness /><DrawerHost /></DrawerProvider>
      </RuntimeConnectionProvider>
    </ToastProvider>,
  );
  return api;
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("heading", { name: "Campaigns" });
}

async function openCampaign(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText("Release");
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await screen.findByRole("heading", { name: "Content & schedule" });
}

function report(
  executionMode: "DRY_RUN" | "LIVE",
  status: "PASS" | "WARN" | "BLOCK",
): RuntimeCampaignPreflight {
  return {
    status, policyVersion: 6, campaignRevision: 3, targetsRevision: 4,
    executionMode, checkedAt: "2026-08-14T03:00:00.000Z", totalTargets: 9,
    allowedTargets: 5, deniedTargets: 3, unknownTargets: 1,
    checks: [{ code: "GROUP_CAPABILITY", status, message: "Runtime policy result" }],
    targetIssues: [{ groupId: "denied@g.us", groupName: "Denied room", capability: "DENIED", reason: "TARGET_CAPABILITY_DENIED" }],
  };
}

async function runPreflight(
  user: ReturnType<typeof userEvent.setup>,
  mode: "DRY_RUN" | "LIVE" = "DRY_RUN",
) {
  if (mode === "LIVE") {
    await user.click(screen.getByRole("combobox", { name: "Preflight mode" }));
    await user.click(screen.getByRole("option", { name: /Live policy/ }));
  }
  await user.click(screen.getByRole("button", { name: "Run preflight" }));
}

describe("CampaignsScreen", () => {
  it("uses the shared drawer, tabs, fields, badges, and actions in a structured workspace", async () => {
    const user = userEvent.setup();
    renderCampaigns();
    await connect(user);
    expect(await screen.findByText(campaign.id)).toBeInTheDocument();
    await openCampaign(user);

    expect(screen.queryByLabelText("Campaign metadata")).not.toBeInTheDocument();
    expect(screen.getByText("Details are up to date")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Campaign name" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message text" })).toBeInTheDocument();
    const schedule = screen.getByRole("combobox", { name: "Schedule" });
    await user.click(schedule);
    await user.click(screen.getByRole("option", { name: /Once/ }));
    expect(screen.getByLabelText("Scheduled date and time")).toBeInTheDocument();
    await user.click(schedule);
    await user.click(screen.getByRole("option", { name: /Immediate/ }));
    expect(screen.queryByLabelText("Scheduled date and time")).not.toBeInTheDocument();
    await user.click(schedule);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Schedule" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Release" })).toBeInTheDocument();

    const drawerBody = document.querySelector<HTMLElement>(".drawer-body");
    expect(drawerBody).not.toBeNull();
    drawerBody!.scrollTop = 120;
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    expect(drawerBody).toHaveProperty("scrollTop", 0);
    expect(screen.getAllByText("Saved target set").length).toBeGreaterThan(0);
    expect(screen.getByText("1 of 1,000 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Preflight" }));
    expect(screen.getByText("No preflight report")).toBeInTheDocument();
    expect(screen.getByText("No preflight result yet")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Preflight mode" })).toHaveTextContent("Dry run");
    expect(screen.getByRole("button", { name: "Run preflight" })).toBeInTheDocument();
  });

  it("renders the campaign list and empty state for the active session", async () => {
    const user = userEvent.setup();
    renderCampaigns({}, []);
    await connect(user);
    expect(await screen.findByText("No campaigns yet. Create a draft to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New campaign" })).toBeEnabled();
  });

  it("uses the shared confirmation dialog before discarding drawer edits", async () => {
    const user = userEvent.setup();
    renderCampaigns({}, []);
    await connect(user);
    await user.click(screen.getByRole("button", { name: "New campaign" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close drawer" })).toHaveFocus());
    expect(screen.getByRole("tab", { name: "Targets" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Preflight" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Campaign name" }), "Unsaved");
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(screen.getByRole("dialog", { name: "Discard campaign changes?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Campaign name" })).toHaveValue("Unsaved");
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "New campaign draft" })).not.toBeInTheDocument());
  });

  it("retries one create intent with the same UUID and does not duplicate an HTTP 200 replay", async () => {
    const user = userEvent.setup();
    const created = { ...campaign, id: "created-id", name: "New release", revision: 1, targetsRevision: 0, targetCount: 0 };
    const createCampaign = vi.fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(created);
    const listCampaigns = vi.fn()
      .mockResolvedValueOnce({ data: [], meta: { total: 0, limit: 50, offset: 0 } })
      .mockResolvedValue({ data: [created], meta: { total: 1, limit: 50, offset: 0 } });
    renderCampaigns({ createCampaign, listCampaigns }, []);
    await connect(user);
    await user.click(screen.getByRole("button", { name: "New campaign" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close drawer" })).toHaveFocus());
    await user.type(screen.getByRole("textbox", { name: "Campaign name" }), "New release");
    await user.type(screen.getByRole("textbox", { name: "Message text" }), "Ship it");

    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("response lost")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByText("Campaign draft created.");

    expect(createCampaign).toHaveBeenCalledTimes(2);
    expect(createCampaign.mock.calls[0][1]).toBe(createCampaign.mock.calls[1][1]);
    expect(createCampaign.mock.calls[0][0]).toEqual({
      sessionId: session.id, name: "New release", text: "Ship it", scheduleType: "IMMEDIATE",
    });
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(await screen.findAllByText("New release")).toHaveLength(1);
  });

  it("does not alter scheduling on content PATCH and maps typed scheduling/edit conflicts", async () => {
    const user = userEvent.setup();
    const updateCampaign = vi.fn()
      .mockResolvedValueOnce({ ...campaign, text: "Updated", revision: 4 })
      .mockRejectedValueOnce(new RuntimeRequestError("opaque", { code: "CAMPAIGN_NOT_EDITABLE", status: 409 }));
    renderCampaigns({ updateCampaign });
    await connect(user);
    await openCampaign(user);
    const text = screen.getByRole("textbox", { name: "Message text" });
    await user.clear(text);
    await user.type(text, "Updated");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(updateCampaign).toHaveBeenCalledWith(campaign.id, { text: "Updated" }));

    await user.clear(text);
    await user.type(text, "Again");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Only DRAFT campaigns can be edited.")).toBeInTheDocument();
  });

  it("keeps canonical targets on failed replacement and renders inactive DENIED/UNKNOWN groups", async () => {
    const user = userEvent.setup();
    const replaceCampaignTargets = vi.fn()
      .mockRejectedValueOnce(new RuntimeRequestError("opaque", { code: "CAMPAIGN_TARGET_SESSION_MISMATCH", status: 422 }))
      .mockResolvedValueOnce({ data: [{
        groupId: unknownGroup.id, groupName: "Canonical unknown", enabled: false,
        sendCapability: unknownGroup.sendCapability,
      }] })
      .mockResolvedValueOnce({ data: [] });
    const getCampaign = vi.fn()
      .mockResolvedValueOnce({ ...campaign, targetCount: 1, targetsRevision: 5 })
      .mockResolvedValueOnce({ ...campaign, targetCount: 0, targetsRevision: 6 });
    renderCampaigns({ getCampaign, replaceCampaignTargets });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await screen.findByText("Denied room");
    expect(screen.getByText("Denied room")).toBeInTheDocument();
    expect(screen.getAllByText("Inactive").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Unknown, current")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Unknown room/ }));
    await user.click(screen.getByRole("button", { name: "Save target set" }));
    expect(await screen.findByText("Every target must belong to the campaign session.")).toBeInTheDocument();
    const savedTargets = screen.getByText("Saved targets").closest("details");
    expect(savedTargets).not.toBeNull();
    expect(savedTargets).toHaveAttribute("open");
    expect(within(savedTargets!).getByText("Denied room")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save target set" }));
    expect(await screen.findByText("Canonical unknown")).toBeInTheDocument();
    expect(replaceCampaignTargets).toHaveBeenLastCalledWith(campaign.id, ["denied@g.us", "unknown@g.us"]);

    await user.click(screen.getByRole("checkbox", { name: /Unknown room/ }));
    await user.click(screen.getByRole("button", { name: "Save target set" }));
    expect(await screen.findByText("No saved targets. Saving an empty selection clears the complete target set.")).toBeInTheDocument();
    expect(replaceCampaignTargets).toHaveBeenLastCalledWith(campaign.id, []);
  });

  it("shows staged target additions and removals without mutating the saved audit set", async () => {
    const user = userEvent.setup();
    renderCampaigns();
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await screen.findByRole("checkbox", { name: /Unknown room/ });

    await user.click(screen.getByText("Saved targets"));
    await user.click(screen.getByRole("button", { name: "Remove Denied room from selection" }));
    await user.click(screen.getByRole("checkbox", { name: /Unknown room/ }));

    expect(screen.getAllByText("1 added · 1 removed · Not saved").length).toBeGreaterThan(0);
    expect(screen.getByText("Pending removal")).toBeInTheDocument();
    expect(screen.getByText("Denied room")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore Denied room to selection" })).toBeEnabled();
  });

  it("debounces and trims target search, and omits a whitespace-only query", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue({
      data: [unknownGroup], meta: { total: 1, limit: 50, offset: 0 },
    });
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));

    const search = screen.getByRole("searchbox", { name: "Find synchronized groups" });
    await user.type(search, "  room  ");
    expect(listGroups).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
    expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 50, offset: 0, query: "room",
    });

    await user.clear(search);
    await user.type(search, "   ");
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(3));
    expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 50, offset: 0,
    });
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });

  it("ignores a late target-search response from an older query", async () => {
    const user = userEvent.setup();
    const oldResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const newResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const listGroups = vi.fn()
      .mockResolvedValueOnce({ data: [unknownGroup], meta: { total: 1, limit: 50, offset: 0 } })
      .mockReturnValueOnce(oldResult.promise)
      .mockReturnValueOnce(newResult.promise);
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));

    const search = screen.getByRole("searchbox", { name: "Find synchronized groups" });
    await user.type(search, "old");
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
    await user.clear(search);
    await user.type(search, "new");

    const oldGroup = { ...unknownGroup, id: "old@g.us", name: "Old result" };
    await act(async () => oldResult.resolve({ data: [oldGroup], meta: { total: 1, limit: 50, offset: 0 } }));
    expect(screen.queryByText("Old result")).not.toBeInTheDocument();

    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(3));
    const newGroup = { ...unknownGroup, id: "new@g.us", name: "New result" };
    await act(async () => newResult.resolve({ data: [newGroup], meta: { total: 1, limit: 50, offset: 0 } }));
    expect(await screen.findByText("New result")).toBeInTheDocument();
  });

  it("invalidates an in-flight group response when the drawer closes", async () => {
    const user = userEvent.setup();
    const oldResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const currentGroup = { ...unknownGroup, id: "current@g.us", name: "Current result" };
    const listGroups = vi.fn()
      .mockReturnValueOnce(oldResult.promise)
      .mockResolvedValueOnce({ data: [currentGroup], meta: { total: 1, limit: 50, offset: 0 } });
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    expect(await screen.findByText("Current result")).toBeInTheDocument();

    const oldGroup = { ...unknownGroup, id: "old-close@g.us", name: "Old closed result" };
    await act(async () => oldResult.resolve({ data: [oldGroup], meta: { total: 1, limit: 50, offset: 0 } }));
    expect(screen.queryByText("Old closed result")).not.toBeInTheDocument();
    expect(screen.getByText("Current result")).toBeInTheDocument();
  });

  it.each([
    ["DRY_RUN", "PASS"],
    ["DRY_RUN", "WARN"],
    ["DRY_RUN", "BLOCK"],
    ["LIVE", "PASS"],
    ["LIVE", "WARN"],
    ["LIVE", "BLOCK"],
  ] as const)("renders Runtime %s %s status, counters, stable codes, and reasons", async (mode, status) => {
    const user = userEvent.setup();
    const preflightCampaign = vi.fn().mockResolvedValue(report(mode, status));
    renderCampaigns({ preflightCampaign });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Preflight" }));
    await runPreflight(user, mode);
    expect(await screen.findByText("GROUP_CAPABILITY")).toBeInTheDocument();
    expect(screen.getByText("TARGET_CAPABILITY_DENIED")).toBeInTheDocument();
    expect(screen.getByText("Policy v6")).toBeInTheDocument();
    const metrics = screen.getByText("Total").closest("dl");
    expect(metrics).not.toBeNull();
    expect(within(metrics!).getByText("9")).toBeInTheDocument();
    expect(within(metrics!).getByText("5")).toBeInTheDocument();
    expect(within(metrics!).getByText("3")).toBeInTheDocument();
    expect(within(metrics!).getByText("1")).toBeInTheDocument();
    expect(preflightCampaign).toHaveBeenCalledWith(campaign.id, mode);
  });

  it("marks a report stale after local content or target edits and prevents preflight over unsaved state", async () => {
    const user = userEvent.setup();
    renderCampaigns({ preflightCampaign: vi.fn().mockResolvedValue(report("DRY_RUN", "PASS")) });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Preflight" }));
    await runPreflight(user);
    await screen.findByText("GROUP_CAPABILITY");

    await user.click(screen.getByRole("tab", { name: "Details" }));
    await user.type(screen.getByRole("textbox", { name: "Message text" }), " changed");
    await user.click(screen.getByRole("tab", { name: /Preflight/ }));
    expect(screen.getByText("Preflight result is stale")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run preflight" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: /Details/ }));
    await user.clear(screen.getByRole("textbox", { name: "Message text" }));
    await user.type(screen.getByRole("textbox", { name: "Message text" }), campaign.text);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await screen.findByText("Denied room");
    await user.click(screen.getByRole("checkbox", { name: /Unknown room/ }));
    await user.click(screen.getByRole("tab", { name: /Preflight/ }));
    expect(screen.getByText("Preflight result is stale")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run preflight" })).toBeDisabled();
  });

  it("ignores a late preflight response after the editor closes", async () => {
    const user = userEvent.setup();
    let resolveReport!: (value: RuntimeCampaignPreflight) => void;
    const pending = new Promise<RuntimeCampaignPreflight>((resolve) => { resolveReport = resolve; });
    renderCampaigns({ preflightCampaign: vi.fn().mockReturnValue(pending) });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Preflight" }));
    await runPreflight(user);
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    resolveReport(report("DRY_RUN", "PASS"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Campaigns" })).toBeInTheDocument());
    expect(screen.queryByText("GROUP_CAPABILITY")).not.toBeInTheDocument();
  });
});
