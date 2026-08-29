import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useState,
} from "react";
import type { RuntimeApi, RuntimeStateRevisions } from "@/shared/api/runtime-client";

export const RUNTIME_RESOURCES = [
  "sessions",
  "groups",
  "groupLists",
  "campaigns",
  "runs",
  "deliveries",
  "activity",
] as const;

export type RuntimeResource = typeof RUNTIME_RESOURCES[number];

interface RuntimeInvalidationInput {
  resources: readonly RuntimeResource[];
  sessionId?: string | null;
}

interface RuntimeInvalidationContextValue {
  invalidate: (input: RuntimeInvalidationInput) => void;
  revisions: Readonly<Record<string, number>>;
}

const RuntimeInvalidationContext = createContext<RuntimeInvalidationContextValue | null>(null);

function revisionKey(resource: RuntimeResource, sessionId?: string | null): string {
  return `${resource}:${sessionId ?? "*"}`;
}

interface RuntimeInvalidationProviderProps extends PropsWithChildren {
  api?: RuntimeApi | null;
  onSessionsChanged?: () => void | Promise<unknown>;
  sessionId?: string | null;
}

type RemoteRevisionVector = Omit<RuntimeStateRevisions, "sessionId">;

export function RuntimeInvalidationProvider({
  api = null,
  children,
  onSessionsChanged,
  sessionId = null,
}: RuntimeInvalidationProviderProps) {
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const onSessionsChangedRef = useRef(onSessionsChanged);
  onSessionsChangedRef.current = onSessionsChanged;
  const invalidate = useCallback((input: RuntimeInvalidationInput) => {
    if (!input.resources.length) return;
    setRevisions((current) => {
      const next = { ...current };
      input.resources.forEach((resource) => {
        const key = revisionKey(resource, input.sessionId);
        next[key] = (next[key] ?? 0) + 1;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    // A few focused component tests use partial RuntimeApi doubles. The real client
    // always exposes this method, but those doubles should not start a broken poller.
    if (!api || typeof api.getStateRevisions !== "function") return;
    let disposed = false;
    let timeout: number | undefined;
    let activeController: AbortController | null = null;
    let previous: RemoteRevisionVector | null = null;

    const schedule = () => {
      if (disposed) return;
      timeout = window.setTimeout(
        read,
        document.visibilityState === "visible" ? 3_000 : 15_000,
      );
    };
    const read = async () => {
      if (disposed || activeController) return;
      timeout = undefined;
      const controller = new AbortController();
      activeController = controller;
      try {
        const snapshot = await api.getStateRevisions(sessionId, { signal: controller.signal });
        if (disposed || controller.signal.aborted || snapshot.sessionId !== sessionId) return;
        const next: RemoteRevisionVector = {
          activity: snapshot.activity,
          campaigns: snapshot.campaigns,
          deliveries: snapshot.deliveries,
          groupLists: snapshot.groupLists,
          groups: snapshot.groups,
          runs: snapshot.runs,
          sessions: snapshot.sessions,
        };
        const changed = RUNTIME_RESOURCES.filter(
          resource => (resource === "sessions" || sessionId !== null)
            && (previous === null || previous[resource] !== next[resource]),
        );
        previous = next;
        const sessionResources = changed.filter(resource => resource !== "sessions");
        if (sessionResources.length) invalidate({ resources: sessionResources, sessionId });
        if (changed.includes("sessions")) {
          invalidate({ resources: ["sessions"] });
          try {
            void Promise.resolve(onSessionsChangedRef.current?.()).catch(() => undefined);
          } catch {
            // Session reconciliation is retried by the next revision observation.
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        // Revision polling is reconciliation-only; foreground queries own user-facing errors.
      } finally {
        if (activeController === controller) activeController = null;
        schedule();
      }
    };
    const readWhenVisible = () => {
      if (document.visibilityState !== "visible" || activeController) return;
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
        timeout = undefined;
      }
      void read();
    };
    document.addEventListener("visibilitychange", readWhenVisible);
    window.addEventListener("focus", readWhenVisible);
    void read();
    return () => {
      disposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      activeController?.abort(new DOMException("Runtime revision polling stopped.", "AbortError"));
      document.removeEventListener("visibilitychange", readWhenVisible);
      window.removeEventListener("focus", readWhenVisible);
    };
  }, [api, invalidate, sessionId]);

  const value = useMemo(() => ({ invalidate, revisions }), [invalidate, revisions]);
  return (
    <RuntimeInvalidationContext.Provider value={value}>
      {children}
    </RuntimeInvalidationContext.Provider>
  );
}

export function useRuntimeInvalidation(): RuntimeInvalidationContextValue {
  const value = useContext(RuntimeInvalidationContext);
  if (!value) {
    throw new Error("useRuntimeInvalidation must be used inside RuntimeInvalidationProvider");
  }
  return value;
}

export function useRuntimeResourceRevision(
  resources: readonly RuntimeResource[],
  sessionId?: string | null,
): string {
  const { revisions } = useRuntimeInvalidation();
  return resources.map((resource) => [
    resource,
    revisions[revisionKey(resource)] ?? 0,
    revisions[revisionKey(resource, sessionId)] ?? 0,
  ].join(":"))
    .join("|");
}
