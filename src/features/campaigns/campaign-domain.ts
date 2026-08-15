import type {
  RuntimeCampaign,
  RuntimeCampaignPreflight,
  RuntimeCreateCampaign,
  RuntimeRequestError,
  RuntimeUpdateCampaign,
} from "@/shared/api/runtime-client";

export type CampaignScheduleType = RuntimeCampaign["scheduleType"];

export interface CampaignFormValues {
  name: string;
  scheduleType: CampaignScheduleType;
  scheduledAt: string;
  text: string;
}

export interface CampaignFormErrors {
  name?: string;
  scheduledAt?: string;
  text?: string;
}

export function campaignFormFromDto(campaign: RuntimeCampaign): CampaignFormValues {
  return {
    name: campaign.name,
    scheduleType: campaign.scheduleType,
    scheduledAt: campaign.scheduledAt
      ? toDateTimeLocal(campaign.scheduledAt)
      : "",
    text: campaign.text,
  };
}

export function emptyCampaignForm(): CampaignFormValues {
  return { name: "", scheduleType: "IMMEDIATE", scheduledAt: "", text: "" };
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
  if (!values.text.trim()) errors.text = "Message text is required.";
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
    text: values.text.trim(),
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
  const text = values.text.trim();
  if (name !== campaign.name) input.name = name;
  if (text !== campaign.text) input.text = text;

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
