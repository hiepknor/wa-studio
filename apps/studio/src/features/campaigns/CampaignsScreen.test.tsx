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
  type RuntimeCampaignRun,
  type RuntimeCampaignTarget,
  type RuntimeGroup,
  type RuntimeGroupList,
  type RuntimeSession,
} from "@/shared/api/runtime-client";
import { RuntimeTransportError } from "@/shared/api/runtime-http";
import { ToastProvider } from "@/shared/ui/Toast";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { CampaignsScreen } from "./CampaignsScreen";

const READ_OPTIONS = expect.objectContaining({ signal: expect.any(AbortSignal) });

const session: RuntimeSession = {
  id: "session-id", name: "Primary", status: "ready", phone: null, pushName: null,
  connectedAt: null, lastActiveAt: null, engineLoaded: true, lastError: null,
  restriction: null, gatewayCreatedAt: "2026-08-14T00:00:00.000Z",
  gatewayUpdatedAt: "2026-08-14T00:00:00.000Z", syncedAt: "2026-08-14T00:00:00.000Z",
};

const campaign: RuntimeCampaign = {
  id: "campaign-id", sessionId: session.id, name: "Release", text: "Ship it",
  content: { type: "TEXT", text: "Ship it" },
  scheduleType: "IMMEDIATE", scheduledAt: null, status: "DRAFT", targetCount: 1,
  revision: 3, targetsRevision: 4, createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

const deniedTarget: RuntimeCampaignTarget = {
  groupId: "denied@g.us", groupName: "Denied room", enabled: false,
  participantsCount: 27,
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
  if (!connected) return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "0123456789abcdef0123456789abcdef" })}>Connect</button>;
  return <CampaignsScreen />;
}

function renderCampaigns(overrides: Partial<RuntimeApi> = {}, initial: RuntimeCampaign[] = [campaign]) {
  const api = {
    listCampaigns: vi.fn().mockResolvedValue({ data: initial, meta: { total: initial.length, limit: 50, offset: 0 } }),
    listCampaignTargets: vi.fn().mockResolvedValue({ data: [deniedTarget], targetsRevision: 4, source: null }),
    listGroups: vi.fn().mockResolvedValue({ data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 } }),
    listGroupLists: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 100, offset: 0 } }),
    applyGroupListToCampaignTargets: vi.fn(),
    listCampaignRuns: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } }),
    createCampaignRun: vi.fn(),
    getCampaignRun: vi.fn(),
    pauseCampaignRun: vi.fn(),
    resumeCampaignRun: vi.fn(),
    cancelCampaignRun: vi.fn(),
    getCampaign: vi.fn().mockResolvedValue(campaign),
    getCampaignMediaContent: vi.fn().mockResolvedValue(new Blob([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], { type: "image/png" })),
    createCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    replaceCampaignTargets: vi.fn(),
    preflightCampaign: vi.fn(),
    deleteCampaign: vi.fn(),
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
  await user.click(screen.getByRole("button", { name: "Release" }));
  await screen.findByRole("heading", { name: "Content & schedule" });
}

async function openSavedListPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Apply group list" }));
  return screen.getByRole("dialog", { name: "Apply group list" });
}

function report(
  executionMode: "DRY_RUN" | "LIVE",
  status: "PASS" | "WARN" | "BLOCK",
): RuntimeCampaignPreflight {
  return {
    status, policyVersion: 6, campaignRevision: 3, targetsRevision: 4,
    executionMode, checkedAt: "2026-08-14T03:00:00.000Z", totalTargets: 9,
    liveLaunchToken: executionMode === "LIVE" && status === "PASS"
      ? "clp1.test-payload.test-signature-with-sufficient-length"
      : null,
    liveLaunchTokenExpiresAt: executionMode === "LIVE" && status === "PASS"
      ? "2026-08-14T03:02:00.000Z"
      : null,
    allowedTargets: 5, deniedTargets: 3, unknownTargets: 1,
    checks: [{ code: "GROUP_CAPABILITY", status, message: "Runtime policy result" }],
    targetIssues: [{ groupId: "denied@g.us", groupName: "Denied room", capability: "DENIED", reason: "TARGET_CAPABILITY_DENIED" }],
  };
}

function campaignRun(
  executionMode: "DRY_RUN" | "LIVE",
  status: RuntimeCampaignRun["status"] = "COMPLETED",
): RuntimeCampaignRun {
  return {
    id: `${executionMode.toLocaleLowerCase()}-run-id`,
    campaignId: campaign.id,
    campaignNameSnapshot: campaign.name,
    sessionId: session.id,
    executionMode,
    status,
    statusReason: null,
    text: campaign.text,
    content: campaign.content,
    targetSource: null,
    preflight: report(executionMode, "PASS"),
    campaignRevision: campaign.revision,
    targetsRevision: campaign.targetsRevision,
    totalTargets: 1,
    progress: { total: 1, pending: 0, materialized: 0, processing: 0, dryRunCompleted: executionMode === "DRY_RUN" ? 1 : 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, unknown: 0, blocked: 0, cancelled: 0 },
    scheduledAt: "2026-08-14T03:00:00.000Z",
    startedAt: "2026-08-14T03:00:00.000Z",
    completedAt: status === "COMPLETED" ? "2026-08-14T03:01:00.000Z" : null,
    createdAt: "2026-08-14T03:00:00.000Z",
    updatedAt: "2026-08-14T03:01:00.000Z",
  };
}

async function runPreflight(
  user: ReturnType<typeof userEvent.setup>,
  mode: "DRY_RUN" | "LIVE" = "DRY_RUN",
) {
  if (mode === "LIVE") {
    await user.click(screen.getByRole("radio", { name: "Live policy" }));
  }
  await user.click(screen.getByRole("button", { name: "Run preflight" }));
}

