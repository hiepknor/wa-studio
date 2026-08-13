import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeApi, RuntimeSyncRun } from "@/shared/api/runtime-client";
import { pollSessionSync } from "./session-sync-poller";

export type SessionSyncState =
  | "idle"
  | "requesting"
  | "running"
  | "updating"
  | "background"
  | "failed";

export type SessionSyncResult =
  | { status: "completed"; run: RuntimeSyncRun; warning?: string }
  | { status: "failed"; run: RuntimeSyncRun | null; error: string }
  | { status: "background"; run: RuntimeSyncRun };

interface UseSessionSyncOptions {
  onCompleted?: (run: RuntimeSyncRun) => Promise<string | void>;
  runtimeApi: RuntimeApi;
  runtimeOrigin: string;
  sessionId: string | null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useSessionSync({
  onCompleted,
  runtimeApi,
  runtimeOrigin,
  sessionId,
}: UseSessionSyncOptions) {
  const [state, setState] = useState<SessionSyncState>("idle");
  const [run, setRun] = useState<RuntimeSyncRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const targetRef = useRef({ runtimeOrigin, sessionId });
  const completedRef = useRef(onCompleted);
  targetRef.current = { runtimeOrigin, sessionId };
  completedRef.current = onCompleted;

  const cancel = useCallback(() => {
    revisionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const flowIsCurrent = useCallback((revision: number, origin: string, id: string) => {
    const target = targetRef.current;
    return revision === revisionRef.current
      && target.runtimeOrigin === origin
      && target.sessionId === id;
  }, []);

  const reset = useCallback(() => {
    cancel();
    setState("idle");
    setRun(null);
    setError(null);
  }, [cancel]);

  useEffect(() => reset(), [reset, runtimeApi, runtimeOrigin, sessionId]);
  useEffect(() => () => cancel(), [cancel]);

  const start = useCallback(async (): Promise<SessionSyncResult | null> => {
    const active = state === "requesting" || state === "running" || state === "updating";
    if (!sessionId || active) return null;

    cancel();
    const revision = revisionRef.current;
    const origin = runtimeOrigin;
    const id = sessionId;
    const controller = new AbortController();
    abortRef.current = controller;
    setState("requesting");
    setRun(null);
    setError(null);

    try {
      const initialRun = await runtimeApi.requestSessionSync(id);
      if (!flowIsCurrent(revision, origin, id)) return null;
      setRun(initialRun);
      setState("running");

      const result = await pollSessionSync({
        initialRun,
        signal: controller.signal,
        read: () => runtimeApi.getSessionSyncRun(id, initialRun.id),
        onObservation: (nextRun) => {
          if (flowIsCurrent(revision, origin, id)) setRun(nextRun);
        },
      });
      if (!flowIsCurrent(revision, origin, id) || result.status === "cancelled") return null;
      setRun(result.run);

      if (result.status === "completed") {
        setState("updating");
        let warning: string | undefined;
        try {
          warning = await completedRef.current?.(result.run) || undefined;
        } catch (completionError) {
          warning = errorMessage(completionError, "The synchronized view could not be updated.");
        }
        if (!flowIsCurrent(revision, origin, id)) return null;
        setState("idle");
        return { status: "completed", run: result.run, ...(warning ? { warning } : {}) };
      }

      if (result.status === "failed") {
        const message = result.run.error ?? "Retry when WA Runtime is ready.";
        setState("failed");
        setError(message);
        return { status: "failed", run: result.run, error: message };
      }

      setState("background");
      return { status: "background", run: result.run };
    } catch (requestError) {
      if (!flowIsCurrent(revision, origin, id)) return null;
      const message = errorMessage(requestError, "Could not start session sync.");
      setState("failed");
      setError(message);
      return { status: "failed", run: null, error: message };
    } finally {
      if (flowIsCurrent(revision, origin, id)) abortRef.current = null;
    }
  }, [cancel, flowIsCurrent, runtimeApi, runtimeOrigin, sessionId, state]);

  return {
    active: state === "requesting" || state === "running" || state === "updating",
    error,
    reset,
    run,
    start,
    state,
  };
}
