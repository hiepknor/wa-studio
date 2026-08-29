import { useCallback, useEffect, useState } from "react";

import type {
  RuntimeApi,
  RuntimeOpenWASafetyProfile,
  RuntimeOpenWASafetyScope,
} from "@/shared/api/runtime-client";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { useToast } from "@/shared/ui/Toast";
import type { FeedbackTone } from "@/shared/ui/feedback-tone";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

interface OpenWASafetySettingsProps {
  api: RuntimeApi | null;
  sessionId: string | null;
  sessionName?: string | null;
}

type PendingMutation =
  | { kind: "CONTROL"; action: "BLOCK" | "RESUME" }
  | { kind: "PROFILE"; profile: RuntimeOpenWASafetyProfile };

const PROFILE_OPTIONS = [
  {
    description: "Conservative pacing for new or recently recovered sessions.",
    label: "Canary",
    value: "CANARY",
  },
  {
    description: "Normal production pacing after the session has proved stable.",
    label: "Standard",
    value: "STANDARD",
  },
] as const;

const STATUS_PRESENTATION: Record<RuntimeOpenWASafetyScope["status"], {
  description: string;
  label: string;
  tone: FeedbackTone;
}> = {
  BLOCKED: {
    description: "OpenWA operations are stopped until an operator resumes this session.",
    label: "Blocked",
    tone: "danger",
  },
  COOLDOWN: {
    description: "Runtime is waiting for a safe recovery window before probing OpenWA again.",
    label: "Cooling down",
    tone: "warning",
  },
  READY: {
    description: "Operations are admitted through the active pacing and frequency limits.",
    label: "Ready",
    tone: "success",
  },
  RECOVERY: {
    description: "Only a controlled recovery probe can enter OpenWA at this time.",
    label: "Recovery",
    tone: "info",
  },
  THROTTLED: {
    description: "Runtime has reduced throughput after observing rate pressure.",
    label: "Throttled",
    tone: "warning",
  },
};

function formatTimestamp(value: string | null): string {
  if (!value) return "Not observed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function scopeLabel(scope: RuntimeOpenWASafetyScope["effectiveScopeType"]): string {
  if (scope === "WORKSPACE") return "Workspace";
  if (scope === "UPSTREAM") return "OpenWA upstream";
  return "Selected session";
}

