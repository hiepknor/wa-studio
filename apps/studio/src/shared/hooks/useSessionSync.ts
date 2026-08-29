import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeApi, RuntimeSyncRun } from "@/shared/api/runtime-client";
import {
  isUnknownMutationOutcome,
  unknownMutationOutcomeMessage,
} from "@/shared/api/runtime-mutation";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { pollSessionSync } from "./session-sync-poller";

export type SessionSyncState =
  | "idle"
  | "requesting"
  | "running"
  | "updating"
  | "background"
  | "unknown"
  | "failed";

export type SessionSyncResult =
  | { status: "completed"; run: RuntimeSyncRun; warning?: string }
  | { status: "failed"; run: RuntimeSyncRun | null; error: string }
  | { status: "unknown"; run: null; error: string }
  | { status: "background"; run: RuntimeSyncRun };

interface UseSessionSyncOptions {
  onCompleted?: (run: RuntimeSyncRun) => Promise<string | void>;
  runtimeApi: RuntimeApi;
  runtimeOrigin: string;
  sessionId: string | null;
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
  const activeRevisionRef = useRef<number | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const targetRef = useRef({ runtimeOrigin, sessionId });
  const completedRef = useRef(onCompleted);
  targetRef.current = { runtimeOrigin, sessionId };
  completedRef.current = onCompleted;

  const cancel = useCallback(() => {
    revisionRef.current += 1;
    activeRevisionRef.current = null;
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
    idempotencyKeyRef.current = null;
    setState("idle");
    setRun(null);
    setError(null);
  }, [cancel]);

  useEffect(() => reset(), [reset, runtimeApi, runtimeOrigin, sessionId]);
  useEffect(() => () => cancel(), [cancel]);

  const start = useCallback(async (): Promise<SessionSyncResult | null> => {
    if (!sessionId || activeRevisionRef.current !== null) return null;

    cancel();
    const revision = revisionRef.current;
    activeRevisionRef.current = revision;
    const origin = runtimeOrigin;
    const id = sessionId;
    const controller = new AbortController();
    const idempotencyKey = idempotencyKeyRef.current ?? crypto.randomUUID();
    idempotencyKeyRef.current = idempotencyKey;
    abortRef.current = controller;
    setState("requesting");
    setRun(null);
    setError(null);

    try {
      const initialRun = await runtimeApi.requestSessionSync(id, idempotencyKey);
      idempotencyKeyRef.current = null;
      if (!flowIsCurrent(revision, origin, id)) return null;
      setRun(initialRun);
      setState("running");

      const result = await pollSessionSync({
        initialRun,
        signal: controller.signal,
        read: () => runtimeApi.getSessionSyncRun(id, initialRun.id, {
          signal: controller.signal,
        }),
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
          warning = userFacingErrorMessage(
            completionError,
            "The synchronized view could not be updated.",
          );
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
      const outcomeUnknown = isUnknownMutationOutcome(requestError);
      if (!outcomeUnknown) idempotencyKeyRef.current = null;
      const message = outcomeUnknown
        ? unknownMutationOutcomeMessage("idempotent-retry")
        : userFacingErrorMessage(requestError, "Could not start session sync.");
      setState(outcomeUnknown ? "unknown" : "failed");
      setError(message);
      return {
        status: outcomeUnknown ? "unknown" : "failed",
        run: null,
        error: message,
      };
    } finally {
      if (activeRevisionRef.current === revision) activeRevisionRef.current = null;
      if (flowIsCurrent(revision, origin, id)) abortRef.current = null;
    }
  }, [cancel, flowIsCurrent, runtimeApi, runtimeOrigin, sessionId]);

  return {
    active: state === "requesting" || state === "running" || state === "updating",
    error,
    reset,
    run,
    start,
    state,
  };
}
