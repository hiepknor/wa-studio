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
  | { kind: "OUTBOUND"; action: "PAUSE" | "RESUME" }
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
        : pending.kind === "OUTBOUND"
          ? await api.controlOpenWAOutbound(
            sessionId,
            pending.action,
            crypto.randomUUID(),
            pending.action === "PAUSE" ? "OPERATOR_PAUSED_SENDS_FROM_STUDIO" : undefined,
          )
        : await api.setOpenWASafetyProfile(sessionId, pending.profile, crypto.randomUUID());
      setSnapshot(next);
      setPending(null);
      notify({
        description: pending.kind === "PROFILE"
          ? `Future operations will use the ${pending.profile.toLowerCase()} pacing profile.`
          : pending.kind === "OUTBOUND"
            ? pending.action === "PAUSE"
              ? "New message commits are paused; synchronization and reconciliation continue."
              : "New messages are admitted through the existing safety limits again."
          : pending.action === "BLOCK"
              ? "All new OpenWA operations for this session are now blocked."
              : "The session has returned to automatic safety control.",
        title: pending.kind === "PROFILE"
          ? "Safety profile updated"
          : pending.kind === "OUTBOUND"
            ? pending.action === "PAUSE" ? "Outbound sending paused" : "Outbound sending resumed"
          : pending.action === "BLOCK"
              ? "Session locked"
              : "Session unlocked",
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
  const outboundAction = snapshot?.outboundState === "PAUSED" ? "RESUME" : "PAUSE";
  const confirmation = pending?.kind === "PROFILE"
    ? {
        body: pending.profile === "STANDARD"
          ? "Standard permits a higher sustained send rate. Existing circuit breakers, recipient limits, and final commit fences remain enforced."
          : "Canary lowers throughput immediately for future operations; work already committed upstream is not interrupted.",
        confirmLabel: `Use ${pending.profile === "STANDARD" ? "Standard" : "Canary"}`,
        title: "Change safety profile?",
        variant: pending.profile === "STANDARD" ? "danger" as const : "primary" as const,
      }
    : pending?.kind === "OUTBOUND"
      ? pending.action === "PAUSE"
        ? {
            body: "New message admissions and final OpenWA commits will stop for this session. Synchronization, connector health, delivery evidence, and reconciliation continue. Work already committed upstream cannot be recalled.",
            confirmLabel: "Pause sends",
            title: "Pause outbound sending?",
            variant: "danger" as const,
          }
        : {
            body: "New messages will be admitted through the unchanged circuit breaker, pacing budgets, and recipient limits. Existing cooldowns remain authoritative.",
            confirmLabel: "Resume sends",
            title: "Resume outbound sending?",
            variant: "primary" as const,
          }
    : pending?.action === "BLOCK"
      ? {
          body: "New sends and protected OpenWA operations for this session will stop. Work already committed upstream cannot be recalled.",
          confirmLabel: "Lock all operations",
          title: "Lock all OpenWA operations?",
          variant: "danger" as const,
        }
      : {
          body: "Runtime will re-enable admission through the configured pacing limits. A parent workspace or upstream cooldown may still keep operations stopped.",
          confirmLabel: "Unlock operations",
          title: "Unlock OpenWA operations?",
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
          <div className="settings-section-actions">
            <Badge
              tone={snapshot.outboundState === "PAUSED" ? "warning" : "success"}
              variant="status"
            >
              {snapshot.outboundState === "PAUSED" ? "Paused" : "Sending"}
            </Badge>
            <Button
              disabled={loading || mutating}
              onClick={() => setPending({ kind: "OUTBOUND", action: outboundAction })}
              variant={outboundAction === "PAUSE" ? "secondary" : "primary"}
            >
              {outboundAction === "PAUSE" ? "Pause sends" : "Resume sends"}
            </Button>
          </div>
        )}
        description="Stops message admission without interrupting the operational signals Runtime needs to remain safe and observable."
        kicker="Operator control"
        title="Outbound sending"
        titleId="openwa-outbound-control-title"
      >
        <InlineAlert
          className="settings-safety-guidance"
          title={snapshot?.outboundState === "PAUSED" ? "New message commits are paused" : "Operational traffic stays active"}
          tone={snapshot?.outboundState === "PAUSED" ? "warning" : "neutral"}
        >
          {snapshot?.outboundState === "PAUSED"
            ? `${snapshot.outboundPauseReason ?? "Paused by an operator"}. Paused ${formatTimestamp(snapshot.outboundPausedAt)}.`
            : "Group sync, health probes, connector evidence, and delivery reconciliation remain available when message sends are paused."}
        </InlineAlert>
      </SettingsSection>

      <SettingsSection
        action={snapshot && (
          <Button
            disabled={loading || mutating}
            onClick={() => setPending({ kind: "CONTROL", action: controlAction })}
            variant={controlAction === "BLOCK" ? "danger" : "primary"}
          >
            {controlAction === "BLOCK" ? "Lock all operations" : "Unlock operations"}
          </Button>
        )}
        description="A durable maintenance lock for every protected OpenWA operation in this session. Parent controls remain authoritative."
        kicker="Maintenance"
        title="OpenWA operation lock"
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
