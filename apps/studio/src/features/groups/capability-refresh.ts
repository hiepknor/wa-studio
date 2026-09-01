import type { RuntimeGroupCapabilityRefresh } from "@/shared/api/runtime-client";

export const CAPABILITY_REFRESH_POLL_DELAYS_MS = [
  500,
  1_000,
  2_000,
  3_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
] as const;

export type CapabilityRefreshPollResult =
  | { status: "completed"; operation: RuntimeGroupCapabilityRefresh }
  | { status: "failed"; operation: RuntimeGroupCapabilityRefresh }
  | {
      status: "background";
      operation: RuntimeGroupCapabilityRefresh;
      error: unknown | null;
    }
  | { status: "cancelled" };

export function capabilityRefreshIsActive(
  operation: RuntimeGroupCapabilityRefresh | null,
): operation is RuntimeGroupCapabilityRefresh {
  return operation?.status === "PENDING"
    || operation?.status === "RUNNING"
    || operation?.status === "RETRYING";
}

function terminalResult(
  operation: RuntimeGroupCapabilityRefresh,
): CapabilityRefreshPollResult | null {
  if (operation.status === "COMPLETED") {
    return { status: "completed", operation };
  }
  if (operation.status === "FAILED") {
    return { status: "failed", operation };
  }
  return null;
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
  initialOperation: RuntimeGroupCapabilityRefresh;
  signal: AbortSignal;
  read: () => Promise<RuntimeGroupCapabilityRefresh>;
  onObservation: (operation: RuntimeGroupCapabilityRefresh) => void;
  delays?: readonly number[];
}

export async function pollCapabilityRefresh({
  initialOperation,
  signal,
  read,
  onObservation,
  delays = CAPABILITY_REFRESH_POLL_DELAYS_MS,
}: PollCapabilityRefreshInput): Promise<CapabilityRefreshPollResult> {
  const initialResult = terminalResult(initialOperation);
  if (initialResult) return initialResult;

  let latest = initialOperation;
  let lastError: unknown | null = null;
  for (const delay of delays) {
    if (!await waitForPoll(delay, signal) || signal.aborted) {
      return { status: "cancelled" };
    }
    try {
      const operation = await read();
      if (signal.aborted) return { status: "cancelled" };
      latest = operation;
      lastError = null;
      onObservation(operation);
      const result = terminalResult(operation);
      if (result) return result;
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      lastError = error;
    }
  }

  return { status: "background", operation: latest, error: lastError };
}
