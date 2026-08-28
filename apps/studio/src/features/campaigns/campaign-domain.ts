import type {
  RuntimeCampaign,
  RuntimeCampaignPreflight,
  RuntimeCreateCampaign,
  RuntimeMediaAsset,
  RuntimeRequestError,
  RuntimeUpdateCampaign,
} from "@/shared/api/runtime-client";

export type CampaignScheduleType = RuntimeCampaign["scheduleType"];
export type CampaignContentType = RuntimeCampaign["content"]["type"];
export type CampaignMediaSelection = Pick<
  RuntimeMediaAsset,
  "byteSize" | "filename" | "id" | "kind" | "mimeType" | "sha256"
>;

export interface CampaignFormValues {
  contentType: CampaignContentType;
  mediaAsset: CampaignMediaSelection | null;
  name: string;
  scheduleType: CampaignScheduleType;
  scheduledAt: string;
  text: string;
}

export interface CampaignFormErrors {
  name?: string;
  scheduledAt?: string;
  mediaAsset?: string;
  text?: string;
}

function campaignDtoContent(campaign: RuntimeCampaign): RuntimeCampaign["content"] {
  return campaign.content ?? { type: "TEXT", text: campaign.text };
}

export function campaignFormFromDto(campaign: RuntimeCampaign): CampaignFormValues {
  const content = campaignDtoContent(campaign);
  return {
    contentType: content.type,
    mediaAsset: content.type === "TEXT" ? null : {
      id: content.mediaAssetId,
      kind: content.type,
      filename: content.filename,
      mimeType: content.mimeType,
      byteSize: content.byteSize,
      sha256: content.sha256,
    },
    name: campaign.name,
    scheduleType: campaign.scheduleType,
    scheduledAt: campaign.scheduledAt
      ? toDateTimeLocal(campaign.scheduledAt)
      : "",
    text: content.type === "TEXT" ? content.text : content.caption,
  };
}

export function emptyCampaignForm(): CampaignFormValues {
  return {
    contentType: "TEXT",
    mediaAsset: null,
    name: "",
    scheduleType: "IMMEDIATE",
    scheduledAt: "",
    text: "",
  };
}

