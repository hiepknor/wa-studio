import { type FormEvent, useEffect, useState } from "react";

import {
  getManagedRuntimeLifecycleStatus,
  getManagedRuntimeProvisioningProfile,
  reconfigureManagedRuntime,
  resetManagedRuntimeConnection,
  rotateManagedRuntimeConnectorCredential,
  type ManagedRuntimeLifecycleStatus,
  type ManagedRuntimePhase,
  type ManagedRuntimeProvisioningInput,
  type ManagedRuntimeProvisioningProfile,
} from "@/shared/native/managed-runtime";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { useSingleFlightOperation } from "@/shared/hooks/useSingleFlightOperation";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { SwitchField } from "@/shared/ui/SwitchField";
import { TextField } from "@/shared/ui/TextField";
import { useToast } from "@/shared/ui/Toast";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import type { SettingsTaskNavigationState } from "./settings-types";

interface ManagedRuntimeConfigurationPanelProps {
  getLifecycleStatus?: typeof getManagedRuntimeLifecycleStatus;
  getProfile?: typeof getManagedRuntimeProvisioningProfile;
  onNavigationStateChange?: (state: SettingsTaskNavigationState) => void;
  phase: ManagedRuntimePhase;
  resetConnection?: typeof resetManagedRuntimeConnection;
  rotateCredential?: typeof rotateManagedRuntimeConnectorCredential;
  saveProfile?: typeof reconfigureManagedRuntime;
}

type MaintenanceIntent = "reset" | "rotate" | null;

function lifecycleRecoveryCopy(status: ManagedRuntimeLifecycleStatus): string {
  const phase = status.phase.replace(/([A-Z])/g, " $1").toLocaleLowerCase();
  switch (status.operation) {
    case "reconfigure":
      return `Connection update stopped during ${phase}. Re-enter the intended API key and save the same settings to resume safely.`;
    case "reset":
      return `OpenWA disconnect stopped during ${phase}. Choose Disconnect OpenWA again to resume the recorded cleanup.`;
    case "rotateConnectorCredential":
      return `Credential rotation stopped during ${phase}. Choose Rotate credential again to resume the same generation.`;
  }
}

