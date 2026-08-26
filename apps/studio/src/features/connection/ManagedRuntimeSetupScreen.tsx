import { FormEvent, useEffect, useState } from "react";

import type { ManagedConnectionFlow } from "@/app/RuntimeConnectionState";
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

const progressCopy = {
  booting: ["Preparing local workspace", "Inspecting the bundled Runtime…"],
  validating: ["Checking OpenWA", "Validating the gateway and discovering Event Inbox…"],
  starting: ["Starting local services", "Preparing PostgreSQL, API, worker, and scheduler…"],
  attaching: ["Opening workspace", "Attaching Studio to the healthy local Runtime…"],
} as const;

function activeStep(flow: ManagedConnectionFlow): number {
  if (flow === "starting") return 1;
  if (flow === "attaching" || flow === "connected") return 2;
  return 0;
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
  const [backupError, setBackupError] = useState<string | null>(null);
  const [selectedBackup, setSelectedBackup] = useState<ManagedRuntimeBackup | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const showForm = flow === "configure" || flow === "error";
  const step = activeStep(flow);
  const progress = flow in progressCopy
    ? progressCopy[flow as keyof typeof progressCopy]
    : progressCopy.booting;

  useEffect(() => {
    if (!showForm) return;
    let disposed = false;
    void getProfile().then(profile => {
      if (!disposed && profile) {
        setBaseUrl(profile.openwaBaseUrl);
        setStoredProfileLoaded(true);
      }
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [getProfile, showForm]);

  useEffect(() => {
    if (snapshot.phase !== "degraded") return;
    let disposed = false;
    void listBackups().then(available => {
      if (!disposed) setBackups(available);
    }).catch(caught => {
      if (!disposed) {
        setBackupError(caught instanceof Error ? caught.message : "Could not list recovery points.");
      }
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
    try {
      await onConnect({ openwaBaseUrl: baseUrl.trim(), openwaApiKey: apiKey.trim() });
    } catch {
      // The controller owns and renders the failure state.
    }
  }

  async function confirmRestore() {
    if (!selectedBackup) return;
    setRestoringBackup(true);
    setBackupError(null);
    try {
      await restoreBackup(selectedBackup.id);
      setSelectedBackup(null);
    } catch (caught) {
      setBackupError(caught instanceof Error ? caught.message : "Could not restore the recovery point.");
    } finally {
      setRestoringBackup(false);
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
              <TextField autoFocus={baseUrl.length === 0} icon="server" id="openwa-url" inputMode="url" label="OpenWA base URL" monospace onChange={event => setBaseUrl(event.currentTarget.value)} placeholder="https://openwa.company.com" required spellCheck={false} type="url" value={baseUrl} />
              <TextField autoComplete="new-password" autoFocus={baseUrl.length > 0} description="Saved in the protected local app store after validation." icon="key" id="openwa-api-key" label="OpenWA API key" monospace onChange={event => setApiKey(event.currentTarget.value)} required type="password" value={apiKey} />
            </div>
            {flow === "error" ? <InlineAlert className="connection-status" indicator title="Could not connect">{connectionError ?? snapshot.error ?? "Check the connection and try again."}</InlineAlert> : <InlineAlert className="connection-status" indicator title="Local by default" tone="neutral">Runtime and data stay on this Mac.</InlineAlert>}
            {snapshot.phase === "degraded" && (
              <section aria-labelledby="degraded-recovery-title" className="managed-runtime-recovery stack stack-sm">
                <div>
                  <span className="connection-card-kicker">Database recovery</span>
                  <h3 id="degraded-recovery-title">Restore a verified local backup</h3>
                  <p>The failed PostgreSQL directory will be quarantined, never deleted.</p>
                </div>
                {backupError && <InlineAlert title="Recovery unavailable">{backupError}</InlineAlert>}
                {backups.length === 0 ? <small>No local recovery points are available.</small> : (
                  <div className="managed-runtime-recovery-list">
                    {backups.map(backup => <Button disabled={restoringBackup} key={backup.id} onClick={() => setSelectedBackup(backup)} size="sm" type="button">Restore {new Date(backup.createdAtMs).toLocaleString()}</Button>)}
                  </div>
                )}
              </section>
            )}
            <div className="connection-service-check">
              <span aria-hidden="true" className="connection-status-mark"><AppIcon name="server" size="sm" /></span>
              <span><strong>WA Runtime managed locally</strong><small>v{snapshot.manifest?.version ?? "bundled"} · PostgreSQL-backed</small></span>
            </div>
            <Button className="connection-submit-button" size="lg" type="submit" variant="primary">Connect OpenWA</Button>
            <p className="connection-setup-footnote">Connection settings can be changed later without moving local data.</p>
          </form>
        ) : (
          <section aria-label="Connection progress" aria-live="polite" className="connection-form connection-setup-card">
            <header className="connection-section-label"><span>Workspace setup</span><span className="connection-step-count">{Math.min(step + 1, 3)} of 3</span></header>
            <div className="connection-card-heading"><h2>{progress[0]}</h2><p>Keep WA Studio open while setup completes.</p></div>
            <ol aria-label="Workspace setup progress" className="connection-setup-steps">
              {[
                ["Connect OpenWA", "Validate the gateway and discover Event Inbox."],
                ["Start local services", "Prepare Runtime, PostgreSQL, and the durable queue."],
                ["Open workspace", "Attach Studio after every local process is healthy."],
              ].map(([title, description], index) => (
                <li className={index < step ? "is-complete" : index === step ? "is-active" : ""} key={title}>
                  <span className="connection-step-index">{index < step ? <AppIcon name="check" size="xs" /> : index + 1}</span>
                  <span><strong>{title}</strong><small>{description}</small></span>
                </li>
              ))}
            </ol>
            <p className="managed-runtime-progress" role="status"><span aria-hidden="true" /><strong>{progress[1]}</strong></p>
            <dl className="connection-runtime-grid"><div><dt>Database</dt><dd>PostgreSQL</dd></div><div><dt>Queue</dt><dd>PostgreSQL</dd></div><div><dt>Processes</dt><dd>API · Worker · Scheduler</dd></div></dl>
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
        onCancel={() => { if (!restoringBackup) setSelectedBackup(null); }}
        onConfirm={() => void confirmRestore()}
        open={selectedBackup !== null}
        title="Recover the local Runtime database?"
      />
    </>
  );
}
