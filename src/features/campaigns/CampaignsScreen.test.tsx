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
  type RuntimeGroupListGroup,
  type RuntimeSavedGroupList,
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
    listGroups: vi.fn().mockResolvedValue({ data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 } }),
    listSavedGroupLists: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 100, offset: 0 } }),
    getGroupListMembership: vi.fn(),
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

async function openSavedListPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add from saved list" }));
  return screen.getByRole("dialog", { name: "Add from saved list" });
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
    expect(screen.getByText("Saved 1 · Staged 1 · +0 / −0")).toBeInTheDocument();

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
    await screen.findByRole("checkbox", { name: "Select Denied room" });
    expect(screen.getByRole("columnheader", { name: "Participants" })).toBeInTheDocument();
    const deniedRow = screen.getByRole("checkbox", { name: "Select Denied room" }).closest("tr");
    expect(deniedRow).not.toBeNull();
    expect(within(deniedRow!).getByTitle("Participant count is unavailable in the saved target snapshot.")).toHaveTextContent("—");
    expect(screen.getAllByText("Inactive").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Unknown, current")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select Unknown room" }));
    await user.click(screen.getByRole("button", { name: "Save target set" }));
    expect(await screen.findByText("Every target must belong to the campaign session.")).toBeInTheDocument();
    expect(screen.getByText("Denied room")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Denied room" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save target set" }));
    expect(await screen.findByText("Canonical unknown")).toBeInTheDocument();
    expect(replaceCampaignTargets).toHaveBeenLastCalledWith(campaign.id, ["denied@g.us", "unknown@g.us"]);

    await user.click(screen.getByRole("checkbox", { name: "Select Canonical unknown" }));
    await user.click(screen.getByRole("button", { name: "Save target set" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).not.toBeChecked());
    expect(replaceCampaignTargets).toHaveBeenLastCalledWith(campaign.id, []);
  });

  it("uses one target table for available and saved groups with participant counts", async () => {
    const user = userEvent.setup();
    renderCampaigns();
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const unknownCheckbox = await screen.findByRole("checkbox", { name: "Select Unknown room" });
    const targetTable = screen.getByRole("table", { name: "Groups available to the campaign target selection" });
    expect(within(targetTable).getByRole("columnheader", { name: "Participants" })).toBeInTheDocument();
    expect(within(targetTable).getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("Saved targets")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /All groups|Selection/ })).not.toBeInTheDocument();
    expect(within(targetTable).getByRole("rowheader", { name: "Saved or selected outside current results 1" })).toBeInTheDocument();
    expect(within(targetTable).getByRole("rowheader", { name: "Current results 1" })).toBeInTheDocument();

    const selectAll = screen.getByRole("checkbox", { name: "Select all groups on this page" });
    expect(selectAll).not.toBeChecked();
    expect(selectAll).toHaveProperty("indeterminate", false);
    await user.click(selectAll);
    expect(unknownCheckbox).toBeChecked();
    const deniedCheckbox = screen.getByRole("checkbox", { name: "Select Denied room" });
    expect(deniedCheckbox).toBeChecked();
    await user.click(selectAll);
    expect(unknownCheckbox).not.toBeChecked();
    expect(deniedCheckbox).toBeChecked();
    await user.click(unknownCheckbox);

    expect(screen.getAllByText("Saved 1 · Staged 2 · +1 / −0").length).toBeGreaterThan(0);
    expect(screen.getByText("Denied room")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Denied room" })).toBeChecked();
    expect(screen.getAllByRole("table", { name: "Groups available to the campaign target selection" })).toHaveLength(1);
  });

  it("paginates synchronized groups on the server and preserves selection across pages", async () => {
    const user = userEvent.setup();
    const secondGroup = { ...unknownGroup, id: "second@g.us", name: "Second page group" };
    const listGroups = vi.fn()
      .mockResolvedValueOnce({ data: [unknownGroup], meta: { total: 21, limit: 20, offset: 0 } })
      .mockResolvedValueOnce({ data: [secondGroup], meta: { total: 21, limit: 20, offset: 20 } });
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));

    const unknownCheckbox = await screen.findByRole("checkbox", { name: "Select Unknown room" });
    await user.click(unknownCheckbox);
    const targetSection = screen.getByRole("heading", { name: "Target groups" }).closest("section");
    expect(targetSection).not.toBeNull();
    expect(within(targetSection!).getByText("Page 1 of 2")).toBeInTheDocument();
    await user.click(within(targetSection!).getByRole("button", { name: "Next" }));

    expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 20, offset: 20,
    });
    expect(await screen.findByText("Second page group")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).toBeChecked();
    const selectPage = screen.getByRole("checkbox", { name: "Select all groups on this page" });
    expect(selectPage).not.toBeChecked();
    await user.click(selectPage);
    expect(screen.getByRole("checkbox", { name: "Select Second page group" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).toBeChecked();
    expect(within(targetSection!).getByText("Page 2 of 2")).toBeInTheDocument();
  });

  it("uses the shared filter interaction for capability, freshness, participants, and inactive groups", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue({
      data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 },
    });
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));

    const targetSection = screen.getByRole("heading", { name: "Target groups" }).closest("section");
    expect(targetSection).not.toBeNull();
    await user.click(within(targetSection!).getByRole("button", { name: "Filters" }));
    const panel = screen.getByRole("region", { name: "Target group filters" });
    await user.click(within(panel).getByRole("checkbox", { name: "Allowed" }));
    await user.click(within(panel).getByRole("checkbox", { name: "Unknown" }));
    await user.click(within(panel).getByRole("checkbox", { name: "Current" }));
    await user.click(within(panel).getByRole("radio", { name: "Inactive" }));
    await user.type(within(panel).getByRole("spinbutton", { name: "Minimum" }), "50");
    await user.type(within(panel).getByRole("spinbutton", { name: "Maximum" }), "500");

    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      capabilityStatus: ["ALLOWED", "UNKNOWN"],
      capabilityFreshness: ["CURRENT"],
      isActive: false,
      minParticipants: 50,
      maxParticipants: 500,
    }));
    expect(within(panel).queryByRole("button", { name: "Apply range" })).not.toBeInTheDocument();
    expect(within(targetSection!).getByRole("button", { name: "Filters · 4" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Remove ≥ 50 participants filter" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Denied room" })).toBeChecked();

    await user.click(within(panel).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 20, offset: 0,
    }));
    expect(within(targetSection!).getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });

  it("maps typed participant filter errors to the range fields", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn()
      .mockResolvedValueOnce({ data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 } })
      .mockRejectedValueOnce(new RuntimeRequestError("Invalid participant range.", {
        code: "GROUP_FILTER_PARTICIPANTS_RANGE_INVALID",
        status: 400,
        fieldErrors: {
          minParticipants: ["Minimum was rejected by Runtime."],
          maxParticipants: ["Maximum was rejected by Runtime."],
        },
      }))
      .mockResolvedValueOnce({ data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 } });
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));

    const targetSection = screen.getByRole("heading", { name: "Target groups" }).closest("section");
    expect(targetSection).not.toBeNull();
    await user.click(within(targetSection!).getByRole("button", { name: "Filters" }));
    const panel = screen.getByRole("region", { name: "Target group filters" });
    await user.type(within(panel).getByRole("spinbutton", { name: "Minimum" }), "50");
    await user.type(within(panel).getByRole("spinbutton", { name: "Maximum" }), "500");

    expect(await within(panel).findByText("Minimum was rejected by Runtime.")).toBeInTheDocument();
    expect(within(panel).getByText("Maximum was rejected by Runtime.")).toBeInTheDocument();
    expect(screen.getByText("Invalid participant range.")).toBeInTheDocument();

    await user.type(within(panel).getByRole("spinbutton", { name: "Maximum" }), "{enter}");
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(within(panel).queryByText("Minimum was rejected by Runtime.")).not.toBeInTheDocument());
  });

  it("does not render a late target-filter response after filters change", async () => {
    const user = userEvent.setup();
    const allowedResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const combinedResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const listGroups = vi.fn()
      .mockResolvedValueOnce({ data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 } })
      .mockReturnValueOnce(allowedResult.promise)
      .mockReturnValueOnce(combinedResult.promise);
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));

    const targetSection = screen.getByRole("heading", { name: "Target groups" }).closest("section");
    expect(targetSection).not.toBeNull();
    await user.click(within(targetSection!).getByRole("button", { name: "Filters" }));
    const panel = screen.getByRole("region", { name: "Target group filters" });
    await user.click(within(panel).getByRole("checkbox", { name: "Allowed" }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
    await user.click(within(panel).getByRole("checkbox", { name: "Unknown" }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(3));

    const staleGroup = { ...unknownGroup, id: "allowed-only@g.us", name: "Allowed-only stale result" };
    await act(async () => allowedResult.resolve({ data: [staleGroup], meta: { total: 1, limit: 20, offset: 0 } }));
    expect(screen.queryByText("Allowed-only stale result")).not.toBeInTheDocument();

    const currentGroup = { ...unknownGroup, id: "combined@g.us", name: "Combined filter result" };
    await act(async () => combinedResult.resolve({ data: [currentGroup], meta: { total: 1, limit: 20, offset: 0 } }));
    expect(await screen.findByText("Combined filter result")).toBeInTheDocument();
    expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      capabilityStatus: ["ALLOWED", "UNKNOWN"],
    });
  });

  it("recovers an out-of-range target page from Runtime metadata", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn()
      .mockResolvedValueOnce({ data: [unknownGroup], meta: { total: 21, limit: 20, offset: 0 } })
      .mockResolvedValueOnce({ data: [], meta: { total: 1, limit: 20, offset: 20 } })
      .mockResolvedValueOnce({ data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 } });
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));

    const targetSection = screen.getByRole("heading", { name: "Target groups" }).closest("section");
    expect(targetSection).not.toBeNull();
    await screen.findByText("Page 1 of 2");
    await user.click(within(targetSection!).getByRole("button", { name: "Next" }));

    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(3));
    expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 20, offset: 0,
    });
    expect(await within(targetSection!).findByText("Page 1 of 1")).toBeInTheDocument();
  });

  it("does not render a late target-page response after a new search intent", async () => {
    const user = userEvent.setup();
    const pageResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const searchResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const listGroups = vi.fn()
      .mockResolvedValueOnce({ data: [unknownGroup], meta: { total: 21, limit: 20, offset: 0 } })
      .mockReturnValueOnce(pageResult.promise)
      .mockReturnValueOnce(searchResult.promise);
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));

    const targetSection = screen.getByRole("heading", { name: "Target groups" }).closest("section");
    expect(targetSection).not.toBeNull();
    await screen.findByText("Page 1 of 2");
    await user.click(within(targetSection!).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
    await user.type(screen.getByRole("searchbox", { name: "Find synchronized groups" }), "fresh");

    const staleGroup = { ...unknownGroup, id: "stale-page@g.us", name: "Stale page result" };
    await act(async () => pageResult.resolve({ data: [staleGroup], meta: { total: 21, limit: 20, offset: 20 } }));
    expect(screen.queryByText("Stale page result")).not.toBeInTheDocument();

    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(3));
    expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 20, offset: 0, query: "fresh",
    });
    const freshGroup = { ...unknownGroup, id: "fresh@g.us", name: "Fresh search result" };
    await act(async () => searchResult.resolve({ data: [freshGroup], meta: { total: 1, limit: 20, offset: 0 } }));
    expect(await screen.findByText("Fresh search result")).toBeInTheDocument();
    expect(screen.queryByText("Stale page result")).not.toBeInTheDocument();
  });

  it("debounces and trims target search, and omits a whitespace-only query", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue({
      data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 },
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
      sessionId: session.id, limit: 20, offset: 0, query: "room",
    });

    await user.clear(search);
    await user.type(search, "   ");
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(3));
    expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 20, offset: 0,
    });
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });

  it("ignores a late target-search response from an older query", async () => {
    const user = userEvent.setup();
    const oldResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const newResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const listGroups = vi.fn()
      .mockResolvedValueOnce({ data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 } })
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
    await act(async () => oldResult.resolve({ data: [oldGroup], meta: { total: 1, limit: 20, offset: 0 } }));
    expect(screen.queryByText("Old result")).not.toBeInTheDocument();

    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(3));
    const newGroup = { ...unknownGroup, id: "new@g.us", name: "New result" };
    await act(async () => newResult.resolve({ data: [newGroup], meta: { total: 1, limit: 20, offset: 0 } }));
    expect(await screen.findByText("New result")).toBeInTheDocument();
  });

  it("invalidates an in-flight group response when the drawer closes", async () => {
    const user = userEvent.setup();
    const oldResult = deferred<Awaited<ReturnType<RuntimeApi["listGroups"]>>>();
    const currentGroup = { ...unknownGroup, id: "current@g.us", name: "Current result" };
    const listGroups = vi.fn()
      .mockReturnValueOnce(oldResult.promise)
      .mockResolvedValueOnce({ data: [currentGroup], meta: { total: 1, limit: 20, offset: 0 } });
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    expect(await screen.findByText("Current result")).toBeInTheDocument();

    const oldGroup = { ...unknownGroup, id: "old-close@g.us", name: "Old closed result" };
    await act(async () => oldResult.resolve({ data: [oldGroup], meta: { total: 1, limit: 20, offset: 0 } }));
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
    await user.click(await screen.findByRole("checkbox", { name: "Select Unknown room" }));
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

  it("adds a saved-list snapshot to staged targets without persisting until Save target set", async () => {
    const user = userEvent.setup();
    const list: RuntimeSavedGroupList = {
      id: "11111111-1111-4111-8111-111111111111", sessionId: session.id,
      name: "Launch list", description: "Reusable launch groups", groupCount: 2,
      revision: 1, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const listRows: RuntimeGroupListGroup[] = [
      { groupId: deniedTarget.groupId, groupName: deniedTarget.groupName, isActive: false, participantsCount: null, sendCapability: deniedTarget.sendCapability },
      { groupId: unknownGroup.id, groupName: unknownGroup.name, isActive: unknownGroup.isActive, participantsCount: unknownGroup.participantsCount, sendCapability: unknownGroup.sendCapability },
    ];
    const replaceCampaignTargets = vi.fn().mockResolvedValue({
      data: [deniedTarget, { groupId: unknownGroup.id, groupName: unknownGroup.name, enabled: true, sendCapability: unknownGroup.sendCapability }],
    });
    const api = renderCampaigns({
      listSavedGroupLists: vi.fn().mockResolvedValue({ data: [list], meta: { total: 1, limit: 100, offset: 0 } }),
      getGroupListMembership: vi.fn().mockResolvedValue({ list, data: listRows }),
      replaceCampaignTargets,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    const selector = within(picker).getByRole("combobox", { name: "Group list" });
    await waitFor(() => expect(selector).toBeEnabled());
    await user.click(selector);
    await user.click(screen.getByRole("option", { name: /Launch list/ }));
    await user.click(screen.getByRole("button", { name: "Add to selection" }));
    expect(await screen.findByText(/1 group added from Launch list/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).toBeChecked();
    expect(replaceCampaignTargets).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /Preflight/ }));
    expect(screen.getByRole("button", { name: "Run preflight" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await user.click(screen.getByRole("button", { name: "Save target set" }));
    await waitFor(() => expect(replaceCampaignTargets).toHaveBeenCalledTimes(1));
    expect(replaceCampaignTargets).toHaveBeenCalledWith(campaign.id, [deniedTarget.groupId, unknownGroup.id]);
    expect(api.preflightCampaign).not.toHaveBeenCalled();
  });

  it("loads saved lists lazily and ignores a late response after the picker closes", async () => {
    const user = userEvent.setup();
    const latePage = deferred<Awaited<ReturnType<RuntimeApi["listSavedGroupLists"]>>>();
    const currentList: RuntimeSavedGroupList = {
      id: "44444444-4444-4444-8444-444444444444", sessionId: session.id,
      name: "Current list", description: null, groupCount: 1, revision: 1,
      archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const listSavedGroupLists = vi.fn()
      .mockReturnValueOnce(latePage.promise)
      .mockResolvedValueOnce({ data: [currentList], meta: { total: 1, limit: 100, offset: 0 } });
    renderCampaigns({ listSavedGroupLists });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    expect(listSavedGroupLists).not.toHaveBeenCalled();
    await openSavedListPicker(user);
    await waitFor(() => expect(listSavedGroupLists).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Close saved lists" }));
    latePage.resolve({ data: [{ ...currentList, id: "late", name: "Late list" }], meta: { total: 1, limit: 100, offset: 0 } });
    await Promise.resolve();
    expect(screen.queryByRole("dialog", { name: "Add from saved list" })).not.toBeInTheDocument();
    const picker = await openSavedListPicker(user);
    const selector = within(picker).getByRole("combobox", { name: "Group list" });
    await waitFor(() => expect(selector).toBeEnabled());
    await user.click(selector);
    expect(screen.getByRole("option", { name: /Current list/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Late list/ })).not.toBeInTheDocument();
  });

  it("requires confirmation and explicitly stages an empty saved-list replacement", async () => {
    const user = userEvent.setup();
    const emptyList: RuntimeSavedGroupList = {
      id: "22222222-2222-4222-8222-222222222222", sessionId: session.id,
      name: "Empty list", description: null, groupCount: 0, revision: 1,
      archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const replaceCampaignTargets = vi.fn();
    renderCampaigns({
      listSavedGroupLists: vi.fn().mockResolvedValue({ data: [emptyList], meta: { total: 1, limit: 100, offset: 0 } }),
      getGroupListMembership: vi.fn().mockResolvedValue({ list: emptyList, data: [] }),
      replaceCampaignTargets,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    const selector = within(picker).getByRole("combobox", { name: "Group list" });
    await waitFor(() => expect(selector).toBeEnabled());
    await user.click(selector);
    await user.click(screen.getByRole("option", { name: /Empty list/ }));
    await user.click(screen.getByRole("button", { name: "Replace selection" }));
    expect(screen.getByText(/This list is empty/)).toBeInTheDocument();
    expect(screen.getByText("Saved 1 · Staged 1 · +0 / −0")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "Replace staged target selection?" });
    await user.click(within(dialog).getByRole("button", { name: "Replace selection" }));
    expect(await screen.findByText(/staged an empty target set/)).toBeInTheDocument();
    expect(screen.getAllByText("Saved 1 · Staged 0 · +0 / −1").length).toBeGreaterThan(0);
    expect(replaceCampaignTargets).not.toHaveBeenCalled();
  });

  it("leaves staged targets unchanged when a saved list resolves to another session", async () => {
    const user = userEvent.setup();
    const list: RuntimeSavedGroupList = {
      id: "33333333-3333-4333-8333-333333333333", sessionId: session.id,
      name: "Moved list", description: null, groupCount: 1, revision: 1,
      archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    renderCampaigns({
      listSavedGroupLists: vi.fn().mockResolvedValue({ data: [list], meta: { total: 1, limit: 100, offset: 0 } }),
      getGroupListMembership: vi.fn().mockResolvedValue({ list: { ...list, sessionId: "other-session" }, data: [] }),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    const selector = within(picker).getByRole("combobox", { name: "Group list" });
    await waitFor(() => expect(selector).toBeEnabled());
    await user.click(selector);
    await user.click(screen.getByRole("option", { name: /Moved list/ }));
    await user.click(screen.getByRole("button", { name: "Add to selection" }));
    expect(await screen.findByText("This group list belongs to a different Runtime session.")).toBeInTheDocument();
    expect(screen.getByText("Saved 1 · Staged 1 · +0 / −0")).toBeInTheDocument();
  });

  it("resets staged target changes to the canonical saved set without persisting", async () => {
    const user = userEvent.setup();
    const replaceCampaignTargets = vi.fn();
    renderCampaigns({ replaceCampaignTargets });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await user.click(await screen.findByRole("checkbox", { name: "Select Unknown room" }));
    expect(screen.getAllByText("Saved 1 · Staged 2 · +1 / −0").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Reset to saved" }));
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).not.toBeChecked();
    expect(screen.getByText("Staged selection reset to the saved target set.")).toBeInTheDocument();
    expect(screen.getByText("Saved 1 · Staged 1 · +0 / −0")).toBeInTheDocument();
    expect(replaceCampaignTargets).not.toHaveBeenCalled();
  });
});
