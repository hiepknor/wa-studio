import { useCallback, useEffect, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import {
  checkForAppUpdate,
  getAppUpdateState,
  installAppUpdate,
  subscribeAppUpdateProgress,
  type AppUpdateProgress,
  type AppUpdateSnapshot,
} from "@/shared/native/app-updates";
import {
  getManagedRuntimeProvisioningProfile,
  listManagedRuntimeBackups,
  reconfigureManagedRuntime,
  restoreManagedRuntimeBackup,
  type ManagedRuntimeBackup,
} from "@/shared/native/managed-runtime";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ManagedRuntimeConfigurationPanel } from "./ManagedRuntimeConfigurationPanel";
import "./settings.css";

interface SettingsScreenProps {
  checkUpdate?: typeof checkForAppUpdate;
  getUpdateState?: typeof getAppUpdateState;
  installUpdate?: typeof installAppUpdate;
  getProvisioningProfile?: typeof getManagedRuntimeProvisioningProfile;
  listBackups?: typeof listManagedRuntimeBackups;
  restoreBackup?: typeof restoreManagedRuntimeBackup;
  saveProvisioningProfile?: typeof reconfigureManagedRuntime;
  subscribeUpdateProgress?: typeof subscribeAppUpdateProgress;
}

function backupKind(kind: ManagedRuntimeBackup["kind"]): string {
  if (kind === "pre-migration") return "Before migration";
  if (kind === "pre-update") return "Before app update";
  return "Before restore";
}

function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

