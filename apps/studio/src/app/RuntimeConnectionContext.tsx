import {
  PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  normalizeRuntimeConnection,
  normalizeRuntimeProfile,
  probeRuntimeConnection,
  RuntimeApi,
  type RuntimeConnectionInput,
  type RuntimeConnectionProfile,
} from "@/shared/api/runtime-client";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { useLatestOperation } from "@/shared/hooks/useLatestOperation";
import { useLatestRequest } from "@/shared/hooks/useLatestRequest";
import { RuntimeInvalidationProvider } from "@/shared/server-state/runtime-invalidation";
import {
  getManagedRuntimeState,
  provisionManagedRuntime,
  reconfigureManagedRuntime,
  subscribeManagedRuntimeState,
  type ManagedRuntimeProvisioningInput,
  type ManagedRuntimeSnapshot,
} from "@/shared/native/managed-runtime";
import {
  RuntimeConnectionContext,
  type ConnectedRuntime,
  type ManagedConnectionFlow,
} from "./RuntimeConnectionState";

export { useRuntimeConnection } from "./RuntimeConnectionState";

interface RuntimeConnectionProviderProps extends PropsWithChildren {
  createApi?: (profile: RuntimeConnectionProfile) => RuntimeApi;
  discoverManagedRuntime?: typeof getManagedRuntimeState;
  probeConnection?: typeof probeRuntimeConnection;
  provisionRuntime?: typeof provisionManagedRuntime;
  reconfigureRuntime?: typeof reconfigureManagedRuntime;
  subscribeToManagedRuntime?: typeof subscribeManagedRuntimeState;
}

function defaultCreateApi(profile: RuntimeConnectionProfile): RuntimeApi {
  return new RuntimeApi(profile);
}

