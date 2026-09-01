import { useEffect, useState } from "react";

import { useSingleFlightOperation } from "@/shared/hooks/useSingleFlightOperation";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import type {
  ManagedRuntimeBackup,
  ManagedRuntimeDiagnostics,
  ProtectionFreshness,
} from "@/shared/native/managed-runtime";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DataTableFrame } from "@/shared/ui/Composition";
import { DataTable, DataTableEmptyCell } from "@/shared/ui/DataTable";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { TextField } from "@/shared/ui/TextField";
import { useToast } from "@/shared/ui/Toast";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import type { SettingsTaskNavigationState } from "./settings-types";

interface BackupRecoverySettingsProps {
  backups: ManagedRuntimeBackup[];
  createBackup: () => Promise<void>;
  diagnostics: ManagedRuntimeDiagnostics | null;
  exportRecoveryArchive: (passphrase: string) => Promise<string | null>;
  loadError: string | null;
  loading: boolean;
  onNavigationStateChange?: (state: SettingsTaskNavigationState) => void;
  onReload: () => Promise<boolean>;
  restoreBackup: (backupId: string) => Promise<void>;
  restoreRecoveryArchive: (passphrase: string) => Promise<boolean>;
  runtimeReady: boolean;
}

type RecoveryFlow = "export" | "import" | null;
type RecoveryOperation = "create-backup" | "export" | "import" | "restore-backup" | null;
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
  loadError,
  loading,
  onNavigationStateChange,
  onReload,
  restoreBackup,
  restoreRecoveryArchive,
  runtimeReady,
}: BackupRecoverySettingsProps) {
  const { notify } = useToast();
  const [selectedBackup, setSelectedBackup] = useState<ManagedRuntimeBackup | null>(null);
  const [operation, setOperation] = useState<RecoveryOperation>(null);
  const [recoveryFlow, setRecoveryFlow] = useState<RecoveryFlow>(null);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportConfirmation, setExportConfirmation] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const operationLifecycle = useSingleFlightOperation();
  const protection = protectionPresentation(diagnostics?.recoveryFreshness);
  const creatingBackup = operation === "create-backup";
  const restoringBackup = operation === "restore-backup";
  const exportingArchive = operation === "export";
  const importingArchive = operation === "import";
  const operationBusy = operation !== null;
  const recoveryDraftDirty = Boolean(
    exportPassphrase || exportConfirmation || importPassphrase,
  );

  useEffect(() => {
    onNavigationStateChange?.({
      busy: operationBusy,
      dirty: operationBusy || recoveryDraftDirty,
    });
    return () => onNavigationStateChange?.({ busy: false, dirty: false });
  }, [onNavigationStateChange, operationBusy, recoveryDraftDirty]);

  async function reloadAfterCommittedOperation(): Promise<boolean> {
    try {
      return await onReload();
    } catch {
      return false;
    }
  }

  function closeRecoveryFlow() {
    if (operationBusy) return;
    setRecoveryFlow(null);
    setPassphraseError(null);
    setExportPassphrase("");
    setExportConfirmation("");
    setImportPassphrase("");
  }

  async function createManualBackup() {
    if (operationBusy) return;
    const token = operationLifecycle.begin();
    if (token === null) return;
    setOperation("create-backup");
    setError(null);
    try {
      await createBackup();
      if (!operationLifecycle.isCurrent(token)) return;
      const refreshed = await reloadAfterCommittedOperation();
      if (!operationLifecycle.isCurrent(token)) return;
      notify({
        description: refreshed
          ? "The encrypted recovery point was verified and saved on this device."
          : "The backup was created, but the recovery-point list could not be refreshed.",
        title: refreshed ? "Backup created" : "Backup created; refresh needed",
        tone: refreshed ? "success" : "warning",
      });
    } catch (caught) {
      if (operationLifecycle.isCurrent(token)) {
        setError(userFacingErrorMessage(caught, "Could not create a manual backup."));
      }
    } finally {
      if (operationLifecycle.complete(token)) setOperation(null);
    }
  }

  async function confirmRestoreBackup() {
    if (!selectedBackup || operationBusy) return;
    const token = operationLifecycle.begin();
    if (token === null) return;
    setOperation("restore-backup");
    setError(null);
    try {
      await restoreBackup(selectedBackup.id);
      if (!operationLifecycle.isCurrent(token)) return;
      setSelectedBackup(null);
      const refreshed = await reloadAfterCommittedOperation();
      if (!operationLifecycle.isCurrent(token)) return;
      notify({
        description: refreshed
          ? "WA Runtime is restarting with the selected local data."
          : "The restore completed, but Runtime diagnostics could not be refreshed yet.",
        title: refreshed ? "Backup restored" : "Backup restored; refresh needed",
        tone: refreshed ? "success" : "warning",
      });
    } catch (caught) {
      if (operationLifecycle.isCurrent(token)) {
        setError(userFacingErrorMessage(caught, "Could not restore the backup."));
      }
    } finally {
      if (operationLifecycle.complete(token)) setOperation(null);
    }
  }

  async function exportArchive() {
    if (operationBusy) return;
    if (exportPassphrase.length < 16) {
      setPassphraseError("Use at least 16 characters.");
      return;
    }
    if (exportPassphrase !== exportConfirmation) {
      setPassphraseError("Passphrases do not match.");
      return;
    }
    const token = operationLifecycle.begin();
    if (token === null) return;
    setOperation("export");
    setError(null);
    setPassphraseError(null);
    try {
      const name = await exportRecoveryArchive(exportPassphrase);
      if (!operationLifecycle.isCurrent(token)) return;
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
      if (operationLifecycle.isCurrent(token)) {
        setError(userFacingErrorMessage(
          caught,
          "Could not export a recovery archive.",
          [exportPassphrase],
        ));
      }
    } finally {
      if (operationLifecycle.complete(token)) setOperation(null);
    }
  }

  async function confirmImportArchive() {
    if (operationBusy) return;
    const token = operationLifecycle.begin();
    if (token === null) return;
    setOperation("import");
    setError(null);
    try {
      const restored = await restoreRecoveryArchive(importPassphrase);
      if (!operationLifecycle.isCurrent(token)) return;
      setConfirmingImport(false);
      if (restored) {
        setRecoveryFlow(null);
        setImportPassphrase("");
        const refreshed = await reloadAfterCommittedOperation();
        if (!operationLifecycle.isCurrent(token)) return;
        notify({
          description: refreshed
            ? "WA Runtime is restarting with the imported data."
            : "The archive was restored, but Runtime diagnostics could not be refreshed yet.",
          title: refreshed
            ? "Recovery archive restored"
            : "Archive restored; refresh needed",
          tone: refreshed ? "success" : "warning",
        });
      }
    } catch (caught) {
      if (operationLifecycle.isCurrent(token)) {
        setError(userFacingErrorMessage(
          caught,
          "Could not restore the recovery archive.",
          [importPassphrase],
        ));
      }
    } finally {
      if (operationLifecycle.complete(token)) setOperation(null);
    }
  }

  return (
    <div className="settings-panel-stack">
      {((!selectedBackup && !confirmingImport && error) || loadError) && (
        <InlineAlert
          className="settings-notice"
          title={error ? "Recovery operation failed" : "Recovery data could not be refreshed"}
        >
          {error ?? loadError}
        </InlineAlert>
      )}

      <SettingsSection
        action={<Badge tone={protection.tone} variant="status">{protection.label}</Badge>}
        description="WA Studio verifies backup freshness and database integrity on this device."
        kicker="Protection status"
        title="Your local data"
        titleId="settings-protection-title"
      >
        <SettingsRow
          action={<span className="settings-row-value">{diagnostics?.latestRecoveryPointAtMs
            ? <DateTime value={new Date(diagnostics.latestRecoveryPointAtMs).toISOString()} />
            : "Never"}</span>}
          label="Latest recovery point"
        />
        <SettingsRow action={<span className="settings-row-value">{diagnostics?.recoveryPointCount ?? 0}</span>} label="Recovery points" />
        <SettingsRow
          action={<Badge tone={protectionPresentation(diagnostics?.integrityFreshness).tone} variant="status">
            {protectionPresentation(diagnostics?.integrityFreshness).label}
          </Badge>}
          label="Integrity"
        />
        <SettingsRow
          action={<span className="settings-row-value">{diagnostics?.lastIntegrityCheckAtMs
            ? <DateTime value={new Date(diagnostics.lastIntegrityCheckAtMs).toISOString()} />
            : "Never"}</span>}
          label="Last verified"
        />
      </SettingsSection>

      <SettingsSection
        action={(
          <div className="settings-section-actions">
            <Badge tone="neutral">{backups.length} retained</Badge>
            <Button
              disabled={!runtimeReady || operationBusy}
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
        <DataTableFrame
          className="settings-backup-table"
          label="Managed PostgreSQL backups"
          variant="flush"
        >
          <DataTable caption="Managed PostgreSQL backups">
            <thead>
              <tr>
                <th className="data-column-time" scope="col">Created</th>
                <th scope="col">Recovery point</th>
                <th className="data-column-number" scope="col">Size</th>
                <th className="data-align-end" scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><DataTableEmptyCell colSpan={4}>Loading backups…</DataTableEmptyCell></tr>
              ) : backups.length === 0 ? (
                <tr><DataTableEmptyCell colSpan={4}>No backups are available yet.</DataTableEmptyCell></tr>
              ) : backups.map(backup => (
                <tr key={backup.id}>
                  <td className="data-cell-time"><DateTime value={new Date(backup.createdAtMs).toISOString()} /></td>
                  <td className="data-cell-primary">
                    <strong>{backupKind(backup.kind)}</strong>
                    <span className="data-secondary-text">{backup.id}</span>
                  </td>
                  <td className="data-cell-number">{bytes(backup.sizeBytes)}</td>
                  <td className="data-cell-action focus-overflow-owner">
                    <Button
                      disabled={!runtimeReady || operationBusy}
                      onClick={() => { setError(null); setSelectedBackup(backup); }}
                      size="sm"
                      variant="ghost"
                    >
                      Restore
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </DataTableFrame>
      </SettingsSection>

      <SettingsSection
        action={recoveryFlow === null ? <Badge tone="warning" variant="status">Passphrase required</Badge> : undefined}
        description="Move Runtime data to another device or keep an encrypted copy away from this computer."
        kicker="Off-device recovery"
        title="Portable recovery archive"
        titleId="settings-portable-recovery-title"
      >
        {recoveryFlow === null ? (
          <div className="settings-recovery-choice-grid">
            <button
              className="settings-operation-row"
              disabled={!runtimeReady || operationBusy}
              onClick={() => setRecoveryFlow("export")}
              type="button"
            >
              <span className="settings-operation-row-copy">
                <strong>Export archive</strong>
                <small>Encrypt a portable copy with a new passphrase.</small>
              </span>
              <AppIcon name="chevron-right" />
            </button>
            <button
              className="settings-operation-row"
              disabled={!runtimeReady || operationBusy}
              onClick={() => setRecoveryFlow("import")}
              type="button"
            >
              <span className="settings-operation-row-copy">
                <strong>Import archive</strong>
                <small>Replace local Runtime data from a portable archive.</small>
              </span>
              <AppIcon name="chevron-right" />
            </button>
          </div>
        ) : recoveryFlow === "export" ? (
          <div className="settings-recovery-flow stack stack-md">
            <div className="settings-recovery-flow-heading">
              <div><h3>Export a protected archive</h3><p>Create a passphrase you can store separately from this device.</p></div>
              <Button disabled={operationBusy} onClick={closeRecoveryFlow} size="sm" variant="ghost">Cancel</Button>
            </div>
            <div className="settings-field-grid">
              <TextField
                autoComplete="new-password"
                autoFocus
                disabled={operationBusy}
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
                disabled={operationBusy}
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
                disabled={operationBusy || exportPassphrase.length < 16 || exportConfirmation.length < 16}
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
              <div><h3>Import a protected archive</h3><p>Enter the passphrase used when the portable archive was created.</p></div>
              <Button disabled={operationBusy} onClick={closeRecoveryFlow} size="sm" variant="ghost">Cancel</Button>
            </div>
            <TextField
              autoComplete="current-password"
              autoFocus
              containerClassName="settings-recovery-single-field"
              disabled={operationBusy}
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
                disabled={operationBusy || importPassphrase.length < 16}
                onClick={() => { setError(null); setConfirmingImport(true); }}
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
        error={error}
        errorTitle="Backup restore failed"
        onCancel={() => { if (!operationBusy) setSelectedBackup(null); }}
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
        error={error}
        errorTitle="Archive restore failed"
        onCancel={() => { if (!operationBusy) setConfirmingImport(false); }}
        onConfirm={() => void confirmImportArchive()}
        open={confirmingImport}
        title="Restore a portable archive?"
      />
    </div>
  );
}
