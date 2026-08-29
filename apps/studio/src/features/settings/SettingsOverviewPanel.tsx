import type { ReactNode } from "react";
import type { RuntimeOperationalHealth } from "@/shared/api/runtime-client";

import type { AppUpdateSnapshot } from "@/shared/native/app-updates";
import type {
  ManagedRuntimeDiagnostics,
  ManagedRuntimeSnapshot,
  ProtectionFreshness,
} from "@/shared/native/managed-runtime";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import type { SettingsTab } from "./settings-types";

interface SettingsOverviewPanelProps {
  diagnostics: ManagedRuntimeDiagnostics | null;
  error: string | null;
  loading: boolean;
  managedRuntime: ManagedRuntimeSnapshot;
  operationalHealth: RuntimeOperationalHealth | null;
  onNavigate: (tab: SettingsTab) => void;
  onRefresh: () => void;
  refreshing: boolean;
  updateState: AppUpdateSnapshot | null;
}

type OverviewTone = "danger" | "neutral" | "success" | "warning";

function storagePresentation(diagnostics: ManagedRuntimeDiagnostics | null): {
  description: string;
  label: string;
  tone: OverviewTone;
} {
  if (!diagnostics) return { description: "Storage capacity is being inspected.", label: "Inspecting", tone: "neutral" };
  const availableGiB = diagnostics.storage.filesystemAvailableBytes / 1_073_741_824;
  const description = `${availableGiB.toFixed(1)} GiB available (${diagnostics.storage.filesystemAvailablePercent}%).`;
  if (diagnostics.storage.pressure === "critical") {
    return { description, label: "Critical", tone: "danger" };
  }
  if (diagnostics.storage.pressure === "warning") {
    return { description, label: "Low space", tone: "warning" };
  }
  return { description, label: "Available", tone: "success" };
}