const DISCOVERING_MANAGED_RUNTIME: ManagedRuntimeSnapshot = {
  phase: "discovering",
  manifest: null,
  connection: null,
  error: null,
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function supersededRequestError(signal: AbortSignal): Error {
  if (isAbortError(signal.reason)) return signal.reason;
  const error = new Error("The connection request was superseded.");
  error.name = "AbortError";
  return error;
}

export function RuntimeConnectionProvider({
  children,
  createApi = defaultCreateApi,
  discoverManagedRuntime = getManagedRuntimeState,
  probeConnection = probeRuntimeConnection,
  provisionRuntime = provisionManagedRuntime,
  reconfigureRuntime = reconfigureManagedRuntime,
  subscribeToManagedRuntime = subscribeManagedRuntimeState,
}: RuntimeConnectionProviderProps) {
  const [connected, setConnected] = useState<ConnectedRuntime | null>(null);
  const [managedRuntime, setManagedRuntime] = useState<ManagedRuntimeSnapshot>(
    DISCOVERING_MANAGED_RUNTIME,
  );
  const [managedConnectionFlow, setManagedConnectionFlowState] =
    useState<ManagedConnectionFlow>("booting");
  const [managedConnectionError, setManagedConnectionError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const connectionRevision = useRef(0);
  const managedConfigurationInFlight = useRef(false);
  const managedConnectionInFlight = useRef<string | null>(null);
  const managedConnectionFlowRef = useRef<ManagedConnectionFlow>("booting");
  const managedConfigurationOperation = useLatestOperation();
  const connectionRead = useLatestRequest();
  const sessionsRead = useLatestRequest();

  const setManagedConnectionFlow = useCallback((flow: ManagedConnectionFlow) => {
    managedConnectionFlowRef.current = flow;
    setManagedConnectionFlowState(flow);
  }, []);

  const attach = useCallback(
    async (input: RuntimeConnectionProfile) => {
      const revision = ++connectionRevision.current;
      const signal = connectionRead.begin();
      try {
        const result = await probeConnection(input, undefined, { signal });
        if (
          revision !== connectionRevision.current
          || !connectionRead.isCurrent(signal)
        ) throw supersededRequestError(signal);
        const profile = normalizeRuntimeProfile(input);
        setConnected({ api: createApi(profile), profile, sessions: result.sessions });
        setManagedConnectionFlow("connected");
        setSelectedSessionId(
          result.sessions.find((session) => session.status === "ready")?.id ??
            result.sessions[0]?.id ??
            null,
        );
        return result;
      } catch (error) {
        if (
          revision !== connectionRevision.current
          || !connectionRead.isCurrent(signal)
        ) throw supersededRequestError(signal);
        throw error;
      } finally {
        connectionRead.complete(signal);
      }
    },
    [connectionRead, createApi, probeConnection, setManagedConnectionFlow],
  );

  const connect = useCallback(
    (input: RuntimeConnectionInput) => attach(normalizeRuntimeConnection(input)),
    [attach],
  );

  const configureManagedRuntime = useCallback(async (input: ManagedRuntimeProvisioningInput) => {
    if (managedConfigurationInFlight.current) {
      throw new Error("Managed Runtime configuration is already in progress.");
    }
    managedConfigurationInFlight.current = true;
    const token = managedConfigurationOperation.begin();
    setManagedConnectionError(null);
    setManagedConnectionFlow("validating");
    try {
      if (managedRuntime.phase === "ready") await reconfigureRuntime(input);
      else await provisionRuntime(input);
      if (
        managedConfigurationOperation.isCurrent(token)
        && managedConnectionFlowRef.current === "validating"
      ) {
        setManagedConnectionFlow("starting");
      }
    } catch (error) {
      if (managedConfigurationOperation.isCurrent(token)) {
        setManagedConnectionError(userFacingErrorMessage(
          error,
          "Could not connect to OpenWA.",
          [input.openwaApiKey],
        ));
        setManagedConnectionFlow("error");
      }
      throw error;
    } finally {
      managedConfigurationInFlight.current = false;
    }
  }, [
    managedConfigurationOperation,
    managedRuntime.phase,
    provisionRuntime,
    reconfigureRuntime,
    setManagedConnectionFlow,
  ]);

  useEffect(() => {
    let disposed = false;
    let receivedManagedEvent = false;
    let unlisten: (() => void) | undefined;

    const acceptManagedRuntime = (snapshot: ManagedRuntimeSnapshot) => {
      if (disposed) return;
      setManagedRuntime(snapshot);
      if (snapshot.phase === "unavailable") {
        setManagedConnectionFlow("manual");
        return;
      }
      if (snapshot.phase === "degraded") {
        setManagedConnectionError(snapshot.error ?? "Local Runtime could not start.");
        setManagedConnectionFlow("error");
        return;
      }
      if (snapshot.phase === "provisioningRequired") {
        if (managedConnectionFlowRef.current === "booting") setManagedConnectionFlow("configure");
        return;
      }
      if (snapshot.phase !== "ready") {
        if (managedConnectionFlowRef.current === "configure") return;
        if (managedConnectionFlowRef.current !== "validating") setManagedConnectionFlow("starting");
        return;
      }
      if (
        !snapshot.connection
        || managedConnectionFlowRef.current === "configure"
        || managedConnectionFlowRef.current === "error"
      ) return;
      const connection = snapshot.connection;
      const fingerprint = `${connection.transport}\n${connection.baseUrl}`;
      if (managedConnectionInFlight.current === fingerprint) return;
      managedConnectionInFlight.current = fingerprint;
      setManagedConnectionError(null);
      setManagedConnectionFlow("attaching");
      void attach(connection).catch((error: unknown) => {
        if (
          disposed
          || isAbortError(error)
          || managedConnectionInFlight.current !== fingerprint
        ) return;
        setManagedConnectionError(userFacingErrorMessage(
          error,
          "Could not connect to managed Runtime.",
        ));
        setManagedConnectionFlow("error");
        managedConnectionInFlight.current = null;
      });
    };

    void subscribeToManagedRuntime(snapshot => {
      receivedManagedEvent = true;
      acceptManagedRuntime(snapshot);
    })
      .then(dispose => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    void discoverManagedRuntime()
      .then(snapshot => {
        if (!receivedManagedEvent) acceptManagedRuntime(snapshot);
      })
      .catch(() => {
        if (!disposed && !receivedManagedEvent) {
          setManagedRuntime({
            phase: "unavailable",
            manifest: null,
            connection: null,
            error: null,
          });
          setManagedConnectionFlow("manual");
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [attach, discoverManagedRuntime, setManagedConnectionFlow, subscribeToManagedRuntime]);

  const disconnect = useCallback(() => {
    connectionRead.cancel();
    sessionsRead.cancel();
    connectionRevision.current += 1;
    managedConnectionInFlight.current = null;
    setConnected(null);
    setManagedConnectionError(null);
    setManagedConnectionFlow(managedRuntime.phase === "unavailable" ? "manual" : "configure");
    setSelectedSessionId(null);
  }, [connectionRead, managedRuntime.phase, sessionsRead, setManagedConnectionFlow]);

  const refreshSessions = useCallback(async () => {
    if (!connected) return false;
    const revision = connectionRevision.current;
    const signal = sessionsRead.begin();
    try {
      const sessions = await connected.api.listSessions({ signal });
      if (
        revision !== connectionRevision.current
        || !sessionsRead.isCurrent(signal)
      ) return false;
      setConnected((current) => (current ? { ...current, sessions } : current));
      setSelectedSessionId((current) =>
        current && sessions.some((session) => session.id === current)
          ? current
          : sessions.find((session) => session.status === "ready")?.id ??
            sessions[0]?.id ??
            null,
      );
      return true;
    } catch (error) {
      if (
        revision !== connectionRevision.current
        || !sessionsRead.isCurrent(signal)
      ) return false;
      throw error;
    } finally {
      sessionsRead.complete(signal);
    }
  }, [connected, sessionsRead]);

  const value = useMemo(
    () => ({
      connect,
      configureManagedRuntime,
      connected,
      disconnect,
      managedConnectionFlow,
      managedConnectionError,
      managedRuntime,
      refreshSessions,
      selectedSessionId,
      selectSession: setSelectedSessionId,
    }),
    [
      connect,
      configureManagedRuntime,
      connected,
      disconnect,
      managedConnectionFlow,
      managedConnectionError,
      managedRuntime,
      refreshSessions,
      selectedSessionId,
    ],
  );

  return (
    <RuntimeConnectionContext.Provider value={value}>
      <RuntimeInvalidationProvider
        api={connected?.api}
        key={connected?.profile.baseUrl ?? "disconnected"}
        onSessionsChanged={refreshSessions}
        sessionId={selectedSessionId}
      >
        {children}
      </RuntimeInvalidationProvider>
    </RuntimeConnectionContext.Provider>
  );
}
