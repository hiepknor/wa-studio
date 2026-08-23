import { type FormEvent, useEffect, useState } from "react";

import {
  getManagedRuntimeProvisioningProfile,
  reconfigureManagedRuntime,
  type ManagedRuntimePhase,
  type ManagedRuntimeProvisioningInput,
  type ManagedRuntimeProvisioningProfile,
} from "@/shared/native/managed-runtime";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { TextField } from "@/shared/ui/TextField";

interface ManagedRuntimeConfigurationPanelProps {
  getProfile?: typeof getManagedRuntimeProvisioningProfile;
  phase: ManagedRuntimePhase;
  saveProfile?: typeof reconfigureManagedRuntime;
}

export function ManagedRuntimeConfigurationPanel({
  getProfile = getManagedRuntimeProvisioningProfile,
  phase,
  saveProfile = reconfigureManagedRuntime,
}: ManagedRuntimeConfigurationPanelProps) {
  const [profile, setProfile] = useState<ManagedRuntimeProvisioningProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [allowLiveSends, setAllowLiveSends] = useState(false);
  const [candidate, setCandidate] = useState<ManagedRuntimeProvisioningInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void getProfile()
      .then(next => {
        if (disposed) return;
        setProfile(next);
        if (next) {
          setBaseUrl(next.openwaBaseUrl);
          setAllowLiveSends(next.allowLiveSends);
        }
      })
      .catch(caught => {
        if (!disposed) {
          setError(caught instanceof Error ? caught.message : "Could not load Runtime settings.");
        }
      })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [getProfile]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setCandidate({
      allowLiveSends,
      openwaApiKey: apiKey,
      openwaBaseUrl: baseUrl,
    });
  }

  async function confirmSave() {
    if (!candidate) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveProfile(candidate);
      setProfile(saved);
      setBaseUrl(saved.openwaBaseUrl);
      setAllowLiveSends(saved.allowLiveSends);
      setApiKey("");
      setCandidate(null);
      setNotice("OpenWA credentials were verified and the local Runtime is restarting.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update Runtime settings.");
    } finally {
      setSaving(false);
    }
  }

  const editable = profile !== null && (phase === "ready" || phase === "degraded");

  return (
    <section aria-labelledby="runtime-configuration-title" className="settings-update-card">
      <header className="settings-backup-header">
        <div>
          <span className="settings-card-label">Gateway connection</span>
          <h3 id="runtime-configuration-title">OpenWA 0.22.0 profile</h3>
          <p>Changes are probed against OpenWA before the protected local store is replaced or the local stack restarts.</p>
        </div>
        <Badge tone={profile ? "success" : "neutral"}>
          {loading ? "Loading" : profile ? "Protected local store" : "Developer managed"}
        </Badge>
      </header>
      <form className="settings-configuration-form stack stack-md" onSubmit={submit}>
        {!loading && !profile && (
          <InlineAlert title="Profile is not editable" tone="neutral">
            This Runtime uses developer environment provisioning rather than the production local secret store.
          </InlineAlert>
        )}
        <div className="settings-configuration-grid">
          <TextField
            disabled={!editable || saving}
            id="settings-openwa-url"
            label="OpenWA base URL"
            monospace
            onChange={event => setBaseUrl(event.currentTarget.value)}
            required
            type="url"
            value={baseUrl}
          />
          <TextField
            autoComplete="new-password"
            description="Re-entered for every change; the saved key is never exposed to Studio."
            disabled={!editable || saving}
            id="settings-openwa-key"
            label="OpenWA API key"
            monospace
            onChange={event => setApiKey(event.currentTarget.value)}
            required
            type="password"
            value={apiKey}
          />
        </div>
        {profile && (
          <InlineAlert title="Automatic Event Inbox pairing" tone="neutral">
            {profile.openwaAllowedSessionIds.length} OpenWA session(s) · {profile.eventInboxBaseUrl}
          </InlineAlert>
        )}
        <label className="settings-live-send-toggle">
          <input
            checked={allowLiveSends}
            disabled={!editable || saving}
            onChange={event => setAllowLiveSends(event.currentTarget.checked)}
            type="checkbox"
          />
          <span><strong>Allow live sends</strong><small>Keep disabled until dry-run validation is complete.</small></span>
        </label>
        {error && <InlineAlert title="Configuration failed">{error}</InlineAlert>}
        {notice && <InlineAlert title="Configuration saved" tone="success">{notice}</InlineAlert>}
        <div className="settings-update-actions">
          <Button disabled={!editable || saving} loading={saving} type="submit" variant="primary">
            Verify and restart Runtime
          </Button>
        </div>
      </form>
      <ConfirmationDialog
        body={candidate?.allowLiveSends ? (
          <>
            This enables real OpenWA sends after the local Runtime restarts. The new endpoint,
            credential, release tag, discovery document, and Event Inbox pairing will be verified first. Existing
            Local secret settings remain unchanged if verification fails.
          </>
        ) : (
          <>
            WA Studio will verify OpenWA 0.22.0 and automatically renew its Event Inbox pairing;
            atomically replace the local profile; then restart only the local Runtime stack.
            OpenWA code is not changed.
          </>
        )}
        busy={saving}
        busyLabel="Verifying…"
        confirmLabel={candidate?.allowLiveSends ? "Enable live sends and restart" : "Save and restart"}
        confirmVariant={candidate?.allowLiveSends ? "danger" : "primary"}
        onCancel={() => { if (!saving) setCandidate(null); }}
        onConfirm={() => void confirmSave()}
        open={candidate !== null}
        title={candidate?.allowLiveSends ? "Enable live sends?" : "Update Runtime connection?"}
      />
    </section>
  );
}
