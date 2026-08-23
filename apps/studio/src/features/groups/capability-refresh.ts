import type { RuntimeGroup, RuntimeGroupDetail } from "@/shared/api/runtime-client";

type Capability = RuntimeGroup["sendCapability"];

export const CAPABILITY_REFRESH_POLL_DELAYS_MS = [500, 1_000, 2_000, 3_000, 4_000] as const;

export type CapabilityRefreshPollResult =
  | { status: "completed"; detail: RuntimeGroupDetail }
  | { status: "failed"; detail: RuntimeGroupDetail }
  | { status: "timed-out"; detail: RuntimeGroupDetail | null; error: unknown | null }
  | { status: "cancelled" };

export function capabilityRefreshCompleted(
  baseline: Capability,
  current: Capability,
): boolean {
  if (!current.checkedAt || current.invalidatedAt) return false;
  if (!baseline.checkedAt) return true;
  return new Date(current.checkedAt).getTime() > new Date(baseline.checkedAt).getTime();
}

function waitForPoll(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve(true);
    }, delayMs);
    function cancel() {
      window.clearTimeout(timeout);
      resolve(false);
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

interface PollCapabilityRefreshInput {
  baseline: Capability;
  signal: AbortSignal;
  read: () => Promise<RuntimeGroupDetail>;
  onObservation: (detail: RuntimeGroupDetail) => void;
  delays?: readonly number[];
}

export async function pollCapabilityRefresh({
  baseline,
  signal,
  read,
  onObservation,
  delays = CAPABILITY_REFRESH_POLL_DELAYS_MS,
}: PollCapabilityRefreshInput): Promise<CapabilityRefreshPollResult> {
  let latest: RuntimeGroupDetail | null = null;
  let lastError: unknown | null = null;

  for (const delay of delays) {
    if (!await waitForPoll(delay, signal) || signal.aborted) return { status: "cancelled" };
    try {
      const detail = await read();
      if (signal.aborted) return { status: "cancelled" };
      latest = detail;
      lastError = null;
      onObservation(detail);
      if (!capabilityRefreshCompleted(baseline, detail.sendCapability)) continue;
      return detail.sendCapability.reason === "REFRESH_FAILED"
        ? { status: "failed", detail }
        : { status: "completed", detail };
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      lastError = error;
    }
  }

  return { status: "timed-out", detail: latest, error: lastError };
}