export function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function toUtcTimestamp(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function validateCampaignForm(
  values: CampaignFormValues,
  now = new Date(),
): CampaignFormErrors {
  const errors: CampaignFormErrors = {};
  if (!values.name.trim()) errors.name = "Campaign name is required.";
  if (values.contentType === "TEXT") {
    if (!values.text.trim()) errors.text = "Message text is required.";
    else if (values.text.trim().length > 4_096) errors.text = "Message text cannot exceed 4,096 characters.";
  } else {
    if (!values.mediaAsset || values.mediaAsset.kind !== values.contentType) {
      errors.mediaAsset = "Choose and upload an image.";
    }
    if (values.text.trim().length > 1_024) errors.text = "Caption cannot exceed 1,024 characters.";
  }
  if (values.scheduleType === "ONCE") {
    const timestamp = toUtcTimestamp(values.scheduledAt);
    if (!values.scheduledAt) errors.scheduledAt = "Choose when this campaign should run.";
    else if (!timestamp) errors.scheduledAt = "Enter a valid date and time.";
    else if (new Date(timestamp).getTime() <= now.getTime()) {
      errors.scheduledAt = "Scheduled time must be in the future.";
    }
  }
  return errors;
}

export function createCampaignPayload(
  sessionId: string,
  values: CampaignFormValues,
): RuntimeCreateCampaign {
  const scheduledAt = values.scheduleType === "ONCE"
    ? toUtcTimestamp(values.scheduledAt) ?? undefined
    : undefined;
  return {
    sessionId,
    name: values.name.trim(),
    content: campaignContentInput(values),
    scheduleType: values.scheduleType,
    ...(scheduledAt ? { scheduledAt } : {}),
  };
}

export function updateCampaignPayload(
  campaign: RuntimeCampaign,
  values: CampaignFormValues,
): RuntimeUpdateCampaign {
  const input: RuntimeUpdateCampaign = {};
  const name = values.name.trim();
  if (name !== campaign.name) input.name = name;
  const content = campaignContentInput(values);
  const persistedContent = campaignDtoContent(campaign);
  const contentChanged = persistedContent.type !== content.type
    || (content.type === "TEXT"
      ? persistedContent.type !== "TEXT" || persistedContent.text !== content.text
      : persistedContent.type === "TEXT"
        || persistedContent.mediaAssetId !== content.mediaAssetId
        || persistedContent.caption !== content.caption);
  if (contentChanged) input.content = content;

  if (values.scheduleType !== campaign.scheduleType) {
    input.scheduleType = values.scheduleType;
    input.scheduledAt = values.scheduleType === "IMMEDIATE"
      ? null
      : toUtcTimestamp(values.scheduledAt);
  } else if (values.scheduleType === "ONCE") {
    const scheduledAt = toUtcTimestamp(values.scheduledAt);
    if (scheduledAt !== campaign.scheduledAt) input.scheduledAt = scheduledAt;
  }
  return input;
}

function campaignContentInput(
  values: CampaignFormValues,
): NonNullable<RuntimeCreateCampaign["content"]> {
  if (values.contentType === "TEXT") {
    return { type: "TEXT", text: values.text.trim() };
  }
  return {
    type: values.contentType,
    mediaAssetId: values.mediaAsset?.id ?? "",
    caption: values.text.trim(),
  };
}

export function hasCampaignChanges(
  campaign: RuntimeCampaign,
  values: CampaignFormValues,
): boolean {
  return Object.keys(updateCampaignPayload(campaign, values)).length > 0;
}

export type TargetSetValidation =
  | { ok: true; groupIds: string[] }
  | { code: "CAMPAIGN_TARGET_DUPLICATE" | "CAMPAIGN_TARGET_LIMIT_EXCEEDED"; ok: false };

export interface CampaignTargetDiff {
  addedIds: string[];
  removedIds: string[];
  savedCount: number;
  selectedCount: number;
}

export function campaignTargetDiff(
  savedIds: readonly string[],
  selectedIds: readonly string[],
): CampaignTargetDiff {
  const saved = new Set(savedIds);
  const selected = new Set(selectedIds);
  return {
    addedIds: selectedIds.filter((id) => !saved.has(id)),
    removedIds: savedIds.filter((id) => !selected.has(id)),
    savedCount: savedIds.length,
    selectedCount: selectedIds.length,
  };
}

export function validateTargetReplacement(groupIds: readonly string[]): TargetSetValidation {
  if (groupIds.length > 1_000) {
    return { code: "CAMPAIGN_TARGET_LIMIT_EXCEEDED", ok: false };
  }
  if (new Set(groupIds).size !== groupIds.length) {
    return { code: "CAMPAIGN_TARGET_DUPLICATE", ok: false };
  }
  return { groupIds: [...groupIds], ok: true };
}

export function isPreflightStale(
  report: RuntimeCampaignPreflight,
  campaign: Pick<RuntimeCampaign, "revision" | "targetsRevision">,
): boolean {
  return report.campaignRevision !== campaign.revision
    || report.targetsRevision !== campaign.targetsRevision;
}

const ERROR_COPY: Record<string, string> = {
  CAMPAIGN_IDEMPOTENCY_CONFLICT:
    "This create key was already used with different campaign details. Start a new campaign intent.",
  CAMPAIGN_CONTENT_INVALID: "Review the selected message type, attachment, and caption.",
  CAMPAIGN_FILTER_STATUS_INVALID: "One or more campaign status filters are invalid.",
  CAMPAIGN_FILTER_SCHEDULE_TYPE_INVALID: "One or more campaign schedule filters are invalid.",
  CAMPAIGN_QUERY_INVALID: "Campaign search must be 200 characters or fewer.",
  CAMPAIGN_NOT_EDITABLE: "Only DRAFT campaigns can be edited.",
  CAMPAIGN_NOT_FOUND: "This campaign no longer exists or is outside the active session.",
  CAMPAIGN_SCHEDULE_REQUIRED: "Choose when this campaign should run.",
  CAMPAIGN_SCHEDULE_INVALID: "Enter a valid date and time with a timezone.",
  CAMPAIGN_SCHEDULE_IN_PAST: "Scheduled time must be in the future.",
  CAMPAIGN_TARGET_DUPLICATE: "Each group can appear only once in the target set.",
  CAMPAIGN_TARGET_LIMIT_EXCEEDED: "A campaign can contain at most 1,000 unique groups.",
  CAMPAIGN_TARGET_NOT_FOUND: "One or more selected groups no longer exist.",
  CAMPAIGN_TARGET_SESSION_MISMATCH: "Every target must belong to the campaign session.",
  CAMPAIGN_TARGET_SOURCE_NOT_FOUND:
    "This group list is archived, unavailable, or outside your current scope. Choose another list.",
  CAMPAIGN_TARGET_SOURCE_SESSION_MISMATCH:
    "This group list belongs to a different campaign session and cannot be applied.",
  CAMPAIGN_TARGET_SOURCE_REVISION_CONFLICT:
    "The group list membership changed. Its latest revision was reloaded; review it before applying again.",
  CAMPAIGN_TARGETS_REVISION_CONFLICT:
    "Campaign targets changed in Runtime. The canonical target snapshot is being reloaded.",
  CAMPAIGN_RUN_LAUNCH_CONFLICT:
    "This campaign is no longer launchable or already has a LIVE run. Campaign and run state are being reloaded.",
  CAMPAIGN_RUN_REVISION_REQUIRED:
    "Runtime requires explicit campaign and target revisions for LIVE. Run preflight again.",
  CAMPAIGN_RUN_REVISION_CONFLICT:
    "Campaign content or targets changed after review. The campaign is being reloaded; run preflight again.",
  CAMPAIGN_RUN_PREFLIGHT_REQUIRED:
    "Run a passing LIVE preflight before launching this campaign.",
  CAMPAIGN_RUN_PREFLIGHT_INVALID:
    "The LIVE preflight proof expired or no longer matches this campaign. Run preflight again.",
  CAMPAIGN_RUN_SCHEDULE_EXPIRED:
    "This one-time schedule has expired. Return to a DRAFT editor to revise it, or create a new campaign.",
  CAMPAIGN_RUN_STATE_CONFLICT:
    "The run changed state in Runtime. Its authoritative state is being reloaded.",
  GROUP_LIST_REVISION_CONFLICT:
    "This group list changed in Runtime. Reload and review its latest revision.",
  GROUP_LIST_ARCHIVED:
    "This group list is archived and can no longer be applied.",
  MEDIA_STORAGE_QUOTA_EXCEEDED:
    "Campaign media storage is full. Remove unused campaign media or increase the Runtime storage limit.",
  MEDIA_UPLOAD_CHUNK_CONFLICT:
    "An upload chunk no longer matches this file. Choose the file again to start a clean upload.",
  MEDIA_DIGEST_MISMATCH:
    "The uploaded file did not pass its integrity check. Choose the file again.",
  MEDIA_UPLOAD_EXPIRED: "This upload expired. Choose the file again to restart it.",
  MEDIA_SIGNATURE_MISMATCH:
    "The file contents do not match the selected image format.",
};

export function campaignErrorMessage(error: unknown, fallback: string): string {
  const requestError = error as Partial<RuntimeRequestError>;
  if (typeof requestError.code === "string" && ERROR_COPY[requestError.code]) {
    return ERROR_COPY[requestError.code];
  }
  return error instanceof Error ? error.message : fallback;
}

export function scheduleFieldError(error: unknown): string | undefined {
  const requestError = error as Partial<RuntimeRequestError>;
  if (requestError.code?.startsWith("CAMPAIGN_SCHEDULE_")) {
    return ERROR_COPY[requestError.code] ?? "Review the scheduled date and time.";
  }
  return requestError.fieldErrors?.scheduledAt?.[0];
}
