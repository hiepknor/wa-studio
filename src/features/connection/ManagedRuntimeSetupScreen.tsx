import { FormEvent, useEffect, useState } from "react";

import type { ManagedConnectionFlow } from "@/app/RuntimeConnectionState";
import {
  getManagedRuntimeProvisioningProfile,
  type ManagedRuntimeProvisioningInput,
  type ManagedRuntimeProvisioningProfile,
  type ManagedRuntimeSnapshot,
} from "@/shared/native/managed-runtime";
import { BrandMark } from "@/shared/ui/BrandMark";
import { Button } from "@/shared/ui/Button";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { TextField } from "@/shared/ui/TextField";

interface ManagedRuntimeSetupScreenProps {
  connectionError?: string | null;
  flow: ManagedConnectionFlow;
  getProfile?: () => Promise<ManagedRuntimeProvisioningProfile | null>;
  onConnect: (input: ManagedRuntimeProvisioningInput) => Promise<void>;
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
  onConnect,
  snapshot,
}: ManagedRuntimeSetupScreenProps) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [storedProfileLoaded, setStoredProfileLoaded] = useState(false);
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

  return (
    <main className="shell connection-shell managed-runtime-shell">
      <header className="connection-brand">
        <BrandMark /><strong>WA Studio</strong><span className="connection-build">local workspace</span>
      </header>
      <div className="connection-stage">
        <section className="intro connection-intro" aria-labelledby="managed-runtime-title">
          <span className="eyebrow">{showForm ? "Gateway connection" : "Local workspace"}</span>
          <h1 id="managed-runtime-title">{showForm ? <>Connect your <span>OpenWA</span></> : <>Preparing your <span>workspace</span></>}</h1>
          <p>{showForm ? "Point WA Studio at your existing OpenWA gateway. Everything else runs privately on this Mac." : "WA Studio is preparing the private local workspace on this Mac."}</p>
          <ol aria-label="Workspace setup progress" className="connection-setup-steps">
            {[
              ["Connect OpenWA", "Validate the gateway and discover Event Inbox."],
              ["Start local services", "Prepare Runtime, PostgreSQL, and the durable queue."],
              ["Open workspace", "Attach Studio after every local process is healthy."],
            ].map(([title, description], index) => (
              <li className={index < step ? "is-complete" : index === step ? "is-active" : ""} key={title}>
                <span className="connection-step-index">{index < step ? "✓" : index + 1}</span>
                <span><strong>{title}</strong><small>{description}</small></span>
              </li>
            ))}
          </ol>
          <dl className="connection-specs">
            <div><dt>Gateway</dt><dd>OpenWA 0.22.0 pinned</dd></div>
            <div><dt>Runtime</dt><dd>{snapshot.manifest?.version ?? "bundled with Studio"}</dd></div>
            <div><dt>Storage</dt><dd>local + protected</dd></div>
          </dl>
        </section>

        {showForm ? (
          <form className="connection-form" onSubmit={submit}>
            <article aria-label="OpenWA connection" className="connection-card">
              <header className="connection-terminal-bar"><span className="connection-window-dots" aria-hidden="true"><i /><i /><i /></span><span>openwa.connect</span><span className="connection-terminal-state">0.22.0</span></header>
              <div className="card-content stack stack-md">
                <div className="connection-card-heading"><span className="connection-card-kicker">Gateway connection</span><h2>Connect to OpenWA</h2><p>Studio validates OpenWA before starting the local workspace.</p></div>
                <TextField autoFocus={baseUrl.length === 0} icon="server" id="openwa-url" inputMode="url" label="OpenWA base URL" monospace onChange={event => setBaseUrl(event.currentTarget.value)} placeholder="https://openwa.company.com" required spellCheck={false} type="url" value={baseUrl} />
                <TextField autoComplete="new-password" autoFocus={baseUrl.length > 0} description="Saved in the protected local app store after validation." icon="key" id="openwa-api-key" label="OpenWA API key" monospace onChange={event => setApiKey(event.currentTarget.value)} required type="password" value={apiKey} />
                {flow === "error" ? <InlineAlert className="connection-status" indicator title="Could not connect">{connectionError ?? snapshot.error ?? "Check the connection and try again."}</InlineAlert> : <InlineAlert className="connection-status" indicator title="Local by default" tone="neutral">Runtime and data stay on this Mac.</InlineAlert>}
              </div>
              <footer className="card-footer"><span className="connection-shortcut" aria-hidden="true">Local services start automatically</span><Button className="connection-submit-button" size="lg" type="submit" variant="primary">Connect OpenWA</Button></footer>
            </article>
          </form>
        ) : (
          <section aria-live="polite" className="connection-form">
            <article aria-label="Connection progress" className="connection-card managed-runtime-status-card">
              <header className="connection-terminal-bar"><span className="connection-window-dots" aria-hidden="true"><i /><i /><i /></span><span>workspace.start</span><span className="connection-terminal-state">{flow}</span></header>
              <div className="card-content stack stack-md"><div className="connection-card-heading"><span className="connection-card-kicker">Workspace setup</span><h2>{progress[0]}</h2><p>Keep WA Studio open while setup completes.</p></div><p className="managed-runtime-progress" role="status"><span aria-hidden="true" /><strong>{progress[1]}</strong></p><dl className="connection-runtime-grid"><div><dt>Database</dt><dd>PostgreSQL</dd></div><div><dt>Queue</dt><dd>PostgreSQL</dd></div><div><dt>Processes</dt><dd>API · Worker · Scheduler</dd></div></dl></div>
            </article>
          </section>
        )}
      </div>
      <footer className="connection-footer"><span><i /> local services managed by Studio</span><span>OpenWA stays release-pinned and unchanged</span></footer>
    </main>
  );
}
