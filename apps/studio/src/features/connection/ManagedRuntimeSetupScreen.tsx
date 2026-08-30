import { FormEvent, useEffect, useRef, useState } from "react";

import type { ManagedConnectionFlow } from "@/app/RuntimeConnectionState";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { useSingleFlightOperation } from "@/shared/hooks/useSingleFlightOperation";
import {
  getManagedRuntimeProvisioningProfile,
  listManagedRuntimeBackups,
  restoreManagedRuntimeBackup,
  type ManagedRuntimeBackup,
  type ManagedRuntimeProvisioningInput,
  type ManagedRuntimeProvisioningProfile,
  type ManagedRuntimeSnapshot,
} from "@/shared/native/managed-runtime";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DescriptionList } from "@/shared/ui/Composition";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { TextField } from "@/shared/ui/TextField";
import { ConnectionShell } from "./ConnectionShell";

interface ManagedRuntimeSetupScreenProps {
  connectionError?: string | null;
  flow: ManagedConnectionFlow;
  getProfile?: () => Promise<ManagedRuntimeProvisioningProfile | null>;
  listBackups?: () => Promise<ManagedRuntimeBackup[]>;
  onConnect: (input: ManagedRuntimeProvisioningInput) => Promise<void>;
  restoreBackup?: (backupId: string) => Promise<void>;
  snapshot: ManagedRuntimeSnapshot;
}

type SetupOperation = "connect" | "restore" | null;

function progressCopy(
  flow: ManagedConnectionFlow,
  snapshot: ManagedRuntimeSnapshot,
): readonly [string, string] {
  if (flow === "validating") {
    return ["Checking OpenWA", "Validating the gateway and discovering Event Inbox…"];
  }
  if (flow === "attaching") {
    return ["Opening workspace", "Attaching Studio to the healthy local Runtime…"];
  }
  if (snapshot.maintenance?.kind === "preMigrationBackup") {
    return ["Protecting local data", "Creating and verifying a recovery point before the schema upgrade…"];
  }
  switch (snapshot.phase) {
    case "databaseStarting":
      return ["Starting local database", "Starting the managed PostgreSQL service…"];
    case "migrating":
      return ["Upgrading local data", "Applying the pending Runtime database migrations…"];
    case "runtimeStarting":
      return ["Starting WA Runtime", "Starting the API, worker, and scheduler processes…"];
    case "reconfiguring":
      return ["Applying connection settings", "Restarting local services with the new OpenWA configuration…"];
    case "restoring":
      return ["Restoring local data", "Authenticating and restoring the selected recovery point…"];
    case "updating":
      return ["Preparing the update", "Protecting local data before WA Studio restarts…"];
    case "stopping":
      return ["Closing local services", "Finishing active work before the managed Runtime stops…"];
    default:
      return ["Inspecting local workspace", "Checking the bundled Runtime and local configuration…"];
  }
}

function availabilityLabel(availability: ManagedRuntimeSnapshot["availability"]): string {
  switch (availability) {
    case "busy": return "Maintenance";
    case "degraded": return "Needs attention";
    case "needsSetup": return "Setup required";
    case "offline": return "Offline";
    case "online": return "Online";
    case "stopping": return "Closing";
    default: return "Starting";
  }
}

