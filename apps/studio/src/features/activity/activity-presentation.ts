import type {
  RuntimeActivityCategory,
  RuntimeActivityEvent,
  RuntimeActivitySeverity,
} from "@/shared/api/runtime-client";

const EVENT_TITLES: Record<string, string> = {
  "campaign_run.created": "Campaign run created",
  "campaign_run.scheduled": "Campaign run scheduled",
  "campaign_run.started": "Campaign run started",
  "campaign_run.blocked": "Campaign run blocked",
  "campaign_run.paused": "Campaign run paused",
  "campaign_run.resumed": "Campaign run resumed",
  "campaign_run.cancelled": "Campaign run cancelled",
  "campaign_run.completed": "Campaign run completed",
  "campaign_run.partial_failed": "Campaign run completed with failures",
  "campaign_run.failed": "Campaign run failed",
  "sync.requested": "Session sync requested",
  "sync.started": "Session sync started",
  "sync.retry_started": "Session sync retry started",
  "sync.completed": "Session sync completed",
  "sync.failed": "Session sync failed",
  "session.discovered": "Session discovered",
  "session.health_changed": "Session health changed",
};

export function activityTitle(event: RuntimeActivityEvent): string {
  return EVENT_TITLES[event.eventType]
    ?? event.eventType.split(/[._]/u).map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1)).join(" ");
}

export function activityCategoryLabel(category: RuntimeActivityCategory): string {
  if (category === "RUN") return "Runs";
  if (category === "SYNC") return "Sync";
  if (category === "SESSION") return "Sessions";
  return "Campaigns";
}

export function activitySeverityLabel(severity: RuntimeActivitySeverity): string {
  return severity.charAt(0) + severity.slice(1).toLocaleLowerCase();
}

export function activityTone(severity: RuntimeActivitySeverity) {
  if (severity === "SUCCESS") return "success" as const;
  if (severity === "WARNING") return "warning" as const;
  if (severity === "ERROR") return "danger" as const;
  return "info" as const;
}
