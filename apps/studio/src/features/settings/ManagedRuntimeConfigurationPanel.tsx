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
import { SwitchField } from "@/shared/ui/SwitchField";
import { TextField } from "@/shared/ui/TextField";
import { useToast } from "@/shared/ui/Toast";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

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
  const { notify } = useToast();
  const [profile, setProfile] = useState<ManagedRuntimeProvisioningProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [allowLiveSends, setAllowLiveSends] = useState(false);
  const [candidate, setCandidate] = useState<ManagedRuntimeProvisioningInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      notify({
        description: "The credentials were verified. WA Runtime is restarting with the updated connection.",
        title: "Connection updated",
        tone: "success",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update Runtime settings.");
    } finally {
      setSaving(false);
    }
  }

  const editable = profile !== null && (phase === "ready" || phase === "degraded");
  const dirty = profile !== null && (
    baseUrl !== profile.openwaBaseUrl
    || allowLiveSends !== profile.allowLiveSends
    || apiKey.length > 0
  );

  return (
    <div className="settings-panel-stack">
      <InlineAlert className="settings-notice" title="WA Runtime service settings" tone="info">
        Changes here affect the managed WA Runtime connection, not WA Studio product preferences.
      </InlineAlert>
      {error && <InlineAlert className="settings-notice" title="Connection settings failed">{error}</InlineAlert>}

      <SettingsSection
        action={<Badge tone={profile ? "success" : "neutral"} variant={loading ? "label" : "status"}>{loading ? "Loading" : profile ? "Connected" : "Developer managed"}</Badge>}
        description="WA Runtime uses this endpoint and credential to reach your OpenWA service."
        kicker="Gateway connection"
        title="OpenWA profile"
        titleId="runtime-configuration-title"
      >
        <form className="settings-configuration-form" onSubmit={submit}>
          {!loading && !profile && (
            <InlineAlert title="This profile is not editable" tone="neutral">
              This Runtime is provisioned from the developer environment instead of the local app profile.
            </InlineAlert>
          )}

          <div className="settings-field-grid">
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
              description="Required for every change. The saved key is never shown in Studio."
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
            <div className="settings-connection-summary">
              <SettingsRow
                action={<Badge tone="success" variant="status">Paired</Badge>}
                description={profile.eventInboxBaseUrl}
                label="Event Inbox"
              />
              <SettingsRow
                action={<span className="settings-row-value">{profile.openwaAllowedSessionIds.length} session(s)</span>}
                description="Renewed when the connection changes."
                label="Session scope"
              />
            </div>
          )}

          <SwitchField
            checked={allowLiveSends}
            className="settings-switch-row"
            description="Keep this off while validating campaigns. Turning it on allows real OpenWA deliveries after restart."
            disabled={!editable || saving}
            id="settings-live-sends"
            label="Allow live sends"
            onChange={event => setAllowLiveSends(event.currentTarget.checked)}
          />

          <div className="settings-form-actions">
            <div className="settings-action-copy">
              <strong>{dirty ? "Unsaved connection changes" : "Connection is saved"}</strong>
              <span>WA Studio verifies the endpoint and Event Inbox pairing before applying changes.</span>
            </div>
            <Button
              disabled={!editable || !dirty || apiKey.length === 0 || saving}
              loading={saving}
              type="submit"
              variant="primary"
            >
              Verify and restart Runtime
            </Button>
          </div>
        </form>
      </SettingsSection>

      <ConfirmationDialog
        body={candidate?.allowLiveSends ? (
          <>
            This enables real OpenWA deliveries after WA Runtime restarts. WA Studio verifies the
            new endpoint, credential, release, and Event Inbox pairing before applying the change.
          </>
        ) : (
          <>
            WA Studio will verify the OpenWA endpoint and credential, renew Event Inbox pairing,
            save the profile, then restart WA Runtime. OpenWA itself is unchanged.
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
    </div>
  );
}