describe("CampaignsScreen", () => {
  it("uses the shared workflow dialog, tabs, fields, badges, and actions in a structured workspace", async () => {
    const user = userEvent.setup();
    renderCampaigns();
    await connect(user);
    expect(await screen.findByText(campaign.id)).toBeInTheDocument();
    await openCampaign(user);

    expect(screen.getByRole("heading", { name: "Content & schedule" })).toBeInTheDocument();
    expect(screen.getByText("Campaign r3 · All changes saved")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Campaign name" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message text" })).toBeInTheDocument();
    const messagePreview = screen.getByRole("region", { name: "Message preview" });
    expect(within(messagePreview).getByText("Ship it")).toBeInTheDocument();
    expect(within(messagePreview).getByText("Text message")).toBeInTheDocument();
    expect(within(messagePreview).getByText("7 / 4,096")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset to saved" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Campaign name" }), " updated");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByText("Campaign r3 · Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset to saved" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Reset to saved" }));
    expect(screen.getByRole("textbox", { name: "Campaign name" })).toHaveValue("Release");
    expect(screen.getByText("Campaign r3 · All changes saved")).toBeInTheDocument();
    const schedule = screen.getByRole("radiogroup", { name: "Schedule" });
    expect(screen.getByRole("heading", { name: "Delivery timing" })).toBeInTheDocument();
    expect(screen.getByText("Choose when Runtime may begin this campaign.")).toBeInTheDocument();
    expect(screen.queryByText("Runtime managed")).not.toBeInTheDocument();
    await user.click(within(schedule).getByRole("radio", { name: "Once" }));
    expect(screen.getByLabelText("Run at")).toBeInTheDocument();
    await user.click(within(schedule).getByRole("radio", { name: "Immediate" }));
    expect(screen.queryByLabelText("Run at")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Release" })).toBeInTheDocument();

    const workspace = screen.getByRole("dialog", { name: campaign.name });
    const contentLayout = workspace.querySelector<HTMLElement>(".campaign-content-layout");
    const contentEditor = workspace.querySelector<HTMLElement>(".campaign-content-editor");
    const deliveryHeading = screen.getByRole("heading", { name: "Delivery timing" });
    expect(contentLayout).toBeInTheDocument();
    expect(contentEditor).toBeInTheDocument();
    expect(contentLayout).toHaveClass("campaign-workspace-section");
    expect(messagePreview).not.toHaveClass("campaign-workspace-section");
    expect(contentLayout).toContainElement(messagePreview);
    expect(contentLayout).toContainElement(deliveryHeading);
    expect(contentEditor).toContainElement(deliveryHeading);
    expect(messagePreview).not.toContainElement(deliveryHeading);
    expect(within(workspace).getByRole("button", { name: `More actions for ${campaign.name}` })).toBeInTheDocument();
    const dialogBody = workspace.querySelector<HTMLElement>(".modal-dialog-body");
    expect(dialogBody).not.toBeNull();
    dialogBody!.scrollTop = 120;
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    expect(dialogBody).toHaveProperty("scrollTop", 0);
    expect(screen.getByText("1 saved target · No unsaved changes")).toBeInTheDocument();
    const targetOverview = screen.getByRole("region", { name: "Custom selection" });
    expect(targetOverview).toHaveClass("campaign-target-overview");
    expect(screen.queryByRole("region", { name: "Apply a group list" })).not.toBeInTheDocument();
    const browseGroups = screen.getByRole("heading", { name: "Browse groups" }).closest("section");
    expect(browseGroups).not.toBeNull();
    expect(within(browseGroups!).getByRole("region", { name: "Browse groups directory" }))
      .toHaveAttribute("data-variant", "outlined");
    expect(within(browseGroups!).queryByRole("button", { name: "Apply group list" })).not.toBeInTheDocument();
    expect(within(targetOverview).getByRole("button", { name: "Apply group list" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    expect(workspace.querySelector(".campaign-review-flow")).toBeInTheDocument();
    const reviewPlan = screen.getByRole("region", { name: "Campaign r3 · targets r4" });
    expect(within(reviewPlan).getByText("Safety gate")).toBeInTheDocument();
    expect(screen.getByText("No Runtime decision yet")).toBeInTheDocument();
    expect(screen.getByText("No preflight result yet")).toBeInTheDocument();
    const executionMode = screen.getByRole("radiogroup", { name: "Execution mode" });
    expect(executionMode).toHaveClass("segmented-control-control");
    expect(executionMode.parentElement?.previousElementSibling).toHaveClass("campaign-review-eyebrow");
    expect(executionMode.parentElement?.previousElementSibling).toHaveTextContent("Execution mode");
    expect(within(executionMode).getByRole("radio", { name: "Dry run" })).toBeChecked();
    expect(within(executionMode).queryByText("Evaluate the campaign as a simulation.")).not.toBeInTheDocument();
    expect(within(executionMode).queryByText("Apply live policy without creating a run or sending messages.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run preflight" })).toBeInTheDocument();
  });

  it("renders the campaign list and empty state for the active session", async () => {
    const user = userEvent.setup();
    renderCampaigns({}, []);
    await connect(user);
    expect(await screen.findByText("No campaigns yet. Create a draft to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New campaign" })).toBeEnabled();
  });

  it("reloads canonical details without discarding staged input after an unconfirmed update", async () => {
    const user = userEvent.setup();
    const updateCampaign = vi.fn().mockRejectedValue(new RuntimeTransportError(
      "response lost",
      { requestDispatched: true },
    ));
    const getCampaign = vi.fn().mockResolvedValue(campaign);
    renderCampaigns({ getCampaign, updateCampaign });
    await connect(user);
    await openCampaign(user);
    const name = screen.getByRole("textbox", { name: "Campaign name" });
    await user.type(name, " updated");
    await user.click(screen.getByRole("button", { name: "Save details" }));

    expect(await screen.findByText(/did not confirm the result/)).toBeInTheDocument();
    expect(getCampaign).toHaveBeenCalledWith(campaign.id);
    expect(screen.getByRole("textbox", { name: "Campaign name" })).toHaveValue("Release updated");
    expect(screen.getByText("Campaign r3 · Unsaved changes")).toBeInTheDocument();
  });

  it("uses the shared confirmation dialog before discarding workspace edits", async () => {
    const user = userEvent.setup();
    renderCampaigns({}, []);
    await connect(user);
    await user.click(screen.getByRole("button", { name: "New campaign" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus());
    expect(screen.getByRole("tab", { name: "Targets" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Review & launch" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Campaign name" }), "Unsaved");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("dialog", { name: "Discard campaign changes?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Campaign name" })).toHaveValue("Unsaved");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "New campaign draft" })).not.toBeInTheDocument());
  });

  it("retries one create intent with the same UUID and does not duplicate an HTTP 200 replay", async () => {
    const user = userEvent.setup();
    const created = { ...campaign, id: "created-id", name: "New release", revision: 1, targetsRevision: 0, targetCount: 0 };
    const createCampaign = vi.fn()
      .mockRejectedValueOnce(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      ))
      .mockResolvedValueOnce(created);
    const listCampaigns = vi.fn()
      .mockResolvedValueOnce({ data: [], meta: { total: 0, limit: 50, offset: 0 } })
      .mockResolvedValue({ data: [created], meta: { total: 1, limit: 50, offset: 0 } });
    renderCampaigns({ createCampaign, listCampaigns }, []);
    await connect(user);
    await user.click(screen.getByRole("button", { name: "New campaign" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus());
    await user.type(screen.getByRole("textbox", { name: "Campaign name" }), "New release");
    await user.type(screen.getByRole("textbox", { name: "Message text" }), "Ship it");

    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText(/same request key/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByText("Campaign draft created");

    expect(createCampaign).toHaveBeenCalledTimes(2);
    expect(createCampaign.mock.calls[0][1]).toBe(createCampaign.mock.calls[1][1]);
    expect(createCampaign.mock.calls[0][0]).toEqual({
      sessionId: session.id, name: "New release",
      content: { type: "TEXT", text: "Ship it" }, scheduleType: "IMMEDIATE",
    });
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(await screen.findAllByText("New release")).toHaveLength(1);
  });

  it("uploads one image asset before creating a media campaign snapshot", async () => {
    const user = userEvent.setup();
    const uploadId = "11111111-1111-4111-8111-111111111111";
    const assetId = "22222222-2222-4222-8222-222222222222";
    const mediaContent = {
      type: "IMAGE" as const,
      mediaAssetId: assetId,
      caption: "Release notes",
      filename: "release.png",
      mimeType: "image/png",
      byteSize: 8,
      sha256: "b".repeat(64),
    };
    const createCampaign = vi.fn().mockResolvedValue({
      ...campaign,
      id: "media-campaign-id",
      name: "Media release",
      text: mediaContent.caption,
      content: mediaContent,
      revision: 1,
    });
    const api = renderCampaigns({
      getCampaignMediaPolicy: vi.fn().mockResolvedValue({
        chunkSize: 393_216,
        imageMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        imageMaxBytes: 8 * 1024 * 1024,
        storageMaxBytes: 512 * 1024 * 1024,
      }),
      createCampaignMediaUpload: vi.fn().mockResolvedValue({
        id: uploadId,
        sessionId: session.id,
        kind: "IMAGE",
        filename: mediaContent.filename,
        mimeType: mediaContent.mimeType,
        byteSize: mediaContent.byteSize,
        sha256: mediaContent.sha256,
        chunkSize: 393_216,
        totalChunks: 1,
        uploadedChunks: [],
        status: "UPLOADING",
        completedAssetId: null,
        expiresAt: "2026-08-29T00:00:00.000Z",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      }),
      putCampaignMediaChunk: vi.fn().mockResolvedValue(undefined),
      completeCampaignMediaUpload: vi.fn().mockResolvedValue({
        id: assetId,
        sessionId: session.id,
        kind: "IMAGE",
        filename: mediaContent.filename,
        mimeType: mediaContent.mimeType,
        byteSize: mediaContent.byteSize,
        sha256: mediaContent.sha256,
        createdAt: "2026-08-28T00:00:01.000Z",
      }),
      cancelCampaignMediaUpload: vi.fn().mockResolvedValue(undefined),
      createCampaign,
    }, []);
    await connect(user);
    await user.click(screen.getByRole("button", { name: "New campaign" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus());
    await user.type(screen.getByRole("textbox", { name: "Campaign name" }), "Media release");
    const messageType = screen.getByRole("radiogroup", { name: "Message type" });
    expect(within(messageType).getByRole("radio", { name: "Text" })).toBeChecked();
    await user.click(within(messageType).getByRole("radio", { name: "Image" }));
    expect(within(messageType).getByRole("radio", { name: "Image" })).toBeChecked();
    expect(screen.getByText("JPEG, PNG, or WebP with an optional caption.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose file" })).toBeEnabled());
    const file = new File([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], mediaContent.filename, { type: mediaContent.mimeType });
    await user.upload(screen.getByLabelText("Choose an image"), file);
    expect(await screen.findByText(mediaContent.filename)).toBeVisible();
    await waitFor(() => expect(api.getCampaignMediaContent).toHaveBeenCalledWith(assetId, READ_OPTIONS));
    await user.type(screen.getByRole("textbox", { name: "Caption · Optional" }), mediaContent.caption);
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByText("Campaign draft created");

    expect(api.putCampaignMediaChunk).toHaveBeenCalledOnce();
    expect(createCampaign).toHaveBeenCalledWith({
      sessionId: session.id,
      name: "Media release",
      content: {
        type: "IMAGE",
        mediaAssetId: assetId,
        caption: mediaContent.caption,
      },
      scheduleType: "IMMEDIATE",
    }, expect.any(String));
  });

  it("restores a persisted image preview when the campaign workspace is reopened", async () => {
    const user = userEvent.setup();
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const assetId = "22222222-2222-4222-8222-222222222222";
    const imageCampaign: RuntimeCampaign = {
      ...campaign,
      text: "Release image",
      content: {
        type: "IMAGE",
        mediaAssetId: assetId,
        caption: "Release image",
        filename: "release.png",
        mimeType: "image/png",
        byteSize: image.byteLength,
        sha256: "b".repeat(64),
      },
    };
    const getCampaignMediaContent = vi.fn().mockResolvedValue(new Blob([image], {
      type: "image/png",
    }));
    renderCampaigns({
      getCampaignMediaContent,
      getCampaignMediaPolicy: vi.fn().mockResolvedValue({
        chunkSize: 393_216,
        imageMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        imageMaxBytes: 8 * 1024 * 1024,
        storageMaxBytes: 512 * 1024 * 1024,
      }),
    }, [imageCampaign]);
    await connect(user);
    await openCampaign(user);

    const preview = await screen.findByRole("img", { name: "Preview of release.png" });
    expect(preview).toHaveAttribute("src", expect.stringMatching(/^blob:/u));
    const messagePreview = screen.getByRole("region", { name: "Message preview" });
    expect(within(messagePreview).getByRole("img", { name: "Message preview: release.png" }))
      .toHaveAttribute("src", preview.getAttribute("src"));
    expect(within(messagePreview).getByText("Release image")).toBeInTheDocument();
    expect(getCampaignMediaContent).toHaveBeenCalledWith(assetId, READ_OPTIONS);
  });

  it("admits only one create mutation before React can render its busy state", async () => {
    const user = userEvent.setup();
    const pending = deferred<RuntimeCampaign>();
    const createCampaign = vi.fn().mockReturnValue(pending.promise);
    renderCampaigns({ createCampaign }, []);
    await connect(user);
    await user.click(screen.getByRole("button", { name: "New campaign" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus());
    await user.type(screen.getByRole("textbox", { name: "Campaign name" }), "Single flight");
    await user.type(screen.getByRole("textbox", { name: "Message text" }), "Ship once");

    const submit = screen.getByRole("button", { name: "Create draft" });
    act(() => {
      submit.click();
      submit.click();
    });

    expect(createCampaign).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({
      ...campaign,
      id: "single-flight-id",
      name: "Single flight",
      revision: 1,
      targetCount: 0,
      targetsRevision: 0,
    }));
    expect(await screen.findByText("Campaign draft created")).toBeInTheDocument();
  });

  it("clears mutation ownership when a pending editor is discarded", async () => {
    const user = userEvent.setup();
    const pending = deferred<RuntimeCampaign>();
    const updateCampaign = vi.fn().mockReturnValue(pending.promise);
    renderCampaigns({ updateCampaign });
    await connect(user);
    await openCampaign(user);
    await user.type(screen.getByRole("textbox", { name: "Campaign name" }), " pending");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const release = screen.getByRole("button", { name: "Release" });
    await waitFor(() => expect(release.closest("[inert]")).toBeNull());
    await user.click(release);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus(),
    );
    const name = await screen.findByRole("textbox", { name: "Campaign name" });
    await user.type(name, " next");
    expect(screen.getByRole("button", { name: "Save details" })).toBeEnabled();

    await act(async () => pending.resolve({ ...campaign, name: "Release pending", revision: 4 }));
    expect(name).toHaveValue("Release next");
    expect(screen.queryByText("Campaign details saved")).not.toBeInTheDocument();
  });

  it("blocks payload drift until an unconfirmed Campaign create is restored", async () => {
    const user = userEvent.setup();
    const created = { ...campaign, id: "created-id", name: "New release", revision: 1, targetsRevision: 0, targetCount: 0 };
    const createCampaign = vi.fn()
      .mockRejectedValueOnce(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      ))
      .mockResolvedValueOnce(created);
    renderCampaigns({ createCampaign }, []);
    await connect(user);
    await user.click(screen.getByRole("button", { name: "New campaign" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus(),
    );
    const name = screen.getByRole("textbox", { name: "Campaign name" });
    await user.type(name, "New release");
    await user.type(screen.getByRole("textbox", { name: "Message text" }), "Ship it");
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByRole("button", { name: "Restore unconfirmed request" })).toBeInTheDocument();
    expect(createCampaign.mock.calls[0][0]).toMatchObject({
      name: "New release",
      content: { type: "TEXT", text: "Ship it" },
    });

    await user.clear(name);
    await user.type(name, "Changed release");
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText(/could create a duplicate campaign/)).toBeInTheDocument();
    expect(createCampaign).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Restore unconfirmed request" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Campaign name" }))
        .toHaveValue("New release"),
    );
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Campaign draft created")).toBeInTheDocument();
    expect(createCampaign).toHaveBeenCalledTimes(2);
    expect(createCampaign.mock.calls[0][1]).toBe(createCampaign.mock.calls[1][1]);
  });

  it("does not alter scheduling on content PATCH and maps typed scheduling/edit conflicts", async () => {
    const user = userEvent.setup();
    const updateCampaign = vi.fn()
      .mockResolvedValueOnce({
        ...campaign, text: "Updated", content: { type: "TEXT", text: "Updated" }, revision: 4,
      })
      .mockRejectedValueOnce(new RuntimeRequestError("opaque", { code: "CAMPAIGN_NOT_EDITABLE", status: 409 }));
    renderCampaigns({ updateCampaign });
    await connect(user);
    await openCampaign(user);
    const text = screen.getByRole("textbox", { name: "Message text" });
    await user.clear(text);
    await user.type(text, "Updated");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(updateCampaign).toHaveBeenCalledWith(campaign.id, {
      content: { type: "TEXT", text: "Updated" },
    }));

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
        participantsCount: unknownGroup.participantsCount,
        sendCapability: unknownGroup.sendCapability,
      }], targetsRevision: 5, source: null })
      .mockResolvedValueOnce({ data: [], targetsRevision: 6, source: null });
    renderCampaigns({ replaceCampaignTargets });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    expect(await screen.findByText("1 outside current view")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show selected" }));
    await screen.findByRole("checkbox", { name: "Select Denied room" });
    expect(screen.getByRole("columnheader", { name: "Participants" })).toBeInTheDocument();
    const deniedRow = screen.getByRole("checkbox", { name: "Select Denied room" }).closest("tr");
    expect(deniedRow).not.toBeNull();
    expect(within(deniedRow!).getByText("27")).toBeInTheDocument();
    expect(within(deniedRow!).queryByTitle("Participant count is unavailable in the saved target snapshot.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Inactive").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Show results" }));
    expect(screen.getByLabelText("Unknown, current")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select Unknown room" }));
    await user.click(screen.getByRole("button", { name: "Save target set" }));
    expect(await screen.findByText("Every target must belong to the campaign session.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show selected" }));
    expect(screen.getByText("Denied room")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Denied room" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save target set" }));
    expect(await screen.findByText("Canonical unknown")).toBeInTheDocument();
    expect(replaceCampaignTargets).toHaveBeenLastCalledWith(campaign.id, ["denied@g.us", "unknown@g.us"], 4);

    await user.click(screen.getByRole("checkbox", { name: "Select Canonical unknown" }));
    await user.click(screen.getByRole("button", { name: "Save target set" }));
    await waitFor(() => expect(screen.getByText("No groups selected.")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Show results" }));
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).not.toBeChecked();
    expect(replaceCampaignTargets).toHaveBeenLastCalledWith(campaign.id, [], 5);
  });

  it("uses one target table for available and saved groups with participant counts", async () => {
    const user = userEvent.setup();
    renderCampaigns();
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await screen.findByRole("checkbox", { name: "Select Unknown room" });
    const targetTable = screen.getByRole("table", { name: "Groups available to the campaign target selection" });
    expect(within(targetTable).getByRole("columnheader", { name: "Participants" })).toBeInTheDocument();
    expect(within(targetTable).getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("Saved targets")).not.toBeInTheDocument();
    expect(screen.queryByRole("rowheader")).not.toBeInTheDocument();
    expect(screen.getByText("1 outside current view")).toBeInTheDocument();
    expect(screen.queryByText("Denied room")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show selected" }));
    const deniedReviewCheckbox = screen.getByRole("checkbox", { name: "Select Denied room" });
    expect(deniedReviewCheckbox).toBeChecked();
    await user.click(deniedReviewCheckbox);
    expect(deniedReviewCheckbox).not.toBeChecked();
    expect(screen.getByText("Pending removal")).toBeInTheDocument();
    expect(screen.getByText("+0 added · −1 pending removal")).toBeInTheDocument();
    await user.click(deniedReviewCheckbox);
    await user.click(screen.getByRole("button", { name: "Show results" }));

    const currentUnknownCheckbox = screen.getByRole("checkbox", { name: "Select Unknown room" });
    const selectAll = screen.getByRole("checkbox", { name: "Select all groups on this page" });
    expect(selectAll).not.toBeChecked();
    expect(selectAll).toHaveProperty("indeterminate", false);
    await user.click(selectAll);
    expect(currentUnknownCheckbox).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Select Denied room" })).not.toBeInTheDocument();
    await user.click(selectAll);
    expect(currentUnknownCheckbox).not.toBeChecked();
    await user.click(currentUnknownCheckbox);

    expect(screen.getByText("1 saved → 2 staged · +1 / −0")).toBeInTheDocument();
    expect(screen.getByText("1 outside current view")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show selected" }));
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
    await user.click(screen.getByRole("tab", { name: "Targets" }));

    const unknownCheckbox = await screen.findByRole("checkbox", { name: "Select Unknown room" });
    await user.click(unknownCheckbox);
    const targetSection = screen.getByRole("heading", { name: "Target groups" }).closest("section");
    expect(targetSection).not.toBeNull();
    expect(within(targetSection!).getByText("Page 1 of 2")).toBeInTheDocument();
    await user.click(within(targetSection!).getByRole("button", { name: "Next" }));

    expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 20, offset: 20,
    }, READ_OPTIONS);
    expect(await screen.findByText("Second page group")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select Unknown room" })).not.toBeInTheDocument();
    expect(screen.getByText("2 outside current view")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show selected" }));
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Show results" }));
    const selectPage = screen.getByRole("checkbox", { name: "Select all groups on this page" });
    expect(selectPage).not.toBeChecked();
    await user.click(selectPage);
    expect(screen.getByRole("checkbox", { name: "Select Second page group" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Select Unknown room" })).not.toBeInTheDocument();
    expect(screen.getByText("2 outside current view")).toBeInTheDocument();
    expect(within(targetSection!).getByText("Page 2 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show selected" }));
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Second page group" })).toBeChecked();
  });

  it("uses the shared filter interaction for capability, freshness, participants, and inactive groups", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue({
      data: [unknownGroup], meta: { total: 1, limit: 20, offset: 0 },
    });
    renderCampaigns({ listGroups });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1));

    const targetSection = screen.getByRole("heading", { name: "Target groups" }).closest("section");
    expect(targetSection).not.toBeNull();
    await user.click(within(targetSection!).getByRole("button", { name: "Filters" }));
    const panel = screen.getByRole("region", { name: "Target group filters" });
    await user.click(within(panel).getByRole("checkbox", { name: "Allowed" }));
    await user.click(within(panel).getByRole("checkbox", { name: "Unknown" }));
    await user.click(within(panel).getByRole("checkbox", { name: "Current" }));
    await user.click(within(panel).getByRole("radio", { name: "Inactive" }));
    const minimum = within(panel).getByRole("spinbutton", { name: "Minimum" });
    const maximum = within(panel).getByRole("spinbutton", { name: "Maximum" });
    expect(minimum.closest(".text-field")).toHaveClass("ui-field-xs");
    expect(maximum.closest(".text-field")).toHaveClass("ui-field-xs");
    expect(minimum).toHaveClass("text-field-input-mono");
    expect(maximum).toHaveClass("text-field-input-mono");
    await user.type(minimum, "50");
    await user.type(maximum, "500");

    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      capabilityStatus: ["ALLOWED", "UNKNOWN"],
      capabilityFreshness: ["CURRENT"],
      isActive: false,
      minParticipants: 50,
      maxParticipants: 500,
    }, READ_OPTIONS));
    expect(within(panel).queryByRole("button", { name: "Apply range" })).not.toBeInTheDocument();
    expect(within(targetSection!).getByRole("button", { name: "Filters · 4" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Remove ≥ 50 participants filter" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select Denied room" })).not.toBeInTheDocument();
    expect(screen.getByText("1 outside current view")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 20, offset: 0,
    }, READ_OPTIONS));
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
    }, READ_OPTIONS);
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
    }, READ_OPTIONS);
    expect(await within(targetSection!).findByText("All results shown")).toBeInTheDocument();
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
    }, READ_OPTIONS);
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
    }, READ_OPTIONS);

    await user.clear(search);
    await user.type(search, "   ");
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(3));
    expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id, limit: 20, offset: 0,
    }, READ_OPTIONS);
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

  it("invalidates an in-flight group response when the workspace dialog closes", async () => {
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

    await user.click(screen.getByRole("button", { name: "Close dialog" }));
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
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    expect(screen.getByRole("radiogroup", { name: "Execution mode" })).toBeInTheDocument();
    await runPreflight(user, mode);
    const result = await screen.findByRole("region", { name: "Preflight result" });
    expect(screen.getByRole("heading", {
      name: status === "BLOCK"
        ? "Launch is blocked"
        : status === "WARN"
          ? mode === "LIVE"
            ? "Live launch needs a pass"
            : "Eligible with warnings"
          : mode === "DRY_RUN"
            ? "Eligible for a dry run"
            : "Ready for live confirmation",
    })).toBeInTheDocument();
    expect(within(result).getByRole("heading", {
      name: status === "PASS" ? "Ready to continue" : status === "WARN" ? "Review warnings" : "Action required",
    })).toBeInTheDocument();
    expect(within(result).getByRole("heading", { name: "Runtime target assessment" })).toBeInTheDocument();
    const checksPanel = within(result).getByRole("heading", { name: "Policy checks" }).closest("section");
    expect(checksPanel).not.toBeNull();
    expect(within(checksPanel!).getByText(status === "PASS" ? "Pass" : status === "WARN" ? "Warn" : "Block")).toHaveClass(
      `ui-badge-${status === "PASS" ? "success" : status === "WARN" ? "warning" : "danger"}`,
    );
    expect(within(result).getByRole("heading", { name: "Target issues" })).toBeInTheDocument();
    const issuesPanel = within(result).getByRole("heading", { name: "Target issues" }).closest("section");
    expect(issuesPanel).not.toBeNull();
    expect(within(issuesPanel!).getByText("Denied")).toHaveClass("ui-badge-danger");
    expect(within(issuesPanel!).getByText("Denied room").parentElement).toHaveClass("preflight-evidence-copy");
    expect(within(result).getByText("Group capability")).toBeInTheDocument();
    expect(await screen.findByText("GROUP_CAPABILITY")).toBeInTheDocument();
    expect(screen.getByText("TARGET_CAPABILITY_DENIED")).toBeInTheDocument();
    expect(screen.getByText("Policy v6")).toBeInTheDocument();
    const metrics = within(result).getByRole("group", { name: "Target readiness" });
    expect(within(metrics).getByText("9")).toBeInTheDocument();
    expect(within(metrics).getByText("5")).toBeInTheDocument();
    expect(within(metrics).getByText("3")).toBeInTheDocument();
    expect(within(metrics).getByText("1")).toBeInTheDocument();
    expect(preflightCampaign).toHaveBeenCalledWith(campaign.id, mode);
  });

  it("collapses an empty target issue result and keeps policy evidence full width", async () => {
    const user = userEvent.setup();
    const cleanReport = {
      ...report("DRY_RUN", "PASS"),
      allowedTargets: 9,
      deniedTargets: 0,
      unknownTargets: 0,
      targetIssues: [],
    };
    renderCampaigns({ preflightCampaign: vi.fn().mockResolvedValue(cleanReport) });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user);

    const result = await screen.findByRole("region", { name: "Preflight result" });
    const evidence = result.querySelector(".preflight-evidence");
    expect(evidence).not.toBeNull();
    expect(evidence).not.toHaveAttribute("data-has-target-issues");
    expect(within(result).queryByRole("heading", { name: "Target issues" })).not.toBeInTheDocument();
    const noTargetIssues = within(result).getByRole("status");
    expect(noTargetIssues).toHaveClass("inline-alert", "inline-alert-success");
    expect(noTargetIssues).toHaveTextContent("No target issues");
    expect(noTargetIssues).toHaveTextContent("Runtime found no groups that require operator attention.");
    expect(noTargetIssues.querySelector(".status-tone-success")).toBeInTheDocument();
    expect(within(result).getByRole("heading", { name: "Policy checks" }).closest("section"))
      .toHaveClass("preflight-policy-checks");
    expect(screen.getByText(/PASS · 9\/9 eligible · Checked/)).toBeInTheDocument();
    expect(within(screen.getByRole("tab", { name: "Review & launch" })).queryByText("PASS"))
      .not.toBeInTheDocument();
  });

  it("allows a warned DRY_RUN but never offers LIVE launch without a passing proof", async () => {
    const user = userEvent.setup();
    const preflightCampaign = vi.fn()
      .mockResolvedValueOnce(report("DRY_RUN", "WARN"))
      .mockResolvedValueOnce(report("LIVE", "WARN"));
    const createCampaignRun = vi.fn().mockResolvedValue(campaignRun("DRY_RUN"));
    renderCampaigns({ createCampaignRun, preflightCampaign });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));

    await runPreflight(user);
    expect(await screen.findByRole("button", { name: "Create dry run" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Create dry run" }));
    await waitFor(() => expect(createCampaignRun).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("radio", { name: "Live policy" }));
    await user.click(screen.getByRole("button", { name: "Run preflight" }));
    expect(await screen.findByRole("heading", { name: "Live launch needs a pass" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Launch live campaign" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run preflight again" })).toBeEnabled();
    expect(createCampaignRun).toHaveBeenCalledOnce();
  });

  it("renders stale capability and unknown future policy codes safely", async () => {
    const user = userEvent.setup();
    const next = report("LIVE", "WARN");
    next.policyVersion = 2;
    next.checks = [{
      code: "FUTURE_RUNTIME_CHECK" as RuntimeCampaignPreflight["checks"][number]["code"],
      status: "WARN",
      message: "Future policy",
    }];
    next.targetIssues = [{
      groupId: deniedTarget.groupId,
      groupName: deniedTarget.groupName,
      capability: "ALLOWED",
      reason: "TARGET_CAPABILITY_STALE",
    }];
    renderCampaigns({ preflightCampaign: vi.fn().mockResolvedValue(next) });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user, "LIVE");
    expect(await screen.findByText("TARGET_CAPABILITY_STALE")).toBeInTheDocument();
    expect(screen.getByText("FUTURE_RUNTIME_CHECK")).toBeInTheDocument();
    expect(screen.getByText("Policy v2")).toBeInTheDocument();
  });

  it("retries one dry-run launch intent with the same key and revision preconditions", async () => {
    const user = userEvent.setup();
    const created = campaignRun("DRY_RUN");
    const createCampaignRun = vi.fn()
      .mockRejectedValueOnce(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      ))
      .mockResolvedValueOnce(created);
    renderCampaigns({
      createCampaignRun,
      preflightCampaign: vi.fn().mockResolvedValue(report("DRY_RUN", "PASS")),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user);
    await screen.findByText("GROUP_CAPABILITY");
    await user.click(screen.getByRole("button", { name: "Create dry run" }));
    expect(await screen.findByText(/same request key/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create dry run" }));
    expect(await screen.findByText("Dry run created")).toBeInTheDocument();
    expect(createCampaignRun).toHaveBeenCalledTimes(2);
    expect(createCampaignRun.mock.calls[0][1]).toEqual({
      executionMode: "DRY_RUN",
      expectedCampaignRevision: 3,
      expectedTargetsRevision: 4,
    });
    expect(createCampaignRun.mock.calls[0][2]).toBe(createCampaignRun.mock.calls[1][2]);
    expect(screen.getByText(/dry_run-run-id/)).toBeInTheDocument();
  });

  it("allows multiple explicit DRY_RUN intents while the Campaign remains DRAFT", async () => {
    const user = userEvent.setup();
    const createCampaignRun = vi.fn()
      .mockResolvedValueOnce({ ...campaignRun("DRY_RUN"), id: "dry-one" })
      .mockResolvedValueOnce({ ...campaignRun("DRY_RUN"), id: "dry-two" });
    renderCampaigns({
      createCampaignRun,
      preflightCampaign: vi.fn().mockResolvedValue(report("DRY_RUN", "PASS")),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user);
    await screen.findByText("GROUP_CAPABILITY");
    await user.click(screen.getByRole("button", { name: "Create dry run" }));
    await waitFor(() => expect(createCampaignRun).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Create dry run" }));
    await waitFor(() => expect(createCampaignRun).toHaveBeenCalledTimes(2));
    expect(createCampaignRun.mock.calls[0][2]).not.toBe(createCampaignRun.mock.calls[1][2]);
    expect(screen.getByText(/dry-one/)).toBeInTheDocument();
    expect(screen.getByText(/dry-two/)).toBeInTheDocument();
  });

  it("launches LIVE once, refreshes ACTIVE campaign state, and makes the editor read-only", async () => {
    const user = userEvent.setup();
    const liveRun = campaignRun("LIVE", "RUNNING");
    const createCampaignRun = vi.fn().mockResolvedValue(liveRun);
    renderCampaigns({
      createCampaignRun,
      getCampaign: vi.fn().mockResolvedValue({ ...campaign, status: "ACTIVE" }),
      preflightCampaign: vi.fn().mockResolvedValue(report("LIVE", "PASS")),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user, "LIVE");
    await screen.findByText("GROUP_CAPABILITY");
    await user.click(screen.getByRole("button", { name: "Launch live campaign" }));
    const dialog = screen.getByRole("dialog", { name: "Launch LIVE campaign?" });
    await user.click(within(dialog).getByRole("button", { name: "Launch live campaign" }));
    expect(await screen.findByText("Live campaign launched")).toBeInTheDocument();
    expect(createCampaignRun).toHaveBeenCalledTimes(1);
    expect(createCampaignRun).toHaveBeenCalledWith(campaign.id, {
      executionMode: "LIVE",
      expectedCampaignRevision: 3,
      expectedTargetsRevision: 4,
      preflightToken: "clp1.test-payload.test-signature-with-sufficient-length",
    }, expect.any(String));
    expect(await screen.findByText(/Runtime status is Active/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Content" }));
    expect(screen.getByRole("textbox", { name: "Campaign name" })).toBeDisabled();
  });

  it("keeps a failed LIVE launch retry inside the active confirmation", async () => {
    const user = userEvent.setup();
    renderCampaigns({
      createCampaignRun: vi.fn().mockRejectedValue(new Error("Runtime unavailable.")),
      preflightCampaign: vi.fn().mockResolvedValue(report("LIVE", "PASS")),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user, "LIVE");
    await screen.findByText("GROUP_CAPABILITY");
    await user.click(screen.getByRole("button", { name: "Launch live campaign" }));
    const confirmation = screen.getByRole("dialog", { name: "Launch LIVE campaign?" });

    await user.click(within(confirmation).getByRole("button", { name: "Launch live campaign" }));

    const alert = await within(confirmation).findByRole("alert");
    expect(alert).toHaveTextContent("Could not launch campaign");
    expect(alert).toHaveTextContent("Runtime unavailable.");
    expect(screen.getAllByText("Runtime unavailable.")).toHaveLength(1);
  });

  it("reports a committed LIVE launch separately from a failed follow-up refresh", async () => {
    const user = userEvent.setup();
    const createCampaignRun = vi.fn().mockResolvedValue(campaignRun("LIVE", "RUNNING"));
    renderCampaigns({
      createCampaignRun,
      getCampaign: vi.fn().mockRejectedValue(new TypeError("refresh offline")),
      preflightCampaign: vi.fn().mockResolvedValue(report("LIVE", "PASS")),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user, "LIVE");
    await screen.findByText("GROUP_CAPABILITY");
    await user.click(screen.getByRole("button", { name: "Launch live campaign" }));
    await user.click(within(screen.getByRole("dialog", { name: "Launch LIVE campaign?" }))
      .getByRole("button", { name: "Launch live campaign" }));

    expect(await screen.findByText("Live campaign launched")).toBeInTheDocument();
    expect(await screen.findByText(/live run was created, but the latest Campaign state/)).toBeInTheDocument();
    expect(screen.queryByText("Could not create campaign run.")).not.toBeInTheDocument();
    expect(createCampaignRun).toHaveBeenCalledOnce();
  });

  it("does not retry a launch revision conflict and requires a new preflight", async () => {
    const user = userEvent.setup();
    const createCampaignRun = vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
      code: "CAMPAIGN_RUN_REVISION_CONFLICT", status: 409,
    }));
    renderCampaigns({
      createCampaignRun,
      getCampaign: vi.fn().mockResolvedValue({ ...campaign, revision: 4 }),
      preflightCampaign: vi.fn().mockResolvedValue(report("DRY_RUN", "PASS")),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user);
    await screen.findByText("GROUP_CAPABILITY");
    await user.click(screen.getByRole("button", { name: "Create dry run" }));
    expect(await screen.findByText(/changed after review/)).toBeInTheDocument();
    expect(createCampaignRun).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No Runtime decision yet")).toBeInTheDocument();
  });

  it("reconciles pause and resume with the separate Campaign lifecycle", async () => {
    const user = userEvent.setup();
    const running = campaignRun("LIVE", "RUNNING");
    const paused = { ...running, status: "PAUSED" as const };
    const resumed = { ...running, status: "RUNNING" as const };
    const pauseCampaignRun = vi.fn().mockResolvedValue(paused);
    const resumeCampaignRun = vi.fn().mockResolvedValue(resumed);
    const getCampaign = vi.fn()
      .mockResolvedValueOnce({ ...campaign, status: "PAUSED" })
      .mockResolvedValueOnce({ ...campaign, status: "ACTIVE" });
    renderCampaigns({
      getCampaign,
      listCampaignRuns: vi.fn().mockResolvedValue({ data: [running], meta: { total: 1, limit: 20, offset: 0 } }),
      pauseCampaignRun,
      resumeCampaignRun,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await user.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pauseCampaignRun).toHaveBeenCalledWith(
      running.id,
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ));
    expect(await screen.findByText(/Campaign lifecycle: Paused/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resumeCampaignRun).toHaveBeenCalledWith(
      running.id,
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ));
    expect(await screen.findByText(/Campaign lifecycle: Active/)).toBeInTheDocument();
  });

  it("keeps a committed pause when the Campaign refresh fails", async () => {
    const user = userEvent.setup();
    const running = campaignRun("LIVE", "RUNNING");
    const pauseCampaignRun = vi.fn().mockResolvedValue({ ...running, status: "PAUSED" as const });
    renderCampaigns({
      getCampaign: vi.fn().mockRejectedValue(new TypeError("refresh offline")),
      listCampaignRuns: vi.fn().mockResolvedValue({
        data: [running], meta: { total: 1, limit: 20, offset: 0 },
      }),
      pauseCampaignRun,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await user.click(await screen.findByRole("button", { name: "Pause" }));

    expect(await screen.findByText(/Runtime accepted the pause action/)).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.queryByText("Could not pause campaign run.")).not.toBeInTheDocument();
    expect(pauseCampaignRun).toHaveBeenCalledOnce();
  });

  it("keeps Campaign PAUSED and reloads a BLOCKED run when resume preflight conflicts", async () => {
    const user = userEvent.setup();
    const paused = campaignRun("LIVE", "PAUSED");
    const blocked = { ...paused, status: "BLOCKED" as const, preflight: report("LIVE", "BLOCK") };
    renderCampaigns({
      getCampaign: vi.fn().mockResolvedValue({ ...campaign, status: "PAUSED" }),
      getCampaignRun: vi.fn().mockResolvedValue(blocked),
      listCampaignRuns: vi.fn().mockResolvedValue({ data: [paused], meta: { total: 1, limit: 20, offset: 0 } }),
      resumeCampaignRun: vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
        code: "CAMPAIGN_RUN_STATE_CONFLICT",
        details: { preflight: report("LIVE", "BLOCK") },
        status: 409,
      })),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await user.click(await screen.findByRole("button", { name: "Resume" }));
    expect(await screen.findByText(/Campaign lifecycle: Paused/)).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it("reloads canonical run and Campaign state after an unconfirmed pause result", async () => {
    const user = userEvent.setup();
    const running = campaignRun("LIVE", "RUNNING");
    const paused = { ...running, status: "PAUSED" as const };
    const getCampaign = vi.fn().mockResolvedValue({ ...campaign, status: "PAUSED" });
    const getCampaignRun = vi.fn().mockResolvedValue(paused);
    renderCampaigns({
      getCampaign,
      getCampaignRun,
      listCampaignRuns: vi.fn().mockResolvedValue({
        data: [running],
        meta: { total: 1, limit: 20, offset: 0 },
      }),
      pauseCampaignRun: vi.fn().mockRejectedValue(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      )),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await user.click(await screen.findByRole("button", { name: "Pause" }));

    expect(await screen.findByText(/did not confirm the result/)).toBeInTheDocument();
    await waitFor(() => expect(getCampaignRun).toHaveBeenCalledWith(running.id));
    expect(getCampaign).toHaveBeenCalledWith(campaign.id);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText(/Campaign lifecycle: Paused/)).toBeInTheDocument();
  });

  it("reuses the same run action key after an unconfirmed pause", async () => {
    const user = userEvent.setup();
    const running = campaignRun("LIVE", "RUNNING");
    const pauseCampaignRun = vi.fn()
      .mockRejectedValueOnce(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      ))
      .mockResolvedValueOnce({ ...running, status: "PAUSED" as const });
    renderCampaigns({
      getCampaignRun: vi.fn().mockResolvedValue(running),
      listCampaignRuns: vi.fn().mockResolvedValue({
        data: [running],
        meta: { total: 1, limit: 20, offset: 0 },
      }),
      pauseCampaignRun,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));

    await user.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByText(/same request key/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(pauseCampaignRun).toHaveBeenCalledTimes(2));
    expect(pauseCampaignRun.mock.calls[0]?.[1]).toBe(pauseCampaignRun.mock.calls[1]?.[1]);
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });

  it("renders an ARCHIVED Campaign after a terminal LIVE cancellation", async () => {
    const user = userEvent.setup();
    const running = campaignRun("LIVE", "RUNNING");
    const cancelled = { ...running, status: "CANCELLED" as const, completedAt: "2026-08-15T01:00:00.000Z" };
    renderCampaigns({
      cancelCampaignRun: vi.fn().mockResolvedValue(cancelled),
      getCampaign: vi.fn().mockResolvedValue({ ...campaign, status: "ARCHIVED" }),
      listCampaignRuns: vi.fn().mockResolvedValue({ data: [running], meta: { total: 1, limit: 20, offset: 0 } }),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(/Campaign lifecycle: Archived/)).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("reloads Campaign lifecycle with an asynchronously completed LIVE run", async () => {
    const user = userEvent.setup();
    const running = campaignRun("LIVE", "RUNNING");
    const completed = campaignRun("LIVE", "COMPLETED");
    const listCampaignRuns = vi.fn()
      .mockResolvedValueOnce({ data: [running], meta: { total: 1, limit: 20, offset: 0 } })
      .mockResolvedValueOnce({ data: [completed], meta: { total: 1, limit: 20, offset: 0 } });
    renderCampaigns({
      getCampaign: vi.fn().mockResolvedValue({ ...campaign, status: "ARCHIVED" }),
      listCampaignRuns,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await screen.findByText("Running");
    await user.click(screen.getByRole("button", { name: "Reload runs" }));
    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText(/Campaign lifecycle: Archived/)).toBeInTheDocument();
  });

  it("renders immutable run provenance from the Runtime snapshot", async () => {
    const user = userEvent.setup();
    const run = {
      ...campaignRun("DRY_RUN"),
      targetSource: {
        type: "GROUP_LIST" as const,
        groupListId: "11111111-1111-4111-8111-111111111111",
        groupListNameSnapshot: "Original launch list",
        membershipRevision: 9,
        appliedAt: "2026-08-15T01:00:00.000Z",
      },
    };
    const listGroupLists = vi.fn();
    renderCampaigns({
      listCampaignRuns: vi.fn().mockResolvedValue({ data: [run], meta: { total: 1, limit: 20, offset: 0 } }),
      listGroupLists,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));

    expect(await screen.findByText(/From saved list: Original launch list/)).toBeInTheDocument();
    expect(screen.getByText(/membership r9/)).toBeInTheDocument();
    expect(listGroupLists).not.toHaveBeenCalled();
  });

  it("marks a report stale after local content or target edits and prevents preflight over unsaved state", async () => {
    const user = userEvent.setup();
    renderCampaigns({ preflightCampaign: vi.fn().mockResolvedValue(report("DRY_RUN", "PASS")) });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user);
    await screen.findByText("GROUP_CAPABILITY");

    await user.click(screen.getByRole("tab", { name: "Content" }));
    await user.type(screen.getByRole("textbox", { name: "Message text" }), " changed");
    await user.click(screen.getByRole("tab", { name: /Review & launch/ }));
    expect(screen.getByText("Preflight result is stale")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run preflight again" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: /Content/ }));
    await user.clear(screen.getByRole("textbox", { name: "Message text" }));
    await user.type(screen.getByRole("textbox", { name: "Message text" }), campaign.text);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await user.click(await screen.findByRole("checkbox", { name: "Select Unknown room" }));
    await user.click(screen.getByRole("tab", { name: /Review & launch/ }));
    expect(screen.getByText("Preflight result is stale")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run preflight again" })).toBeDisabled();
  });

  it("ignores a late preflight response after the editor closes", async () => {
    const user = userEvent.setup();
    let resolveReport!: (value: RuntimeCampaignPreflight) => void;
    const pending = new Promise<RuntimeCampaignPreflight>((resolve) => { resolveReport = resolve; });
    renderCampaigns({ preflightCampaign: vi.fn().mockReturnValue(pending) });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    resolveReport(report("DRY_RUN", "PASS"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Campaigns" })).toBeInTheDocument());
    expect(screen.queryByText("GROUP_CAPABILITY")).not.toBeInTheDocument();
  });

  it("invalidates an in-flight preflight as soon as persisted input becomes dirty", async () => {
    const user = userEvent.setup();
    const pending = deferred<RuntimeCampaignPreflight>();
    const preflightCampaign = vi.fn().mockReturnValue(pending.promise);
    renderCampaigns({ preflightCampaign });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user);
    await user.click(screen.getByRole("tab", { name: "Content" }));
    await user.type(screen.getByRole("textbox", { name: "Message text" }), " changed");

    await act(async () => pending.resolve(report("DRY_RUN", "PASS")));
    await user.click(screen.getByRole("tab", { name: /Review & launch/ }));

    expect(screen.queryByText("GROUP_CAPABILITY")).not.toBeInTheDocument();
    expect(screen.getByText("No preflight result yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run preflight" })).toBeDisabled();
  });

  it("ignores a late run launch response after the editor closes", async () => {
    const user = userEvent.setup();
    const pending = deferred<RuntimeCampaignRun>();
    renderCampaigns({
      createCampaignRun: vi.fn().mockReturnValue(pending.promise),
      preflightCampaign: vi.fn().mockResolvedValue(report("DRY_RUN", "PASS")),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: "Review & launch" }));
    await runPreflight(user);
    await screen.findByText("GROUP_CAPABILITY");
    await user.click(screen.getByRole("button", { name: "Create dry run" }));
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await act(async () => pending.resolve(campaignRun("DRY_RUN")));
    expect(screen.queryByText(/dry_run-run-id/)).not.toBeInTheDocument();
    expect(screen.queryByText("Dry run created")).not.toBeInTheDocument();
  });

  it("atomically applies a Group List snapshot with list and target revisions", async () => {
    const user = userEvent.setup();
    const list: RuntimeGroupList = {
      id: "11111111-1111-4111-8111-111111111111", sessionId: session.id,
      name: "Launch list", description: "Reusable launch groups", groupCount: 2,
      revision: 1, membershipRevision: 7, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const source = {
      type: "GROUP_LIST" as const, groupListId: list.id, groupListNameSnapshot: "Launch list snapshot", membershipRevision: 7,
      appliedAt: "2026-08-15T01:00:00.000Z",
    };
    const applyGroupListToCampaignTargets = vi.fn().mockResolvedValue({
      data: [deniedTarget, { groupId: unknownGroup.id, groupName: unknownGroup.name, enabled: true, participantsCount: unknownGroup.participantsCount, sendCapability: unknownGroup.sendCapability }],
      targetsRevision: 5,
      source,
    });
    renderCampaigns({
      listGroupLists: vi.fn().mockResolvedValue({ data: [list], meta: { total: 1, limit: 100, offset: 0 } }),
      applyGroupListToCampaignTargets,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    expect(within(picker).getByRole("heading", { name: "Apply group list" })).toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(picker).getByText("No list selected")).toBeInTheDocument();
    const listRow = await within(picker).findByRole("radio", { name: /Launch list/ });
    await user.click(listRow);
    expect(listRow).toBeChecked();
    expect(within(picker).getByText("Ready to review before applying.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review" }));
    const dialog = screen.getByRole("dialog", { name: "Review target replacement" });
    await user.click(within(dialog).getByRole("button", { name: "Apply list" }));
    expect(await screen.findByText(/membership revision 7 was applied/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).toBeChecked();
    expect(applyGroupListToCampaignTargets).toHaveBeenCalledWith(campaign.id, {
      groupListId: list.id,
      expectedMembershipRevision: 7,
      expectedTargetsRevision: 4,
    });
    expect(screen.getByText("From group list: Launch list snapshot")).toBeInTheDocument();
    expect(screen.getByText("Materialized from a saved list; this is not a live link.")).toBeInTheDocument();
  });

  it("locks the Group List review while applying and dispatches the snapshot once", async () => {
    const user = userEvent.setup();
    const list: RuntimeGroupList = {
      id: "81111111-1111-4111-8111-111111111111", sessionId: session.id,
      name: "Single apply list", description: null, groupCount: 1,
      revision: 1, membershipRevision: 2, archivedAt: null,
      createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const pending = deferred<Awaited<ReturnType<RuntimeApi["applyGroupListToCampaignTargets"]>>>();
    const applyGroupListToCampaignTargets = vi.fn().mockReturnValue(pending.promise);
    renderCampaigns({
      applyGroupListToCampaignTargets,
      listGroupLists: vi.fn().mockResolvedValue({
        data: [list], meta: { total: 1, limit: 100, offset: 0 },
      }),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    await user.click(await within(picker).findByRole("radio", { name: /Single apply list/ }));
    await user.click(within(picker).getByRole("button", { name: "Review" }));
    const review = screen.getByRole("dialog", { name: "Review target replacement" });
    const applyButton = within(review).getByRole("button", { name: "Apply list" });

    act(() => {
      applyButton.click();
      applyButton.click();
    });

    expect(applyGroupListToCampaignTargets).toHaveBeenCalledOnce();
    expect(within(review).getByRole("button", { name: "Back" })).toBeDisabled();
    expect(within(review).getByRole("button", { name: "Close dialog" })).toBeDisabled();

    await act(async () => pending.resolve({
      data: [deniedTarget],
      targetsRevision: 5,
      source: {
        type: "GROUP_LIST",
        groupListId: list.id,
        groupListNameSnapshot: list.name,
        membershipRevision: list.membershipRevision,
        appliedAt: "2026-08-15T01:00:00.000Z",
      },
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review target replacement" })).not.toBeInTheDocument());
  });

  it("paginates Group List results on the server and retains selection outside the current page", async () => {
    const user = userEvent.setup();
    const firstList: RuntimeGroupList = {
      id: "71111111-1111-4111-8111-111111111111", sessionId: session.id,
      name: "First page list", description: "Selected from page one", groupCount: 12,
      revision: 1, membershipRevision: 3, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const secondList: RuntimeGroupList = {
      ...firstList,
      id: "72222222-2222-4222-8222-222222222222",
      name: "Second page list",
    };
    const listGroupLists = vi.fn(async (params: Parameters<RuntimeApi["listGroupLists"]>[0]) => ({
      data: params.offset === 5 ? [secondList] : [firstList],
      meta: { total: 6, limit: 5, offset: params.offset ?? 0 },
    }));
    renderCampaigns({ listGroupLists });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    await user.click(await within(picker).findByRole("radio", { name: /First page list/ }));
    expect(within(picker).getByRole("button", { name: "Review" })).toBeEnabled();

    await user.click(within(picker).getByRole("button", { name: "Next" }));
    expect(await within(picker).findByRole("radio", { name: /Second page list/ })).toBeInTheDocument();
    expect(within(picker).getByText("Selected outside current results")).toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: "Review" })).toBeEnabled();
    expect(listGroupLists).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 5,
      offset: 5,
    }, READ_OPTIONS);
  });

  it("ignores a late atomic list apply response after the editor closes", async () => {
    const user = userEvent.setup();
    const list: RuntimeGroupList = {
      id: "66666666-6666-4666-8666-666666666666", sessionId: session.id,
      name: "Late list", description: null, groupCount: 0, revision: 1,
      membershipRevision: 0, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const pending = deferred<Awaited<ReturnType<RuntimeApi["applyGroupListToCampaignTargets"]>>>();
    renderCampaigns({
      applyGroupListToCampaignTargets: vi.fn().mockReturnValue(pending.promise),
      listGroupLists: vi.fn().mockResolvedValue({ data: [list], meta: { total: 1, limit: 100, offset: 0 } }),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    await user.click(await within(picker).findByRole("radio", { name: /Late list/ }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(within(screen.getByRole("dialog", { name: "Review target replacement" })).getByRole("button", { name: "Apply list" }));
    await user.click(within(screen.getByRole("dialog", { name: campaign.name }))
      .getByRole("button", { name: "Close dialog" }));
    await act(async () => pending.resolve({
      data: [], targetsRevision: 5,
      source: { type: "GROUP_LIST", groupListId: list.id, groupListNameSnapshot: "Late list snapshot", membershipRevision: 0, appliedAt: "2026-08-15T01:00:00.000Z" },
    }));
    expect(screen.queryByText(/membership revision 0 was applied/)).not.toBeInTheDocument();
  });

  it("loads Group Lists lazily and ignores a late response after the picker closes", async () => {
    const user = userEvent.setup();
    const latePage = deferred<Awaited<ReturnType<RuntimeApi["listGroupLists"]>>>();
    const currentList: RuntimeGroupList = {
      id: "44444444-4444-4444-8444-444444444444", sessionId: session.id,
      name: "Current list", description: null, groupCount: 1, revision: 1, membershipRevision: 1,
      archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const listGroupLists = vi.fn()
      .mockReturnValueOnce(latePage.promise)
      .mockResolvedValueOnce({ data: [currentList], meta: { total: 1, limit: 100, offset: 0 } });
    renderCampaigns({ listGroupLists });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    expect(listGroupLists).not.toHaveBeenCalled();
    const openedPicker = await openSavedListPicker(user);
    await waitFor(() => expect(listGroupLists).toHaveBeenCalledTimes(1));
    await user.click(within(openedPicker).getByRole("button", { name: "Close dialog" }));
    latePage.resolve({ data: [{ ...currentList, id: "late", name: "Late list" }], meta: { total: 1, limit: 100, offset: 0 } });
    await Promise.resolve();
    expect(screen.queryByRole("dialog", { name: "Apply group list" })).not.toBeInTheDocument();
    const picker = await openSavedListPicker(user);
    expect(await within(picker).findByRole("radio", { name: /Current list/ })).toBeInTheDocument();
    expect(within(picker).queryByRole("radio", { name: /Late list/ })).not.toBeInTheDocument();
  });

  it("requires confirmation and atomically persists an empty Group List snapshot", async () => {
    const user = userEvent.setup();
    const emptyList: RuntimeGroupList = {
      id: "22222222-2222-4222-8222-222222222222", sessionId: session.id,
      name: "Empty list", description: null, groupCount: 0, revision: 1, membershipRevision: 0,
      archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const applyGroupListToCampaignTargets = vi.fn().mockResolvedValue({
      data: [], targetsRevision: 5,
      source: { type: "GROUP_LIST", groupListId: emptyList.id, groupListNameSnapshot: "Empty list snapshot", membershipRevision: 0, appliedAt: "2026-08-15T01:00:00.000Z" },
    });
    renderCampaigns({
      listGroupLists: vi.fn().mockResolvedValue({ data: [emptyList], meta: { total: 1, limit: 100, offset: 0 } }),
      applyGroupListToCampaignTargets,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    await user.click(await within(picker).findByRole("radio", { name: /Empty list/ }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText(/This list is empty/)).toBeInTheDocument();
    expect(screen.getByText("1 saved target · No unsaved changes")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "Review target replacement" });
    await user.click(within(dialog).getByRole("button", { name: "Apply list" }));
    expect(await screen.findByText(/membership revision 0 was applied/)).toBeInTheDocument();
    expect(screen.getByText("Empty target set · No unsaved changes")).toBeInTheDocument();
    expect(applyGroupListToCampaignTargets).toHaveBeenCalledTimes(1);
  });

  it("keeps targets unchanged when atomic apply reports a source session mismatch", async () => {
    const user = userEvent.setup();
    const list: RuntimeGroupList = {
      id: "33333333-3333-4333-8333-333333333333", sessionId: session.id,
      name: "Moved list", description: null, groupCount: 1, revision: 1, membershipRevision: 2,
      archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    renderCampaigns({
      listGroupLists: vi.fn().mockResolvedValue({ data: [list], meta: { total: 1, limit: 100, offset: 0 } }),
      applyGroupListToCampaignTargets: vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
        code: "CAMPAIGN_TARGET_SOURCE_SESSION_MISMATCH", status: 409,
      })),
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    await user.click(await within(picker).findByRole("radio", { name: /Moved list/ }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    const dialog = screen.getByRole("dialog", { name: "Review target replacement" });
    await user.click(within(dialog).getByRole("button", { name: "Apply list" }));
    expect((await screen.findAllByText(/belongs to a different campaign session/)).length).toBeGreaterThan(0);
    expect(screen.getByText("1 saved target · No unsaved changes")).toBeInTheDocument();
  });

  it("warns that manual target edits clear canonical source provenance", async () => {
    const user = userEvent.setup();
    const source = {
      type: "GROUP_LIST" as const,
      groupListId: "11111111-1111-4111-8111-111111111111",
      groupListNameSnapshot: "Original launch list",
      membershipRevision: 9,
      appliedAt: "2026-08-15T01:00:00.000Z",
    };
    const replaceCampaignTargets = vi.fn().mockResolvedValue({
      data: [deniedTarget, { groupId: unknownGroup.id, groupName: unknownGroup.name, enabled: true, participantsCount: unknownGroup.participantsCount, sendCapability: unknownGroup.sendCapability }],
      targetsRevision: 5,
      source: null,
    });
    renderCampaigns({
      listCampaignTargets: vi.fn().mockResolvedValue({ data: [deniedTarget], targetsRevision: 4, source }),
      replaceCampaignTargets,
    });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    expect(await screen.findByText("From group list: Original launch list")).toBeInTheDocument();
    expect(screen.getByText(/Membership r9/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select Unknown room" }));
    expect(screen.getByText("Saving creates a custom selection.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save target set" }));
    await waitFor(() => expect(replaceCampaignTargets).toHaveBeenCalledWith(
      campaign.id,
      [deniedTarget.groupId, unknownGroup.id],
      4,
    ));
    expect(screen.queryByText("From group list: Original launch list")).not.toBeInTheDocument();
    expect(screen.getByText("Custom selection")).toBeInTheDocument();
  });

  it("reloads canonical targets after a target revision conflict without retrying mutation", async () => {
    const user = userEvent.setup();
    const listCampaignTargets = vi.fn()
      .mockResolvedValueOnce({ data: [deniedTarget], targetsRevision: 4, source: null })
      .mockResolvedValueOnce({ data: [], targetsRevision: 5, source: null });
    const replaceCampaignTargets = vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
      code: "CAMPAIGN_TARGETS_REVISION_CONFLICT", status: 409,
    }));
    renderCampaigns({ listCampaignTargets, replaceCampaignTargets });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await user.click(screen.getByRole("checkbox", { name: "Select Unknown room" }));
    await user.click(screen.getByRole("button", { name: "Save target set" }));
    await waitFor(() => expect(listCampaignTargets).toHaveBeenCalledTimes(2));
    expect(replaceCampaignTargets).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/canonical target snapshot is being reloaded/)).toBeInTheDocument();
    expect(screen.getByText("Empty target set · No unsaved changes")).toBeInTheDocument();
  });

  it("reloads canonical targets while preserving staged selection after an unconfirmed save", async () => {
    const user = userEvent.setup();
    const listCampaignTargets = vi.fn()
      .mockResolvedValueOnce({ data: [deniedTarget], targetsRevision: 4, source: null })
      .mockResolvedValueOnce({ data: [deniedTarget], targetsRevision: 4, source: null });
    const replaceCampaignTargets = vi.fn().mockRejectedValue(
      new RuntimeTransportError("response lost", { requestDispatched: true }),
    );
    renderCampaigns({ listCampaignTargets, replaceCampaignTargets });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await user.click(screen.getByRole("checkbox", { name: "Select Unknown room" }));
    await user.click(screen.getByRole("button", { name: "Save target set" }));

    expect(await screen.findByText(/did not confirm the result/)).toBeInTheDocument();
    await waitFor(() => expect(listCampaignTargets).toHaveBeenCalledTimes(2));
    expect(replaceCampaignTargets).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).toBeChecked();
    expect(screen.getByText("Changes not saved · 1 saved targets retained")).toBeInTheDocument();
  });

  it("reloads a stale Group List revision and never retries atomic apply automatically", async () => {
    const user = userEvent.setup();
    const list: RuntimeGroupList = {
      id: "55555555-5555-4555-8555-555555555555", sessionId: session.id,
      name: "Changing list", description: null, groupCount: 1, revision: 2,
      membershipRevision: 3, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const listGroupLists = vi.fn()
      .mockResolvedValueOnce({ data: [list], meta: { total: 1, limit: 100, offset: 0 } })
      .mockResolvedValueOnce({ data: [{ ...list, membershipRevision: 4 }], meta: { total: 1, limit: 100, offset: 0 } });
    const applyGroupListToCampaignTargets = vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
      code: "CAMPAIGN_TARGET_SOURCE_REVISION_CONFLICT", status: 409,
    }));
    renderCampaigns({ listGroupLists, applyGroupListToCampaignTargets });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    const picker = await openSavedListPicker(user);
    await user.click(await within(picker).findByRole("radio", { name: /Changing list/ }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(within(screen.getByRole("dialog", { name: "Review target replacement" })).getByRole("button", { name: "Apply list" }));
    await waitFor(() => expect(listGroupLists).toHaveBeenCalledTimes(2));
    expect(applyGroupListToCampaignTargets).toHaveBeenCalledTimes(1);
    expect((await screen.findAllByText(/membership changed/)).length).toBeGreaterThan(0);
  });

  it("resets staged target changes to the canonical saved set without persisting", async () => {
    const user = userEvent.setup();
    const replaceCampaignTargets = vi.fn();
    renderCampaigns({ replaceCampaignTargets });
    await connect(user);
    await openCampaign(user);
    await user.click(screen.getByRole("tab", { name: /Targets/ }));
    await user.click(await screen.findByRole("checkbox", { name: "Select Unknown room" }));
    expect(screen.getByText("1 saved → 2 staged · +1 / −0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset to saved" }));
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).not.toBeChecked();
    expect(screen.getByText("Staged selection reset to the saved target set.")).toBeInTheDocument();
    expect(screen.getByText("1 saved target · No unsaved changes")).toBeInTheDocument();
    expect(replaceCampaignTargets).not.toHaveBeenCalled();
  });

  it("E2E happy path: deletes a campaign from the row only after Runtime returns 204", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const deleteCampaign = vi.fn().mockReturnValue(pending.promise);
    const listCampaigns = vi.fn()
      .mockResolvedValueOnce({ data: [campaign], meta: { total: 1, limit: 50, offset: 0 } })
      .mockResolvedValue({ data: [], meta: { total: 0, limit: 50, offset: 0 } });
    renderCampaigns({ deleteCampaign, listCampaigns });
    await connect(user);
    await screen.findByText(campaign.name);

    expect(screen.getByRole("button", { name: campaign.name })).toHaveClass("data-primary-action");
    const rowAction = screen.getByRole("button", { name: `More actions for ${campaign.name}` });
    expect(within(rowAction.closest("td")!).getAllByRole("button")).toHaveLength(1);
    await user.click(rowAction);
    expect(screen.getByRole("menuitem", { name: "Edit campaign" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Edit campaign" })).toHaveAccessibleDescription(
      "Change content, targets, and launch checks.",
    );
    await user.click(screen.getByRole("menuitem", { name: /Delete campaign/ }));
    const dialog = screen.getByRole("dialog", { name: "Delete campaign?" });
    expect(dialog).toHaveTextContent("Run and message delivery history will remain available for audit.");
    await user.click(screen.getByRole("button", { name: "Delete campaign" }));

    expect(deleteCampaign).toHaveBeenCalledWith(campaign.id, campaign.revision, campaign.targetsRevision);
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByText(campaign.name)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Delete campaign?" })).toBeInTheDocument();

    await act(async () => pending.resolve(undefined));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete campaign?" })).not.toBeInTheDocument());
    expect(screen.queryByText(campaign.name)).not.toBeInTheDocument();
    expect(await screen.findByText("Campaign deleted")).toBeInTheDocument();
    expect(screen.getByText("Message delivery history was retained.")).toBeInTheDocument();
  });

  it.each(["ACTIVE", "PAUSED"] as const)("keeps delete visible but disabled for a %s campaign", async (status) => {
    const user = userEvent.setup();
    const locked = { ...campaign, id: `campaign-${status}`, name: `${status} campaign`, status };
    const deleteCampaign = vi.fn();
    renderCampaigns({ deleteCampaign }, [locked]);
    await connect(user);
    await screen.findByText(locked.name);

    const trigger = screen.getByRole("button", { name: `More actions for ${locked.name}` });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Review campaign" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    const item = screen.getByRole("menuitem", { name: /Delete campaign/ });
    expect(item).toHaveFocus();
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("Cancel the active run and archive the campaign before deleting it.");
    await user.click(item);
    expect(screen.queryByRole("dialog", { name: "Delete campaign?" })).not.toBeInTheDocument();
    expect(deleteCampaign).not.toHaveBeenCalled();
  });

  it("refreshes a campaign revision conflict and requires a new confirmation", async () => {
    const user = userEvent.setup();
    const refreshed = { ...campaign, name: "Release updated", revision: 4 };
    const deleteCampaign = vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
      code: "CAMPAIGN_REVISION_CONFLICT",
      status: 409,
    }));
    const listCampaigns = vi.fn()
      .mockResolvedValueOnce({ data: [campaign], meta: { total: 1, limit: 50, offset: 0 } })
      .mockResolvedValue({ data: [refreshed], meta: { total: 1, limit: 50, offset: 0 } });
    renderCampaigns({ deleteCampaign, listCampaigns });
    await connect(user);
    await screen.findByText(campaign.name);

    await user.click(screen.getByRole("button", { name: `More actions for ${campaign.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete campaign/ }));
    await user.click(screen.getByRole("button", { name: "Delete campaign" }));

    expect(await screen.findByText("The campaign changed. Review it before deleting.")).toBeInTheDocument();
    expect(await screen.findByText(refreshed.name)).toBeInTheDocument();
    expect(deleteCampaign).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Delete campaign?" })).not.toBeInTheDocument();
  });

  it("refreshes and explains a campaign delete state conflict", async () => {
    const user = userEvent.setup();
    const active = { ...campaign, status: "ACTIVE" as const };
    const deleteCampaign = vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
      code: "CAMPAIGN_DELETE_STATE_CONFLICT",
      status: 409,
    }));
    const listCampaigns = vi.fn()
      .mockResolvedValueOnce({ data: [campaign], meta: { total: 1, limit: 50, offset: 0 } })
      .mockResolvedValue({ data: [active], meta: { total: 1, limit: 50, offset: 0 } });
    const api = renderCampaigns({ deleteCampaign, listCampaigns });
    await connect(user);
    await screen.findByText(campaign.name);

    await user.click(screen.getByRole("button", { name: `More actions for ${campaign.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete campaign/ }));
    await user.click(screen.getByRole("button", { name: "Delete campaign" }));

    expect(await screen.findByText("Cancel the active run and archive the campaign before deleting it.")).toBeInTheDocument();
    expect(deleteCampaign).toHaveBeenCalledTimes(1);
    expect(api.getCampaign).toHaveBeenCalledWith(campaign.id, READ_OPTIONS);
    expect(api.listCampaignRuns).toHaveBeenCalledWith(campaign.id, 20, 0, READ_OPTIONS);
  });

  it("refreshes unfinished runs after a delete conflict and links to the run panel", async () => {
    const user = userEvent.setup();
    const running = campaignRun("LIVE", "RUNNING");
    const deleteCampaign = vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
      code: "CAMPAIGN_DELETE_RUN_CONFLICT",
      status: 409,
    }));
    const listCampaignRuns = vi.fn()
      .mockResolvedValueOnce({ data: [], meta: { total: 0, limit: 20, offset: 0 } })
      .mockResolvedValueOnce({ data: [running], meta: { total: 1, limit: 20, offset: 0 } });
    renderCampaigns({ deleteCampaign, listCampaignRuns });
    await connect(user);
    await openCampaign(user);

    const workspace = screen.getByRole("dialog", { name: campaign.name });
    await user.click(within(workspace).getByRole("button", { name: `More actions for ${campaign.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete campaign/ }));
    await user.click(screen.getByRole("button", { name: "Delete campaign" }));

    expect(await screen.findByText("This campaign still has an unfinished run. Cancel it or wait for it to finish.")).toBeInTheDocument();
    expect(listCampaignRuns).toHaveBeenCalledTimes(2);
    expect(deleteCampaign).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "View runs" }));
    expect(screen.getByRole("tab", { name: "Review & launch" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Running")).toBeInTheDocument();
  });

  it("keeps the campaign and confirmation open after a network failure", async () => {
    const user = userEvent.setup();
    const deleteCampaign = vi.fn().mockRejectedValue(new TypeError("network down"));
    renderCampaigns({ deleteCampaign });
    await connect(user);
    await screen.findByText(campaign.name);

    await user.click(screen.getByRole("button", { name: `More actions for ${campaign.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete campaign/ }));
    await user.click(screen.getByRole("button", { name: "Delete campaign" }));

    const confirmation = screen.getByRole("dialog", { name: "Delete campaign?" });
    expect(await within(confirmation).findByText("The campaign could not be deleted. Check the Runtime connection and try again.")).toBeInTheDocument();
    expect(within(confirmation).getByText("Could not delete campaign")).toBeInTheDocument();
    expect(screen.getByText(campaign.name)).toBeInTheDocument();
    expect(deleteCampaign).toHaveBeenCalledTimes(1);
  });

  it("reconciles an unconfirmed delete as successful when the campaign is missing", async () => {
    const user = userEvent.setup();
    const deleteCampaign = vi.fn().mockRejectedValue(new RuntimeTransportError(
      "response lost",
      { requestDispatched: true },
    ));
    const getCampaign = vi.fn().mockRejectedValue(new RuntimeRequestError("missing", {
      code: "CAMPAIGN_NOT_FOUND",
      status: 404,
    }));
    const listCampaigns = vi.fn()
      .mockResolvedValueOnce({ data: [campaign], meta: { total: 1, limit: 50, offset: 0 } })
      .mockResolvedValue({ data: [], meta: { total: 0, limit: 50, offset: 0 } });
    renderCampaigns({ deleteCampaign, getCampaign, listCampaigns });
    await connect(user);
    await screen.findByText(campaign.name);

    await user.click(screen.getByRole("button", { name: `More actions for ${campaign.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete campaign/ }));
    await user.click(screen.getByRole("button", { name: "Delete campaign" }));

    expect(await screen.findByText("Campaign deleted")).toBeInTheDocument();
    expect(getCampaign).toHaveBeenCalledWith(campaign.id);
    expect(screen.queryByText(campaign.name)).not.toBeInTheDocument();
  });

  it("removes a stale campaign when Runtime reports it missing", async () => {
    const user = userEvent.setup();
    const deleteCampaign = vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
      code: "CAMPAIGN_NOT_FOUND",
      status: 404,
    }));
    const listCampaigns = vi.fn()
      .mockResolvedValueOnce({ data: [campaign], meta: { total: 1, limit: 50, offset: 0 } })
      .mockResolvedValue({ data: [], meta: { total: 0, limit: 50, offset: 0 } });
    renderCampaigns({ deleteCampaign, listCampaigns });
    await connect(user);
    await screen.findByText(campaign.name);

    await user.click(screen.getByRole("button", { name: `More actions for ${campaign.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete campaign/ }));
    await user.click(screen.getByRole("button", { name: "Delete campaign" }));

    expect(await screen.findByText("This item no longer exists or is no longer available.")).toBeInTheDocument();
    expect(screen.queryByText(campaign.name)).not.toBeInTheDocument();
  });

  it("closes the Campaign workspace dialog after successful deletion", async () => {
    const user = userEvent.setup();
    const deleteCampaign = vi.fn().mockResolvedValue(undefined);
    const listCampaigns = vi.fn()
      .mockResolvedValueOnce({ data: [campaign], meta: { total: 1, limit: 50, offset: 0 } })
      .mockResolvedValue({ data: [], meta: { total: 0, limit: 50, offset: 0 } });
    renderCampaigns({ deleteCampaign, listCampaigns });
    await connect(user);
    await openCampaign(user);
    const workspace = screen.getByRole("dialog", { name: campaign.name });

    await user.click(within(workspace).getByRole("button", { name: `More actions for ${campaign.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete campaign/ }));
    await user.click(screen.getByRole("button", { name: "Delete campaign" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: campaign.name })).not.toBeInTheDocument());
    expect(deleteCampaign).toHaveBeenCalledWith(campaign.id, campaign.revision, campaign.targetsRevision);
  });
});