export function SettingsScreen({
  checkUpdate = checkForAppUpdate,
  getUpdateState = getAppUpdateState,
  installUpdate = installAppUpdate,
  getProvisioningProfile = getManagedRuntimeProvisioningProfile,
  listBackups = listManagedRuntimeBackups,
  restoreBackup = restoreManagedRuntimeBackup,
  saveProvisioningProfile = reconfigureManagedRuntime,
  subscribeUpdateProgress = subscribeAppUpdateProgress,
}: SettingsScreenProps = {}) {
  const { managedRuntime } = useRuntimeConnection();
  const [backups, setBackups] = useState<ManagedRuntimeBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ManagedRuntimeBackup | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [updateState, setUpdateState] = useState<AppUpdateSnapshot | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBackups(await listBackups());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not list local backups.");
    } finally {
      setLoading(false);
    }
  }, [listBackups]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void getUpdateState()
      .then(setUpdateState)
      .catch(caught => setError(
        caught instanceof Error ? caught.message : "Could not inspect app updates.",
      ));
  }, [getUpdateState]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeUpdateProgress(setUpdateProgress).then(listener => {
      if (disposed) listener();
      else unlisten = listener;
    }).catch(caught => {
      if (!disposed) {
        setError(caught instanceof Error ? caught.message : "Could not watch app update progress.");
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [subscribeUpdateProgress]);

  async function confirmRestore() {
    if (!selected) return;
    setRestoring(true);
    setError(null);
    setNotice(null);
    try {
      await restoreBackup(selected.id);
      setNotice("Backup restored. WA Studio is restarting the local Runtime.");
      setSelected(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restore the backup.");
    } finally {
      setRestoring(false);
    }
  }

  async function checkForUpdate() {
    setCheckingUpdate(true);
    setError(null);
    setNotice(null);
    try {
      const next = await checkUpdate();
      setUpdateState(next);
      if (!next.pending) setNotice("WA Studio is up to date.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not check for app updates.");
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function confirmUpdate() {
    setInstallingUpdate(true);
    setError(null);
    setNotice(null);
    try {
      await installUpdate(true);
      setNotice("The signed update was installed. Restart WA Studio to use it.");
      setConfirmingUpdate(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not install the app update.");
    } finally {
      setInstallingUpdate(false);
    }
  }

  const runtimeReady = managedRuntime.phase === "ready";

  return (
    <div className="settings-screen stack stack-lg">
      <PageHeader
        actions={(
          <Button disabled={loading || restoring} icon="refresh" onClick={() => void reload()}>
            {loading ? "Loading…" : "Reload backups"}
          </Button>
        )}
        description="Inspect the managed desktop stack and recover its local PostgreSQL data."
        title="Settings"
        titleId="settings-title"
      />

      <section aria-labelledby="runtime-settings-title" className="settings-runtime-card">
        <div>
          <span className="settings-card-label">Managed Runtime</span>
          <h3 id="runtime-settings-title">Local service profile</h3>
          <p>Runtime API, worker, scheduler, PostgreSQL, and queue stay on this device.</p>
        </div>
        <dl>
          <div><dt>State</dt><dd><Badge tone={runtimeReady ? "success" : "warning"}>{managedRuntime.phase}</Badge></dd></div>
          <div><dt>Runtime</dt><dd>{managedRuntime.manifest?.version ?? "Unknown"}</dd></div>
          <div><dt>Queue</dt><dd>PostgreSQL</dd></div>
          <div><dt>OpenWA</dt><dd>0.22.0 pinned</dd></div>
        </dl>
      </section>

      {managedRuntime.phase === "restoring" && (
        <InlineAlert indicator title="Restore in progress" tone="warning">
          Runtime processes are stopped while PostgreSQL applies the encrypted archive.
        </InlineAlert>
      )}
      {error && <InlineAlert title="Settings operation failed">{error}</InlineAlert>}
      {notice && <InlineAlert title="Settings operation completed" tone="success">{notice}</InlineAlert>}

      <ManagedRuntimeConfigurationPanel
        getProfile={getProvisioningProfile}
        phase={managedRuntime.phase}
        saveProfile={saveProvisioningProfile}
      />

      <section aria-labelledby="update-settings-title" className="settings-update-card">
        <header className="settings-backup-header">
          <div>
            <span className="settings-card-label">Software updates</span>
            <h3 id="update-settings-title">Signed WA Studio releases</h3>
            <p>Artifacts are accepted only from the embedded HTTPS channel and verified signing key.</p>
          </div>
          <Badge tone={updateState?.enabled ? "success" : "neutral"}>
            {updateState?.enabled ? "Signed channel" : "Disabled"}
          </Badge>
        </header>
        <div className="settings-update-body stack stack-md">
          <dl>
            <div><dt>Installed version</dt><dd>{updateState?.currentVersion ?? "Inspecting…"}</dd></div>
            <div><dt>Available version</dt><dd>{updateState?.pending?.version ?? "None"}</dd></div>
          </dl>
          {updateState?.disabledReason && (
            <InlineAlert title="Updates unavailable" tone="neutral">
              {updateState.disabledReason}
            </InlineAlert>
          )}
          {updateState?.pending && (
            <InlineAlert title={`WA Studio ${updateState.pending.version} is available`} tone="success">
              {updateState.pending.notes ?? "This signed release has no release notes."}
            </InlineAlert>
          )}
          {updateProgress && installingUpdate && (
            <InlineAlert indicator title="Update in progress" tone="warning">
              {updateProgress.phase === "downloading" && updateProgress.totalBytes
                ? `Downloading ${bytes(updateProgress.downloadedBytes ?? 0)} of ${bytes(updateProgress.totalBytes)}…`
                : `${updateProgress.phase}…`}
            </InlineAlert>
          )}
          <div className="settings-update-actions">
            <Button
              disabled={!updateState?.enabled || checkingUpdate || installingUpdate}
              loading={checkingUpdate}
              onClick={() => void checkForUpdate()}
            >
              {checkingUpdate ? "Checking…" : "Check for updates"}
            </Button>
            {updateState?.pending && (
              <Button
                disabled={!runtimeReady || installingUpdate}
                onClick={() => setConfirmingUpdate(true)}
                variant="primary"
              >
                Install update
              </Button>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="backup-list-title" className="data-table-container settings-backup-panel">
        <header className="settings-backup-header">
          <div>
            <h3 id="backup-list-title">Encrypted database backups</h3>
            <p>WA Studio verifies every archive with bundled pg_restore before committing it.</p>
          </div>
          <Badge tone="neutral">{backups.length} retained</Badge>
        </header>
        <div className="data-table-scroll">
          <table>
            <caption>Managed PostgreSQL backups</caption>
            <thead><tr><th scope="col">Created</th><th scope="col">Safety point</th><th scope="col">Size</th><th className="align-end" scope="col">Action</th></tr></thead>
            <tbody>
              {loading ? (
                <tr><td className="data-table-empty" colSpan={4}>Loading encrypted backups…</td></tr>
              ) : backups.length === 0 ? (
                <tr><td className="data-table-empty" colSpan={4}>No managed backups are available yet.</td></tr>
              ) : backups.map(backup => (
                <tr key={backup.id}>
                  <td className="data-cell-time"><DateTime value={new Date(backup.createdAtMs).toISOString()} /></td>
                  <td className="data-cell-primary"><strong>{backupKind(backup.kind)}</strong><span className="data-secondary-text">{backup.id}</span></td>
                  <td>{bytes(backup.sizeBytes)}</td>
                  <td className="data-cell-action">
                    <Button
                      disabled={!runtimeReady || restoring}
                      onClick={() => setSelected(backup)}
                      size="sm"
                      variant="danger"
                    >
                      Restore
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ConfirmationDialog
        body={selected ? (
          <>
            WA Studio will stop local Runtime processes, create a new encrypted safety backup,
            then restore <strong>{selected.id}</strong> in one PostgreSQL transaction. OpenWA is
            not changed.
          </>
        ) : "Select a backup to restore."}
        busy={restoring}
        busyLabel="Restoring…"
        confirmLabel="Restore backup"
        confirmVariant="danger"
        onCancel={() => { if (!restoring) setSelected(null); }}
        onConfirm={() => void confirmRestore()}
        open={selected !== null}
        title="Restore local Runtime data?"
      />
      <ConfirmationDialog
        body={updateState?.pending ? (
          <>
            WA Studio will download and verify version <strong>{updateState.pending.version}</strong>,
            pause active local campaigns and Runtime processes, create a fresh encrypted
            <strong> pre-update backup</strong>, stop PostgreSQL, install, then restart. OpenWA is
            not changed.
          </>
        ) : "Check for an update before installing."}
        busy={installingUpdate}
        busyLabel="Installing…"
        confirmLabel="Pause Runtime and install"
        onCancel={() => { if (!installingUpdate) setConfirmingUpdate(false); }}
        onConfirm={() => void confirmUpdate()}
        open={confirmingUpdate}
        title="Install signed WA Studio update?"
      />
    </div>
  );
}