export function ManagedRuntimeSetupScreen({
  connectionError = null,
  flow,
  getProfile = getManagedRuntimeProvisioningProfile,
  listBackups = listManagedRuntimeBackups,
  onConnect,
  restoreBackup = restoreManagedRuntimeBackup,
  snapshot,
}: ManagedRuntimeSetupScreenProps) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [storedProfileLoaded, setStoredProfileLoaded] = useState(false);
  const [backups, setBackups] = useState<ManagedRuntimeBackup[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [selectedBackup, setSelectedBackup] = useState<ManagedRuntimeBackup | null>(null);
  const [operation, setOperation] = useState<SetupOperation>(null);
  const baseUrlEditedRef = useRef(false);
  const operationLifecycle = useSingleFlightOperation();
  const operationBusy = operation !== null;
  const connecting = operation === "connect";
  const restoringBackup = operation === "restore";
  const showForm = flow === "configure" || flow === "error";
  const progress = progressCopy(flow, snapshot);

  useEffect(() => {
    if (!showForm) return;
    let disposed = false;
    void getProfile().then(profile => {
      if (!disposed && profile && !baseUrlEditedRef.current) {
        setBaseUrl(profile.openwaBaseUrl);
        setStoredProfileLoaded(true);
      }
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [getProfile, showForm]);

  useEffect(() => {
    if (snapshot.phase !== "degraded") {
      setBackups([]);
      setBackupsLoading(false);
      setBackupError(null);
      setSelectedBackup(null);
      return;
    }
    let disposed = false;
    setBackups([]);
    setBackupsLoading(true);
    setBackupError(null);
    void listBackups().then(available => {
      if (!disposed) setBackups(available);
    }).catch(caught => {
      if (!disposed) {
        setBackupError(userFacingErrorMessage(caught, "Could not list recovery points."));
      }
    }).finally(() => {
      if (!disposed) setBackupsLoading(false);
    });
    return () => { disposed = true; };
  }, [listBackups, snapshot.phase]);

  useEffect(() => {
    if (showForm && storedProfileLoaded) {
      document.getElementById("openwa-api-key")?.focus();
    }
  }, [showForm, storedProfileLoaded]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operationBusy) return;
    const token = operationLifecycle.begin();
    if (token === null) return;
    setOperation("connect");
    try {
      await onConnect({ openwaBaseUrl: baseUrl.trim(), openwaApiKey: apiKey.trim() });
    } catch {
      // The controller owns and renders the failure state.
    } finally {
      if (operationLifecycle.complete(token)) setOperation(null);
    }
  }

  async function confirmRestore() {
    if (!selectedBackup || operationBusy) return;
    const token = operationLifecycle.begin();
    if (token === null) return;
    setOperation("restore");
    setBackupError(null);
    try {
      await restoreBackup(selectedBackup.id);
      if (!operationLifecycle.isCurrent(token)) return;
      setSelectedBackup(null);
    } catch (caught) {
      if (operationLifecycle.isCurrent(token)) {
        setBackupError(userFacingErrorMessage(caught, "Could not restore the recovery point."));
      }
    } finally {
      if (operationLifecycle.complete(token)) setOperation(null);
    }
  }

  return (
    <>
      <ConnectionShell
        buildLabel="Local workspace"
        description={showForm
          ? "Connect WA Studio to OpenWA. Runtime, queues, campaign drafts, and backups remain managed on this Mac."
          : "WA Studio is preparing the private local workspace and validating each managed service."}
        eyebrow="Local operations workbench"
        title={flow === "error" ? "Workspace needs attention." : showForm ? "Ready on this machine." : "Preparing this machine."}
        titleId="managed-runtime-title"
        trustNote="WA Studio does not send operational data to a hosted workspace."
      >
        {showForm ? (
          <form aria-label="OpenWA connection" className="connection-form connection-setup-card" onSubmit={submit}>
            <header className="connection-section-label"><span>OpenWA gateway</span></header>
            <div className="connection-card-heading"><h2>Connect to OpenWA</h2><p>Studio validates the gateway before starting the managed local workspace.</p></div>
            <div className="connection-fields">
              <TextField autoFocus={baseUrl.length === 0} disabled={operationBusy} icon="server" id="openwa-url" inputMode="url" label="OpenWA base URL" monospace onChange={event => { baseUrlEditedRef.current = true; setStoredProfileLoaded(false); setBaseUrl(event.currentTarget.value); }} placeholder="https://openwa.company.com" required spellCheck={false} type="url" value={baseUrl} />
              <TextField autoComplete="new-password" autoFocus={baseUrl.length > 0} description="Saved in the protected local app store after validation." disabled={operationBusy} icon="key" id="openwa-api-key" label="OpenWA API key" monospace onChange={event => setApiKey(event.currentTarget.value)} required type="password" value={apiKey} />
            </div>
            {flow === "error" ? <InlineAlert className="connection-status" indicator layout="stacked" title="Could not connect" variant="quiet">{connectionError ?? snapshot.error ?? "Check the connection and try again."}</InlineAlert> : <InlineAlert className="connection-status" indicator layout="stacked" title="Local by default" tone="neutral" variant="quiet">Runtime and data stay on this Mac.</InlineAlert>}
            {snapshot.phase === "degraded" && (
              <section aria-labelledby="degraded-recovery-title" className="managed-runtime-recovery stack stack-sm">
                <div>
                  <span className="connection-card-kicker">Database recovery</span>
                  <h3 id="degraded-recovery-title">Restore a verified local backup</h3>
                  <p>The failed PostgreSQL directory will be quarantined, never deleted.</p>
                </div>
                {backupError && !selectedBackup && <InlineAlert title="Recovery unavailable">{backupError}</InlineAlert>}
                {backupsLoading ? <small>Loading verified recovery points…</small> : backups.length === 0 ? <small>No local recovery points are available.</small> : (
                  <div className="managed-runtime-recovery-list">
                    {backups.map(backup => <Button disabled={operationBusy} key={backup.id} onClick={() => { setBackupError(null); setSelectedBackup(backup); }} size="sm" type="button">Restore {new Date(backup.createdAtMs).toLocaleString()}</Button>)}
                  </div>
                )}
              </section>
            )}
            <div className="connection-service-check">
              <span aria-hidden="true" className="connection-status-mark"><AppIcon name="server" size="sm" /></span>
              <span><strong>WA Runtime managed locally</strong><small>v{snapshot.manifest?.version ?? "bundled"} · PostgreSQL-backed</small></span>
            </div>
            <Button className="connection-submit-button" disabled={operationBusy} loading={connecting} size="lg" type="submit" variant="primary">Connect OpenWA</Button>
            <p className="connection-setup-footnote">Connection settings can be changed later without moving local data.</p>
          </form>
        ) : (
          <section aria-label="Connection progress" aria-live="polite" className="connection-form connection-setup-card">
            <header className="connection-section-label"><span>Local workspace</span><span className="connection-step-count">{availabilityLabel(snapshot.availability)}</span></header>
            <div className="connection-card-heading"><h2>{progress[0]}</h2><p>Keep WA Studio open while setup completes.</p></div>
            <p className="managed-runtime-progress" role="status"><span aria-hidden="true" /><strong>{progress[1]}</strong></p>
            <DescriptionList ariaLabel="Local Runtime services" className="connection-runtime-grid" items={[
              { id: "data", label: "Data", value: "PostgreSQL · local" },
              { id: "queue", label: "Queue", value: "Durable · local" },
              { id: "runtime", label: "Runtime", value: "Supervised by WA Studio" },
            ]} />
          </section>
        )}
      </ConnectionShell>
      <ConfirmationDialog
        body={selectedBackup ? (
          <>
            WA Studio will copy and authenticate <strong>{selectedBackup.id}</strong>, quarantine
            the degraded PostgreSQL directory, provision a clean database, and restore the archive
            transactionally.
          </>
        ) : "Select a recovery point."}
        busy={restoringBackup}
        busyLabel="Recovering…"
        confirmLabel="Quarantine and restore"
        confirmVariant="danger"
        error={backupError}
        errorTitle="Could not restore recovery point"
        onCancel={() => { if (!operationBusy) setSelectedBackup(null); }}
        onConfirm={() => void confirmRestore()}
        open={selectedBackup !== null}
        title="Recover the local Runtime database?"
      />
    </>
  );
}