function runtimePresentation(
  phase: ManagedRuntimeSnapshot["phase"],
  health: RuntimeOperationalHealth | null,
): {
  badgeLabel: string;
  description: ReactNode;
  label: string;
  tone: OverviewTone;
} {
  if (phase === "ready") {
    if (health?.reason === "dependency_unavailable"
      || health?.reason === "background_process_degraded") {
      return {
        badgeLabel: "Degraded",
        description: "One or more local Runtime services need attention.",
        label: "WA Runtime needs attention",
        tone: "danger",
      };
    }
    if (health?.status === "degraded") {
      return {
        badgeLabel: "Ready locally",
        description: "Local services and data remain available while OpenWA operations are paused.",
        label: "Local Runtime is ready",
        tone: "warning",
      };
    }
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

function openwaPresentation(health: RuntimeOperationalHealth | null): {
  description: string;
  label: string;
  tone: OverviewTone;
} {
  const openwa = health?.components.openwa;
  if (openwa?.status === "COMPATIBLE") {
    return {
      description: `Connected to reviewed OpenWA ${openwa.observedRelease ?? openwa.expectedRelease}.`,
      label: "Connected",
      tone: "success",
    };
  }
  if (openwa?.status === "INCOMPATIBLE") {
    return {
      description: `Server ${openwa.observedRelease ?? "unknown"} does not match reviewed ${openwa.expectedRelease}; upstream operations are blocked.`,
      label: "Upgrade blocked",
      tone: "danger",
    };
  }
  if (openwa?.status === "UNAVAILABLE") {
    return {
      description: "OpenWA is unreachable; local data remains available and upstream operations are paused.",
      label: "Unreachable",
      tone: "warning",
    };
  }
  return {
    description: "WA Runtime is checking the configured OpenWA release.",
    label: "Checking",
    tone: "neutral",
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

export function SettingsOverviewPanel({
  diagnostics,
  error,
  loading,
  managedRuntime,
  operationalHealth,
  onNavigate,
  onRefresh,
  refreshing,
  updateState,
}: SettingsOverviewPanelProps) {
  const runtime = runtimePresentation(managedRuntime.phase, operationalHealth);
  const openwa = openwaPresentation(operationalHealth);
  const protection = freshnessPresentation(diagnostics?.recoveryFreshness);
  const storage = storagePresentation(diagnostics);
  const updatePending = updateState?.pending;
  const updateLabel = updatePending
    ? `v${updatePending.version}`
    : updateState?.enabled
      ? "Up to date"
      : updateState
        ? "Unavailable"
        : "Inspecting";

  return (
    <div className="settings-panel-stack">
      {error && <InlineAlert className="settings-notice" title="Status could not be refreshed">{error}</InlineAlert>}

      <SettingsSection
        action={(
          <Button
            disabled={refreshing || managedRuntime.phase === "restoring"}
            icon="refresh"
            loading={refreshing}
            onClick={onRefresh}
            size="sm"
          >
            Refresh status
          </Button>
        )}
        description="Desktop product information and the signed WA Studio release channel."
        kicker="WA Studio"
        title="Product overview"
        titleId="settings-product-overview-title"
      >
        <SettingsRow
          action={<Badge tone="success" variant="status">Available</Badge>}
          description="Product data and preferences are stored only in this local workspace."
          label="Local workspace"
        />
        <SettingsRow
          action={(
            <div className="settings-row-actions">
              <Badge tone={updatePending ? "warning" : updateState?.enabled ? "success" : "neutral"} variant="status">
                {updateLabel}
              </Badge>
              <Button onClick={() => onNavigate("updates")} size="sm" variant="ghost">View updates</Button>
            </div>
          )}
          description={updatePending
            ? `WA Studio ${updatePending.version} is ready to install.`
            : updateState?.enabled
              ? "WA Studio checks the signed release channel on demand."
              : updateState?.disabledReason ?? "Update status is being inspected."}
          label="Software updates"
        />
      </SettingsSection>

      <SettingsSection
        action={<Badge tone={runtime.tone} variant="status">{runtime.badgeLabel}</Badge>}
        description="Connection, data protection, and service health belong to the managed WA Runtime."
        kicker="WA Runtime"
        title={runtime.label}
        titleId="settings-runtime-status-title"
      >
        <SettingsRow
          action={(
            <div className="settings-row-actions">
              <Badge tone={openwa.tone} variant="status">{openwa.label}</Badge>
              <Button onClick={() => onNavigate("connection")} size="sm" variant="ghost">Manage connection</Button>
            </div>
          )}
          description={openwa.description}
          label="OpenWA connection"
        />
        <SettingsRow
          action={(
            <div className="settings-row-actions">
              <Badge tone={protection.tone} variant="status">{protection.label}</Badge>
              <Button onClick={() => onNavigate("recovery")} size="sm" variant="ghost">Manage backups</Button>
            </div>
          )}
          description={diagnostics?.latestRecoveryPointAtMs
            ? <>Latest recovery point: <DateTime value={new Date(diagnostics.latestRecoveryPointAtMs).toISOString()} /></>
            : "No local recovery point is available yet."}
          label="Data protection"
        />
        <SettingsRow
          action={<Badge tone={storage.tone} variant="status">{storage.label}</Badge>}
          description={storage.description}
          label="Local storage"
        />
      </SettingsSection>

      <SettingsSection
        description="Operational identifiers are retained for troubleshooting and support."
        kicker="Local workspace"
        title="Technical details"
        titleId="settings-technical-details-title"
      >
        <SettingsRow action={<span className="settings-row-value">{managedRuntime.manifest?.version ?? diagnostics?.runtimeVersion ?? "Unknown"}</span>} label="Runtime version" />
        <SettingsRow action={<span className="settings-row-value">{diagnostics?.processGeneration ?? "Not running"}</span>} label="Supervisor generation" />
        <SettingsRow action={<Badge tone={diagnostics?.managedPostgresRunning ? "success" : "neutral"} variant="status">{loading ? "Inspecting" : diagnostics?.managedPostgresRunning ? "Running" : "Stopped"}</Badge>} label="Managed PostgreSQL" />
        <SettingsRow action={<span className="settings-row-value">PostgreSQL</span>} label="Queue" />
        <SettingsRow action={<span className="settings-row-value">{managedRuntime.manifest?.openwaReleaseTag ? `${managedRuntime.manifest.openwaReleaseTag} reviewed` : "Unknown"}</span>} label="OpenWA release" />
        <SettingsRow action={<span className="settings-row-value">{diagnostics?.recoveryPointCount ?? 0}</span>} label="Recovery points" />
      </SettingsSection>
    </div>
  );
}
