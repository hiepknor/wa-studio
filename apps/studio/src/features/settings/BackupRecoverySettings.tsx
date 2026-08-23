import { useState } from "react";

import type {
  ManagedRuntimeBackup,
  ManagedRuntimeDiagnostics,
  ProtectionFreshness,
} from "@/shared/native/managed-runtime";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { TextField } from "@/shared/ui/TextField";
import { useToast } from "@/shared/ui/Toast";
import { SettingsSection } from "./SettingsSection";

interface BackupRecoverySettingsProps {
  backups: ManagedRuntimeBackup[];
  createBackup: () => Promise<void>;
  diagnostics: ManagedRuntimeDiagnostics | null;
  exportRecoveryArchive: (passphrase: string) => Promise<string | null>;
  loading: boolean;
  onReload: () => Promise<void>;
  restoreBackup: (backupId: string) => Promise<void>;
  restoreRecoveryArchive: (passphrase: string) => Promise<boolean>;
  runtimeReady: boolean;
}

type RecoveryFlow = "export" | "import" | null;
type ProtectionTone = "danger" | "neutral" | "success" | "warning";

function backupKind(kind: ManagedRuntimeBackup["kind"]): string {
  if (kind === "automatic") return "Rolling daily backup";
  if (kind === "manual") return "Manual recovery point";
  if (kind === "pre-migration") return "Before migration";
  if (kind === "pre-update") return "Before app update";
  return "Before restore";
}

function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function protectionPresentation(freshness: ProtectionFreshness | undefined): {
  label: string;
  tone: ProtectionTone;
} {
  if (freshness === "fresh") return { label: "Protected", tone: "success" };
  if (freshness === "due") return { label: "Backup due", tone: "warning" };
  if (freshness === "missing") return { label: "Not protected", tone: "danger" };
  return { label: "Inspecting", tone: "neutral" };
}