export function ManagedRuntimeConfigurationPanel({
  getLifecycleStatus = getManagedRuntimeLifecycleStatus,
  getProfile = getManagedRuntimeProvisioningProfile,
  onNavigationStateChange,
  phase,
  resetConnection = resetManagedRuntimeConnection,
  rotateCredential = rotateManagedRuntimeConnectorCredential,
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
  const [lifecycleStatus, setLifecycleStatus] = useState<ManagedRuntimeLifecycleStatus | null>(null);
  const [maintenanceIntent, setMaintenanceIntent] = useState<MaintenanceIntent>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveOperation = useSingleFlightOperation();
  const maintenanceOperation = useSingleFlightOperation();

  useEffect(() => {
    let disposed = false;
    void Promise.all([getProfile(), getLifecycleStatus()])
      .then(([next, lifecycle]) => {
        if (disposed) return;
        setLifecycleStatus(lifecycle);
        setProfile(next);
        if (next) {
          setBaseUrl(next.openwaBaseUrl);
          setAllowLiveSends(next.allowLiveSends);
        }
      })
      .catch(caught => {
        if (!disposed) {
          setError(userFacingErrorMessage(caught, "Could not load Runtime settings."));
        }
      })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [getLifecycleStatus, getProfile]);

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
    const token = saveOperation.begin();
    if (token === null) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveProfile(candidate);
      if (!saveOperation.isCurrent(token)) return;
      setProfile(saved);
      setBaseUrl(saved.openwaBaseUrl);
      setAllowLiveSends(saved.allowLiveSends);
      setApiKey("");
      setCandidate(null);
      setLifecycleStatus(null);
      notify({
        description: "The credentials were verified. WA Runtime is restarting with the updated connection.",
        title: "Connection updated",
        tone: "success",
      });
    } catch (caught) {
      if (saveOperation.isCurrent(token)) {
        setError(userFacingErrorMessage(
          caught,
          "Could not update Runtime settings.",
          [candidate.openwaApiKey],
        ));
      }
    } finally {
      if (saveOperation.complete(token)) setSaving(false);
    }
  }

  async function confirmMaintenance() {
    if (!maintenanceIntent) return;
    const token = maintenanceOperation.begin();
    if (token === null) return;
    setMaintenanceBusy(true);
    setMaintenanceError(null);
    try {
      if (maintenanceIntent === "rotate") {
        const saved = await rotateCredential();
        if (!maintenanceOperation.isCurrent(token)) return;
        setProfile(saved);
        notify({
          description: "The new connector generation published a healthy heartbeat before delivery resumed.",
          title: "Connector credential rotated",
          tone: "success",
        });
      } else {
        await resetConnection();
        if (!maintenanceOperation.isCurrent(token)) return;
        setProfile(null);
        notify({
          description: "Remote WA Studio connector resources were retired. Local Runtime data was preserved.",
          title: "OpenWA disconnected",
          tone: "success",
        });
      }
      setLifecycleStatus(null);
      setMaintenanceIntent(null);
    } catch (caught) {
      if (maintenanceOperation.isCurrent(token)) {
        setMaintenanceError(userFacingErrorMessage(
          caught,
          maintenanceIntent === "rotate"
            ? "Could not rotate the connector credential."
            : "Could not disconnect OpenWA.",
        ));
        try {
          setLifecycleStatus(await getLifecycleStatus());
        } catch {
          // The operation error remains authoritative if lifecycle status cannot be refreshed.
        }
      }
    } finally {
      if (maintenanceOperation.complete(token)) setMaintenanceBusy(false);
    }
  }

  const editable = profile !== null
    && phase === "ready"
    && (!lifecycleStatus || lifecycleStatus.operation === "reconfigure");
  const dirty = profile !== null && (
    baseUrl !== profile.openwaBaseUrl
    || allowLiveSends !== profile.allowLiveSends
    || apiKey.length > 0
  );

  useEffect(() => {
    onNavigationStateChange?.({ busy: saving || maintenanceBusy, dirty });
    return () => onNavigationStateChange?.({ busy: false, dirty: false });
  }, [dirty, maintenanceBusy, onNavigationStateChange, saving]);

  function discardChanges() {
    if (!profile || saving) return;
    setBaseUrl(profile.openwaBaseUrl);
    setAllowLiveSends(profile.allowLiveSends);
    setApiKey("");
    setCandidate(null);
    setError(null);
  }

  return (
    <div className="settings-panel-stack">
      {!candidate && error && <InlineAlert className="settings-notice" title="Connection settings failed">{error}</InlineAlert>}
      {lifecycleStatus && (
        <InlineAlert className="settings-notice" title="Connection maintenance requires recovery" tone="warning">
          {lifecycleRecoveryCopy(lifecycleStatus)} Runtime delivery remains blocked until verification and resume complete.
        </InlineAlert>
      )}

      <SettingsSection
        action={<Badge tone={profile ? "success" : "neutral"} variant={loading ? "label" : "status"}>{loading ? "Loading" : profile ? "Connected" : "Developer managed"}</Badge>}
        description="Managed WA Runtime uses this endpoint and credential to reach OpenWA; WA Studio product preferences are unchanged."
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
                action={(
                  <Badge
                    tone={profile.connectorPluginVersion ? "success" : "warning"}
                    variant="status"
                  >
                    {profile.connectorPluginVersion ? "Provisioned" : "Required"}
                  </Badge>
                )}
                description={profile.connectorPluginVersion
                  ? `WA Studio Connector ${profile.connectorPluginVersion}`
                  : "Live sends remain disabled until the connector is provisioned."}
                label="OpenWA connector"
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
              <strong aria-live="polite">{dirty ? "Unsaved connection changes" : "Connection is saved"}</strong>
              <span>WA Studio verifies the endpoint and Event Inbox pairing before applying changes.</span>
            </div>
            <div className="settings-section-actions settings-form-controls">
              <Button
                disabled={!dirty || saving}
                onClick={discardChanges}
                type="button"
                variant="ghost"
              >
                Discard changes
              </Button>
              <Button
                disabled={!editable || !dirty || apiKey.length === 0 || saving}
                loading={saving}
                type="submit"
                variant="primary"
              >
                Verify and restart Runtime
              </Button>
            </div>
          </div>
        </form>
      </SettingsSection>

      {profile && (
        <SettingsSection
          description="Lifecycle operations drain Runtime work, preserve a durable recovery intent, and resume delivery only after verification."
          kicker="Operations"
          title="Connection maintenance"
          titleId="runtime-maintenance-title"
        >
          <SettingsRow
            action={(
              <Button
                disabled={
                  phase !== "ready"
                  || saving
                  || maintenanceBusy
                  || !profile.connectorPluginVersion
                  || (lifecycleStatus !== null
                    && lifecycleStatus.operation !== "rotateConnectorCredential")
                }
                onClick={() => {
                  setMaintenanceError(null);
                  setMaintenanceIntent("rotate");
                }}
                variant="secondary"
              >
                Rotate credential
              </Button>
            )}
            description="Advance the connector token generation, update the OpenWA plugin, then require a fresh matching heartbeat."
            label="Connector credential"
          />
          <SettingsRow
            action={(
              <Button
                disabled={
                  phase !== "ready"
                  || saving
                  || maintenanceBusy
                  || (lifecycleStatus !== null && lifecycleStatus.operation !== "reset")
                }
                onClick={() => {
                  setMaintenanceError(null);
                  setMaintenanceIntent("reset");
                }}
                variant="danger"
              >
                Disconnect OpenWA
              </Button>
            )}
            description="Retire only WA Studio's connector, ingress, and device scope. Campaigns, runs, and local PostgreSQL data remain on this Mac."
            label="OpenWA connection"
          />
        </SettingsSection>
      )}

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
        error={error}
        errorTitle="Connection verification failed"
        onCancel={() => { if (!saving) setCandidate(null); }}
        onConfirm={() => void confirmSave()}
        open={candidate !== null}
        title={candidate?.allowLiveSends ? "Enable live sends?" : "Update Runtime connection?"}
      />

      <ConfirmationDialog
        body={maintenanceIntent === "rotate" ? (
          <>
            WA Studio will block new OpenWA work, drain Runtime and the connector journal, rotate
            to the next credential generation, restart Runtime, then require a fresh healthy
            connector heartbeat before resuming delivery.
          </>
        ) : (
          <>
            WA Studio will block and drain delivery, retire only its OpenWA connector resources,
            and return to connection setup. Local campaigns, runs, evidence, and PostgreSQL data
            are preserved.
          </>
        )}
        busy={maintenanceBusy}
        busyLabel={maintenanceIntent === "rotate" ? "Rotating…" : "Disconnecting…"}
        confirmLabel={maintenanceIntent === "rotate" ? "Rotate credential" : "Disconnect OpenWA"}
        confirmVariant={maintenanceIntent === "rotate" ? "primary" : "danger"}
        error={maintenanceError}
        errorTitle={maintenanceIntent === "rotate" ? "Credential rotation failed" : "Disconnect failed"}
        onCancel={() => {
          if (!maintenanceBusy) {
            setMaintenanceIntent(null);
            setMaintenanceError(null);
          }
        }}
        onConfirm={() => void confirmMaintenance()}
        open={maintenanceIntent !== null}
        title={maintenanceIntent === "rotate" ? "Rotate connector credential?" : "Disconnect OpenWA?"}
      />
    </div>
  );
}
