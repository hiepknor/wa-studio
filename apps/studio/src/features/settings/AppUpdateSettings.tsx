import { useEffect, useState } from "react";

import type { AppUpdateProgress, AppUpdateSnapshot } from "@/shared/native/app-updates";
import { useSingleFlightOperation } from "@/shared/hooks/useSingleFlightOperation";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { useToast } from "@/shared/ui/Toast";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import type { SettingsTaskNavigationState } from "./settings-types";

interface AppUpdateSettingsProps {
  checkUpdate: () => Promise<AppUpdateSnapshot>;
  error: string | null;
  installUpdate: (acknowledgeRuntimeInterruption: boolean) => Promise<void>;
  onNavigationStateChange?: (state: SettingsTaskNavigationState) => void;
  progress: AppUpdateProgress | null;
  runtimeReady: boolean;
  updateState: AppUpdateSnapshot | null;
}

function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function progressLabel(progress: AppUpdateProgress): string {
  if (progress.phase === "downloading" && progress.totalBytes) {
    return `Downloading ${bytes(progress.downloadedBytes ?? 0)} of ${bytes(progress.totalBytes)}…`;
  }
  if (progress.phase === "backingUp") return "Creating a pre-update backup…";
  if (progress.phase === "downloaded") return "Download verified. Preparing installation…";
  if (progress.phase === "installing") return "Installing the signed update…";
  return "Restarting WA Studio…";
}

export function AppUpdateSettings({
  checkUpdate,
  error: loadError,
  installUpdate,
  onNavigationStateChange,
  progress,
  runtimeReady,
  updateState,
}: AppUpdateSettingsProps) {
  const { notify } = useToast();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const operation = useSingleFlightOperation();

  useEffect(() => {
    onNavigationStateChange?.({ busy: installing, dirty: installing });
    return () => onNavigationStateChange?.({ busy: false, dirty: false });
  }, [installing, onNavigationStateChange]);

  async function checkForUpdate() {
    const token = operation.begin();
    if (token === null) return;
    setChecking(true);
    setOperationError(null);
    try {
      const next = await checkUpdate();
      if (!operation.isCurrent(token)) return;
      if (!next.pending) {
        notify({
          description: `Version ${next.currentVersion} is the latest signed release.`,
          title: "WA Studio is up to date",
          tone: "success",
        });
      }
    } catch (caught) {
      if (operation.isCurrent(token)) {
        setOperationError(userFacingErrorMessage(caught, "Could not check for app updates."));
      }
    } finally {
      if (operation.complete(token)) setChecking(false);
    }
  }

  async function confirmUpdate() {
    if (!pending || !runtimeReady) return;
    const token = operation.begin();
    if (token === null) return;
    setInstalling(true);
    setOperationError(null);
    try {
      await installUpdate(true);
      if (!operation.isCurrent(token)) return;
      setConfirming(false);
      notify({
        description: "Restart WA Studio to start using the new version.",
        title: "Signed update installed",
        tone: "success",
      });
    } catch (caught) {
      if (operation.isCurrent(token)) {
        setOperationError(userFacingErrorMessage(caught, "Could not install the app update."));
      }
    } finally {
      if (operation.complete(token)) setInstalling(false);
    }
  }

  const pending = updateState?.pending;
  const enabled = updateState?.enabled ?? false;
  const statusDescription = pending
    ? "Review the release notes, then install when local work can pause briefly."
    : !updateState
      ? "WA Studio is checking whether signed desktop releases are available."
      : enabled
        ? "Updates are downloaded from the embedded HTTPS channel and verified before installation."
        : updateState.disabledReason ?? "This build is not connected to a signed release channel.";

  return (
    <div className="settings-panel-stack">
      {(loadError || (!confirming && operationError)) && (
        <InlineAlert className="settings-notice" title="Update operation failed">{operationError ?? loadError}</InlineAlert>
      )}

      <SettingsSection
        action={(
          <Button
            disabled={!enabled || checking || installing || confirming}
            icon="refresh"
            loading={checking}
            onClick={() => void checkForUpdate()}
            size="sm"
          >
            Check for updates
          </Button>
        )}
        description="WA Studio updates the desktop app and its managed WA Runtime together."
        kicker="WA Studio"
        title="Updates"
        titleId="settings-update-details-title"
      >
        <div className="settings-update-layout">
          <SettingsRow
            action={<Badge tone={enabled ? pending ? "warning" : "success" : "neutral"} variant="status">
              {enabled ? pending ? "Update available" : "Channel ready" : "Disabled"}
            </Badge>}
            description={statusDescription}
            label="Signed release channel"
          />
          <SettingsRow action={<span className="settings-row-value">{updateState?.currentVersion ?? "Inspecting…"}</span>} label="WA Studio" />
          <SettingsRow
            action={<Badge tone={runtimeReady ? "success" : "warning"} variant="status">{runtimeReady ? "Ready" : "Unavailable"}</Badge>}
            description="The managed Runtime release is bundled and installed with WA Studio."
            label="WA Runtime"
          />
          <SettingsRow action={<span className="settings-row-value">{pending?.version ?? "None"}</span>} label="Available version" />
          <SettingsRow action={<span className="settings-row-value">{pending?.date ?? "—"}</span>} label="Release date" />
          <SettingsRow action={<Badge tone={enabled ? "info" : "neutral"}>{enabled ? "Signed HTTPS" : "Unavailable"}</Badge>} label="Channel" />

          {updateState?.disabledReason && (
            <InlineAlert className="settings-update-notice" title="Updates are unavailable" tone="neutral">
              {updateState.disabledReason}
            </InlineAlert>
          )}

          {pending && (
            <div className="settings-release-notes">
              <span>What’s new</span>
              <p>{pending.notes ?? "This signed release has no release notes."}</p>
            </div>
          )}

          {progress && installing && (
            <InlineAlert className="settings-update-notice" indicator title="Update in progress" tone="warning">
              {progressLabel(progress)}
            </InlineAlert>
          )}

          {pending && (
            <SettingsRow
              action={(
                <Button
                  disabled={!runtimeReady || checking || installing}
                  onClick={() => { setOperationError(null); setConfirming(true); }}
                  variant="primary"
                >
                  Install update
                </Button>
              )}
              description={!runtimeReady
                ? "WA Runtime must be ready before installing."
                : "Installation pauses local Runtime work, creates a backup, and restarts WA Studio."}
              label="Install behavior"
            />
          )}
        </div>
      </SettingsSection>

      <ConfirmationDialog
        body={pending ? (
          <>
            WA Studio will verify version <strong>{pending.version}</strong>, pause active local
            campaigns and Runtime processes, create a fresh backup, install, then restart.
            OpenWA is unchanged.
          </>
        ) : "Check for an update before installing."}
        busy={installing}
        busyLabel="Installing…"
        confirmLabel="Pause Runtime and install"
        error={operationError}
        errorTitle="Update installation failed"
        onCancel={() => { if (!installing) setConfirming(false); }}
        onConfirm={() => void confirmUpdate()}
        open={confirming}
        title="Install signed WA Studio update?"
      />
    </div>
  );
}