export function BackupRecoverySettings({
  backups,
  createBackup,
  diagnostics,
  exportRecoveryArchive,
  loading,
  onReload,
  restoreBackup,
  restoreRecoveryArchive,
  runtimeReady,
}: BackupRecoverySettingsProps) {
  const { notify } = useToast();
  const [selectedBackup, setSelectedBackup] = useState<ManagedRuntimeBackup | null>(null);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [recoveryFlow, setRecoveryFlow] = useState<RecoveryFlow>(null);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportConfirmation, setExportConfirmation] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [exportingArchive, setExportingArchive] = useState(false);
  const [importingArchive, setImportingArchive] = useState(false);
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const protection = protectionPresentation(diagnostics?.recoveryFreshness);

  function closeRecoveryFlow() {
    if (exportingArchive || importingArchive) return;
    setRecoveryFlow(null);
    setPassphraseError(null);
    setExportPassphrase("");
    setExportConfirmation("");
    setImportPassphrase("");
  }

  async function createManualBackup() {
    setCreatingBackup(true);
    setError(null);
    try {
      await createBackup();
      await onReload();
      notify({
        description: "The encrypted recovery point was verified and saved on this device.",
        title: "Backup created",
        tone: "success",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a manual backup.");
    } finally {
      setCreatingBackup(false);
    }
  }

  async function confirmRestoreBackup() {
    if (!selectedBackup) return;
    setRestoringBackup(true);
    setError(null);
    try {
      await restoreBackup(selectedBackup.id);
      setSelectedBackup(null);
      await onReload();
      notify({
        description: "WA Runtime is restarting with the selected local data.",
        title: "Backup restored",
        tone: "success",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restore the backup.");
    } finally {
      setRestoringBackup(false);
    }
  }

  async function exportArchive() {
    if (exportPassphrase.length < 16) {
      setPassphraseError("Use at least 16 characters.");
      return;
    }
    if (exportPassphrase !== exportConfirmation) {
      setPassphraseError("Passphrases do not match.");
      return;
    }
    setExportingArchive(true);
    setError(null);
    setPassphraseError(null);
    try {
      const name = await exportRecoveryArchive(exportPassphrase);
      if (name) {
        notify({
          description: `${name} was encrypted and verified.`,
          title: "Recovery archive exported",
          tone: "success",
        });
        setRecoveryFlow(null);
        setExportPassphrase("");
        setExportConfirmation("");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export a recovery archive.");
    } finally {
      setExportingArchive(false);
    }
  }

  async function confirmImportArchive() {
    setImportingArchive(true);
    setError(null);
    try {
      const restored = await restoreRecoveryArchive(importPassphrase);
      setConfirmingImport(false);
      if (restored) {
        setRecoveryFlow(null);
        setImportPassphrase("");
        await onReload();
        notify({
          description: "WA Runtime is restarting with the imported data.",
          title: "Recovery archive restored",
          tone: "success",
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restore the recovery archive.");
    } finally {
      setImportingArchive(false);
    }
  }

  return (
    <div className="settings-panel-stack">
      {error && <InlineAlert title="Recovery operation failed">{error}</InlineAlert>}

      <SettingsSection
        action={<Badge tone={protection.tone}>{protection.label}</Badge>}
        description="WA Studio verifies backup freshness and database integrity on this device."
        kicker="Protection status"
        title="Your local data"
        titleId="settings-protection-title"
      >
        <dl className="settings-detail-grid settings-protection-grid">
          <div>
            <dt>Latest recovery point</dt>
            <dd>{diagnostics?.latestRecoveryPointAtMs
              ? <DateTime value={new Date(diagnostics.latestRecoveryPointAtMs).toISOString()} />
              : "Never"}</dd>
          </div>
          <div><dt>Recovery points</dt><dd>{diagnostics?.recoveryPointCount ?? 0}</dd></div>
          <div>
            <dt>Integrity</dt>
            <dd><Badge tone={protectionPresentation(diagnostics?.integrityFreshness).tone}>
              {protectionPresentation(diagnostics?.integrityFreshness).label}
            </Badge></dd>
          </div>
          <div>
            <dt>Last verified</dt>
            <dd>{diagnostics?.lastIntegrityCheckAtMs
              ? <DateTime value={new Date(diagnostics.lastIntegrityCheckAtMs).toISOString()} />
              : "Never"}</dd>
          </div>
        </dl>
      </SettingsSection>

      <SettingsSection
        action={(
          <div className="settings-section-actions">
            <Badge tone="neutral">{backups.length} retained</Badge>
            <Button
              disabled={!runtimeReady || creatingBackup || restoringBackup}
              icon="refresh"
              loading={creatingBackup}
              onClick={() => void createManualBackup()}
              size="sm"
            >
              Create backup
            </Button>
          </div>
        )}
        className="settings-backup-section"
        description="Rolling backups are created at most once every 24 hours. You can add a manual recovery point before important work."
        title="On-device backups"
        titleId="settings-backup-list-title"
      >
        <div className="data-table-scroll settings-backup-table">
          <table>
            <caption>Managed PostgreSQL backups</caption>
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Recovery point</th>
                <th scope="col">Size</th>
                <th className="align-end" scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="data-table-empty" colSpan={4}>Loading backups…</td></tr>
              ) : backups.length === 0 ? (
                <tr><td className="data-table-empty" colSpan={4}>No backups are available yet.</td></tr>
              ) : backups.map(backup => (
                <tr key={backup.id}>
                  <td className="data-cell-time"><DateTime value={new Date(backup.createdAtMs).toISOString()} /></td>
                  <td className="data-cell-primary">
                    <strong>{backupKind(backup.kind)}</strong>
                    <span className="data-secondary-text">{backup.id}</span>
                  </td>
                  <td>{bytes(backup.sizeBytes)}</td>
                  <td className="data-cell-action">
                    <Button
                      disabled={!runtimeReady || restoringBackup}
                      onClick={() => setSelectedBackup(backup)}
                      size="sm"
                      variant="ghost"
                    >
                      Restore
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>

      <SettingsSection
        action={recoveryFlow === null ? <Badge tone="warning">Passphrase required</Badge> : undefined}
        description="Move Runtime data to another device or keep an encrypted copy away from this computer."
        kicker="Off-device recovery"
        title="Portable recovery archive"
        titleId="settings-portable-recovery-title"
      >
        {recoveryFlow === null ? (
          <div className="settings-recovery-choice-grid">
            <button
              className="settings-choice-card"
              disabled={!runtimeReady}
              onClick={() => setRecoveryFlow("export")}
              type="button"
            >
              <span className="settings-choice-card-title">Export archive</span>
              <span>Encrypt a portable copy with a new passphrase.</span>
            </button>
            <button
              className="settings-choice-card"
              disabled={!runtimeReady}
              onClick={() => setRecoveryFlow("import")}
              type="button"
            >
              <span className="settings-choice-card-title">Import archive</span>
              <span>Replace local Runtime data from a portable archive.</span>
            </button>
          </div>
        ) : recoveryFlow === "export" ? (
          <div className="settings-recovery-flow stack stack-md">
            <div className="settings-recovery-flow-heading">
              <div><h4>Export a protected archive</h4><p>Create a passphrase you can store separately from this device.</p></div>
              <Button disabled={exportingArchive} onClick={closeRecoveryFlow} size="sm" variant="ghost">Cancel</Button>
            </div>
            <div className="settings-field-grid">
              <TextField
                autoComplete="new-password"
                autoFocus
                disabled={exportingArchive}
                error={passphraseError ?? undefined}
                id="recovery-export-passphrase"
                label="New recovery passphrase"
                minLength={16}
                onChange={event => { setExportPassphrase(event.currentTarget.value); setPassphraseError(null); }}
                type="password"
                value={exportPassphrase}
              />
              <TextField
                autoComplete="new-password"
                disabled={exportingArchive}
                id="recovery-export-confirmation"
                label="Confirm passphrase"
                minLength={16}
                onChange={event => { setExportConfirmation(event.currentTarget.value); setPassphraseError(null); }}
                type="password"
                value={exportConfirmation}
              />
            </div>
            <InlineAlert title="Keep this passphrase somewhere safe" tone="neutral">
              WA Studio support cannot recover the archive without it.
            </InlineAlert>
            <div className="settings-form-actions">
              <Button
                disabled={exportPassphrase.length < 16 || exportConfirmation.length < 16}
                loading={exportingArchive}
                onClick={() => void exportArchive()}
                variant="primary"
              >
                Export archive
              </Button>
            </div>
          </div>
        ) : (
          <div className="settings-recovery-flow stack stack-md">
            <div className="settings-recovery-flow-heading">
              <div><h4>Import a protected archive</h4><p>Enter the passphrase used when the portable archive was created.</p></div>
              <Button disabled={importingArchive} onClick={closeRecoveryFlow} size="sm" variant="ghost">Cancel</Button>
            </div>
            <TextField
              autoComplete="current-password"
              autoFocus
              containerClassName="settings-recovery-single-field"
              disabled={importingArchive}
              id="recovery-import-passphrase"
              label="Archive passphrase"
              minLength={16}
              onChange={event => setImportPassphrase(event.currentTarget.value)}
              type="password"
              value={importPassphrase}
            />
            <InlineAlert title="Current local data will be replaced" tone="warning">
              WA Studio creates a safety backup before restoring the selected archive.
            </InlineAlert>
            <div className="settings-form-actions">
              <Button
                disabled={importPassphrase.length < 16}
                onClick={() => setConfirmingImport(true)}
                variant="danger"
              >
                Choose archive and restore
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      <ConfirmationDialog
        body={selectedBackup ? (
          <>
            Current local Runtime data will be replaced with <strong>{selectedBackup.id}</strong>.
            WA Studio creates a safety backup first, then restarts the Runtime. OpenWA is unchanged.
          </>
        ) : "Select a backup to restore."}
        busy={restoringBackup}
        busyLabel="Restoring…"
        confirmLabel="Restore backup"
        confirmVariant="danger"
        onCancel={() => { if (!restoringBackup) setSelectedBackup(null); }}
        onConfirm={() => void confirmRestoreBackup()}
        open={selectedBackup !== null}
        title="Restore this backup?"
      />
      <ConfirmationDialog
        body={(
          <>
            Current local Runtime data will be replaced by the selected portable archive.
            WA Studio creates a safety backup first, then restarts the Runtime. OpenWA is unchanged.
          </>
        )}
        busy={importingArchive}
        busyLabel="Restoring…"
        confirmLabel="Choose archive and restore"
        confirmVariant="danger"
        onCancel={() => { if (!importingArchive) setConfirmingImport(false); }}
        onConfirm={() => void confirmImportArchive()}
        open={confirmingImport}
        title="Restore a portable archive?"
      />
    </div>
  );
}
