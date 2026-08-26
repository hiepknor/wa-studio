import type { ReactNode } from "react";

import type { AppUpdateSnapshot } from "@/shared/native/app-updates";
import type {
  ManagedRuntimeDiagnostics,
  ManagedRuntimeSnapshot,
  ProtectionFreshness,
} from "@/shared/native/managed-runtime";
import { AppIcon, type AppIconName } from "@/shared/ui/AppIcon";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { SettingsSection } from "./SettingsSection";
import type { SettingsTab } from "./settings-types";

interface SettingsOverviewPanelProps {
  diagnostics: ManagedRuntimeDiagnostics | null;
  error: string | null;
  loading: boolean;
  managedRuntime: ManagedRuntimeSnapshot;
  onNavigate: (tab: SettingsTab) => void;
  updateState: AppUpdateSnapshot | null;
}

type OverviewTone = "danger" | "neutral" | "success" | "warning";

function runtimePresentation(phase: ManagedRuntimeSnapshot["phase"]): {
  badgeLabel: string;
  description: ReactNode;
  label: string;
  tone: OverviewTone;
} {
  if (phase === "ready") {
    return {
      badgeLabel: "Ready",
      description: "API, workers, scheduler, database, and queue are available on this device.",
      label: "WA Runtime is ready",
      tone: "success",
    };
  }
  if (phase === "degraded") {
    return {
      badgeLabel: "Degraded",
      description: "WA Runtime is available, but one or more managed services need attention.",
      label: "WA Runtime needs attention",
      tone: "warning",
    };
  }
  if (phase === "unavailable") {
    return {
      badgeLabel: "Unavailable",
      description: "The desktop supervisor cannot reach the local Runtime right now.",
      label: "WA Runtime is unavailable",
      tone: "danger",
    };
  }
  return {
    badgeLabel: "Starting",
    description: "The desktop supervisor is preparing the local Runtime services.",
    label: "WA Runtime is starting",
    tone: "warning",
  };
}

function freshnessPresentation(freshness: ProtectionFreshness | undefined): {
  label: string;
  tone: OverviewTone;
} {
  if (freshness === "fresh") return { label: "Protected", tone: "success" };
  if (freshness === "due") return { label: "Backup due", tone: "warning" };
  if (freshness === "missing") return { label: "Not protected", tone: "danger" };
  return { label: "Inspecting", tone: "neutral" };
}

interface SummaryCardProps {
  actionLabel: string;
  description: ReactNode;
  icon: AppIconName;
  onAction: () => void;
  status: string;
  title: string;
  tone: OverviewTone;
}

function SummaryCard({
  actionLabel,
  description,
  icon,
  onAction,
  status,
  title,
  tone,
}: SummaryCardProps) {
  return (
    <article className="settings-summary-card">
      <div className={`settings-summary-icon settings-summary-icon-${tone}`}>
        <AppIcon name={icon} size="lg" />
      </div>
      <div className="settings-summary-copy">
        <div className="settings-summary-title-row">
          <h4>{title}</h4>
          <Badge tone={tone} variant="status">{status}</Badge>
        </div>
        <p>{description}</p>
      </div>
      <Button onClick={onAction} size="sm" variant="ghost">{actionLabel}</Button>
    </article>
  );
}

export function SettingsOverviewPanel({
  diagnostics,
  error,
  loading,
  managedRuntime,
  onNavigate,
  updateState,
}: SettingsOverviewPanelProps) {
  const runtime = runtimePresentation(managedRuntime.phase);
  const protection = freshnessPresentation(diagnostics?.recoveryFreshness);
  const updatePending = updateState?.pending;

  return (
    <div className="settings-panel-stack">
      {error && <InlineAlert title="Status could not be refreshed">{error}</InlineAlert>}

      <section aria-labelledby="settings-runtime-status-title" className={`settings-status-hero settings-status-hero-${runtime.tone}`}>
        <div className="settings-status-hero-icon"><AppIcon name="server" size="lg" /></div>
        <div className="settings-status-hero-copy">
          <span className="settings-card-label">Managed locally</span>
          <h3 id="settings-runtime-status-title">{runtime.label}</h3>
          <p>{runtime.description}</p>
        </div>
        <Badge tone={runtime.tone} variant="status">{runtime.badgeLabel}</Badge>
      </section>

      <div className="settings-summary-grid">
        <SummaryCard
          actionLabel="Manage connection"
          description={managedRuntime.connection
            ? `Connected through ${managedRuntime.connection.baseUrl}`
            : "No active local Runtime connection is available."}
          icon="key"
          onAction={() => onNavigate("connection")}
          status={managedRuntime.connection ? "Connected" : "Disconnected"}
          title="OpenWA connection"
          tone={managedRuntime.connection ? "success" : "warning"}
        />
        <SummaryCard
          actionLabel="Manage backups"
          description={diagnostics?.latestRecoveryPointAtMs
            ? <>Latest recovery point: <DateTime value={new Date(diagnostics.latestRecoveryPointAtMs).toISOString()} /></>
            : "No local recovery point is available yet."}
          icon="sync"
          onAction={() => onNavigate("recovery")}
          status={protection.label}
          title="Data protection"
          tone={protection.tone}
        />
        <SummaryCard
          actionLabel="View updates"
          description={updatePending
            ? `WA Studio ${updatePending.version} is ready to install.`
            : updateState?.enabled
              ? "WA Studio checks the signed release channel on demand."
              : updateState?.disabledReason ?? "Update status is being inspected."}
          icon="activity"
          onAction={() => onNavigate("updates")}
          status={updatePending
            ? `v${updatePending.version}`
            : updateState?.enabled
              ? "Up to date"
              : updateState
                ? "Unavailable"
                : "Inspecting"}
          title="Software updates"
          tone={updatePending ? "warning" : updateState?.enabled ? "success" : "neutral"}
        />
      </div>

      <SettingsSection
        action={<Badge tone={diagnostics?.managedPostgresRunning ? "success" : "neutral"} variant={loading ? "label" : "status"}>{loading ? "Refreshing" : "Local only"}</Badge>}
        description="Operational details are kept here for troubleshooting and support."
        kicker="Technical details"
        title="Managed desktop stack"
        titleId="settings-technical-details-title"
      >
        <dl className="settings-detail-grid">
          <div><dt>Runtime version</dt><dd>{managedRuntime.manifest?.version ?? diagnostics?.runtimeVersion ?? "Unknown"}</dd></div>
          <div><dt>Supervisor generation</dt><dd>{diagnostics?.processGeneration ?? "Not running"}</dd></div>
          <div><dt>Managed PostgreSQL</dt><dd>{diagnostics?.managedPostgresRunning ? "Running" : "Stopped"}</dd></div>
          <div><dt>Queue</dt><dd>PostgreSQL</dd></div>
          <div><dt>OpenWA release</dt><dd>0.22.0 pinned</dd></div>
          <div><dt>Recovery points</dt><dd>{diagnostics?.recoveryPointCount ?? 0}</dd></div>
        </dl>
      </SettingsSection>
    </div>
  );
}
