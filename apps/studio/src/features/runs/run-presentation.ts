import type {
  RuntimeCampaignDeliveryStatus,
  RuntimeCampaignRun,
  RuntimeCampaignRunStatus,
  RuntimeCampaignRunSummary,
} from "@/shared/api/runtime-client";
import type { FeedbackTone } from "@/shared/ui/feedback-tone";

export const RUN_TERMINAL_STATUSES = new Set<RuntimeCampaignRunStatus>([
  "COMPLETED",
  "PARTIAL_FAILED",
  "CANCELLED",
  "FAILED",
]);

export const RUN_ACTIVE_STATUSES: RuntimeCampaignRunStatus[] = [
  "PREPARING",
  "SCHEDULED",
  "RUNNING",
  "PAUSED",
];

export const RUN_ATTENTION_STATUSES: RuntimeCampaignRunStatus[] = [
  "BLOCKED",
  "PARTIAL_FAILED",
  "FAILED",
];

export function runStatusLabel(status: string): string {
  return status.split("_").map((part) =>
    part.charAt(0) + part.slice(1).toLocaleLowerCase()
  ).join(" ");
}

export function runTone(status: RuntimeCampaignRunStatus) {
  if (status === "COMPLETED" || status === "RUNNING") return "success" as const;
  if (status === "SCHEDULED" || status === "PAUSED" || status === "PREPARING") {
    return "warning" as const;
  }
  if (status === "BLOCKED" || status === "PARTIAL_FAILED" || status === "FAILED") {
    return "danger" as const;
  }
  return "neutral" as const;
}

export function deliveryTone(status: RuntimeCampaignDeliveryStatus): FeedbackTone {
  if (status === "FAILED" || status === "UNKNOWN" || status === "BLOCKED_CAPABILITY_CHANGED") {
    return "danger";
  }
  if (status === "PENDING" || status === "MATERIALIZED" || status === "PROCESSING") {
    return "info";
  }
  if (status === "CANCELLED") return "neutral";
  return "success";
}

export function resolvedTargets(
  run: RuntimeCampaignRun | RuntimeCampaignRunSummary,
): number {
  const progress = run.progress;
  return progress.dryRunCompleted
    + progress.accepted
    + progress.sent
    + progress.delivered
    + progress.read
    + progress.failed
    + progress.unknown
    + progress.blocked
    + progress.cancelled;
}

export function shortId(value: string): string {
  return value.slice(0, 8);
}