export function OpenWASafetySettings({
  api,
  sessionId,
  sessionName,
}: OpenWASafetySettingsProps) {
  const { notify } = useToast();
  const [snapshot, setSnapshot] = useState<RuntimeOpenWASafetyScope | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMutation | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!api || !sessionId) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await api.getOpenWASafety(sessionId, { signal });
      if (!signal?.aborted) {
        setSnapshot(next);
        setError(null);
      }
    } catch (caught) {
      if (!signal?.aborted) {
        setError(userFacingErrorMessage(caught, "Could not load OpenWA safety state."));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setError(null);
    setPending(null);
    void load(controller.signal);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(controller.signal);
    }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [load]);

  async function applyMutation() {
    if (!pending || !api || !sessionId) return;
    setMutating(true);
    setMutationError(null);
    try {
      const next = pending.kind === "CONTROL"
        ? await api.controlOpenWASafety(
          sessionId,
          pending.action,
          crypto.randomUUID(),
          pending.action === "BLOCK" ? "OPERATOR_BLOCKED_FROM_STUDIO" : undefined,
        )
        : await api.setOpenWASafetyProfile(sessionId, pending.profile, crypto.randomUUID());
      setSnapshot(next);
      setPending(null);
      notify({
        description: pending.kind === "PROFILE"
          ? `Future operations will use the ${pending.profile.toLowerCase()} pacing profile.`
          : pending.action === "BLOCK"
            ? "New OpenWA operations for this session are now blocked."
            : "The session has returned to automatic safety control.",
        title: pending.kind === "PROFILE"
          ? "Safety profile updated"
          : pending.action === "BLOCK"
            ? "Session blocked"
            : "Session resumed",
        tone: "success",
      });
    } catch (caught) {
      setMutationError(userFacingErrorMessage(caught, "Could not update OpenWA safety."));
    } finally {
      setMutating(false);
    }
  }

  const presentation = snapshot ? STATUS_PRESENTATION[snapshot.status] : null;
  const sessionManuallyBlocked = snapshot?.circuitState === "MANUAL_BLOCKED";
  const controlAction = sessionManuallyBlocked ? "RESUME" : "BLOCK";
  const confirmation = pending?.kind === "PROFILE"
    ? {
        body: pending.profile === "STANDARD"
          ? "Standard permits a higher sustained send rate. Existing circuit breakers, recipient limits, and final commit fences remain enforced."
          : "Canary lowers throughput immediately for future operations; work already committed upstream is not interrupted.",
        confirmLabel: `Use ${pending.profile === "STANDARD" ? "Standard" : "Canary"}`,
        title: "Change safety profile?",
        variant: pending.profile === "STANDARD" ? "danger" as const : "primary" as const,
      }
    : pending?.action === "BLOCK"
      ? {
          body: "New sends and protected OpenWA operations for this session will stop. Work already committed upstream cannot be recalled.",
          confirmLabel: "Block session",
          title: "Block OpenWA operations?",
          variant: "danger" as const,
        }
      : {
          body: "Runtime will re-enable admission through the configured pacing limits. A parent workspace or upstream cooldown may still keep operations stopped.",
          confirmLabel: "Resume session",
          title: "Resume automatic control?",
          variant: "primary" as const,
        };

  if (!api || !sessionId) {
    return (
      <SettingsSection
        action={<Badge tone="neutral">Unavailable</Badge>}
        description="Select a synchronized OpenWA session to inspect and control its outbound protection."
        kicker="Outbound protection"
        title="OpenWA safety"
        titleId="openwa-safety-title"
      >
        <InlineAlert className="settings-safety-empty" title="No active session" tone="neutral">
          Open Sessions and select a session before changing safety controls.
        </InlineAlert>
      </SettingsSection>
    );
  }

  return (
    <div className="settings-panel-stack">
      {error && (
        <InlineAlert
          action={<Button disabled={loading} onClick={() => void load()} size="sm">Retry</Button>}
          className="settings-notice"
          title="Safety state could not be refreshed"
        >
          {error}
        </InlineAlert>
      )}

      <SettingsSection
        action={presentation
          ? <Badge tone={presentation.tone} variant="status">{presentation.label}</Badge>
          : <Badge tone="neutral">{loading ? "Inspecting" : "Unavailable"}</Badge>}
        description="One admission governor protects sends, group synchronization, contacts, webhooks, and recovery probes without changing OpenWA."
        kicker="Outbound protection"
        title="OpenWA safety"
        titleId="openwa-safety-title"
      >
        <SettingsRow
          action={<span className="settings-row-value">{sessionName ?? sessionId}</span>}
          description={sessionId}
          label="Protected session"
        />
        <SettingsRow
          action={snapshot && <span className="settings-row-value">{scopeLabel(snapshot.effectiveScopeType)}</span>}
          description={presentation?.description ?? "Reading the effective workspace, upstream, and session state."}
          label="Effective control"
        />
        <SettingsRow
          action={snapshot && (
            <SelectMenu
              containerClassName="settings-safety-profile"
              disabled={loading || mutating}
              label="Safety profile"
              labelHidden
              onChange={profile => {
                if (profile !== snapshot.profile) setPending({ kind: "PROFILE", profile });
              }}
              options={PROFILE_OPTIONS}
              size="sm"
              value={snapshot.profile}
            />
          )}
          description="Canary is the safe default; Standard should follow a stable observation period."
          label="Pacing profile"
        />
        <SettingsRow
          action={<span className="settings-row-value">v{snapshot?.policyVersion ?? "—"}</span>}
          description={snapshot?.reason ? `Reason: ${snapshot.reason}` : "No active safety intervention."}
          label="Policy"
        />
        <SettingsRow
          action={<span className="settings-row-value">{formatTimestamp(snapshot?.lastSuccessAt ?? null)}</span>}
          description={snapshot?.cooldownUntil
            ? `Cooldown ends ${formatTimestamp(snapshot.cooldownUntil)}.`
            : `Last failure: ${formatTimestamp(snapshot?.lastFailureAt ?? null)}.`}
          label="Latest outcome"
        />
      </SettingsSection>

      <SettingsSection
        action={snapshot && (
          <Button
            disabled={loading || mutating}
            onClick={() => setPending({ kind: "CONTROL", action: controlAction })}
            variant={controlAction === "BLOCK" ? "danger" : "primary"}
          >
            {controlAction === "BLOCK" ? "Block session" : "Resume session"}
          </Button>
        )}
        description="Manual control is session-scoped and durable across Runtime restarts. Parent safety controls remain authoritative."
        kicker="Operator control"
        title="Emergency stop"
        titleId="openwa-safety-control-title"
      >
        <InlineAlert className="settings-safety-guidance" title="Committed work is never recalled" tone="neutral">
          Blocking prevents new upstream commits. An outcome already submitted to OpenWA continues through reconciliation so Runtime does not create an unsafe duplicate.
        </InlineAlert>
      </SettingsSection>

      <ConfirmationDialog
        body={confirmation.body}
        busy={mutating}
        busyLabel="Applying…"
        confirmLabel={confirmation.confirmLabel}
        confirmVariant={confirmation.variant}
        error={mutationError}
        errorTitle="Safety control failed"
        onCancel={() => { if (!mutating) { setPending(null); setMutationError(null); } }}
        onConfirm={() => void applyMutation()}
        open={pending !== null}
        title={confirmation.title}
      />
    </div>
  );
}
