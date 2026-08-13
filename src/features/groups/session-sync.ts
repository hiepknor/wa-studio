import type { RuntimeSyncRun } from "@/shared/api/runtime-client";

export const SESSION_SYNC_POLL_DELAYS_MS = [
  1_000,
  2_000,
  3_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
] as const;

type SessionSyncPollResult =
  | { status: "completed"; run: RuntimeSyncRun }
  | { status: "failed"; run: RuntimeSyncRun }
  | { status: "background"; run: RuntimeSyncRun; error?: unknown }
  | { status: "cancelled"; run: RuntimeSyncRun };

interface PollSessionSyncOptions {
  initialRun: RuntimeSyncRun;
  onObservation: (run: RuntimeSyncRun) => void;
  read: () => Promise<RuntimeSyncRun>;
  signal: AbortSignal;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export async function pollSessionSync({
  initialRun,
  onObservation,
  read,
  signal,
  wait = abortableWait,
}: PollSessionSyncOptions): Promise<SessionSyncPollResult> {
  let latestRun = initialRun;
  let latestError: unknown;

  if (initialRun.status === "COMPLETED") return { status: "completed", run: initialRun };
  if (initialRun.status === "FAILED") return { status: "failed", run: initialRun };

  for (const delay of SESSION_SYNC_POLL_DELAYS_MS) {
    try {
      await wait(delay, signal);
      if (signal.aborted) return { status: "cancelled", run: latestRun };
      latestRun = await read();
      if (signal.aborted) return { status: "cancelled", run: latestRun };
      latestError = undefined;
      onObservation(latestRun);
      if (latestRun.status === "COMPLETED") return { status: "completed", run: latestRun };
      if (latestRun.status === "FAILED") return { status: "failed", run: latestRun };
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return { status: "cancelled", run: latestRun };
      }
      latestError = error;
    }
  }

  return { status: "background", run: latestRun, ...(latestError ? { error: latestError } : {}) };
}
