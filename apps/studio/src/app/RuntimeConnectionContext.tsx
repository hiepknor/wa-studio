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
  const managedConnectionInFlight = useRef<string | null>(null);
  const managedConnectionFlowRef = useRef<ManagedConnectionFlow>("booting");

  const setManagedConnectionFlow = useCallback((flow: ManagedConnectionFlow) => {
    managedConnectionFlowRef.current = flow;
    setManagedConnectionFlowState(flow);
  }, []);

  const attach = useCallback(
    async (input: RuntimeConnectionProfile) => {
      const revision = ++connectionRevision.current;
      const result = await probeConnection(input);
      if (revision !== connectionRevision.current) return result;
      const profile = normalizeRuntimeProfile(input);
      setConnected({ api: createApi(profile), profile, sessions: result.sessions });
      setManagedConnectionFlow("connected");
      setSelectedSessionId(
        result.sessions.find((session) => session.status === "ready")?.id ??
          result.sessions[0]?.id ??
          null,
      );
      return result;
    },
    [createApi, probeConnection, setManagedConnectionFlow],
  );

  const connect = useCallback(
    (input: RuntimeConnectionInput) => attach(normalizeRuntimeConnection(input)),
    [attach],
  );

  const configureManagedRuntime = useCallback(async (input: ManagedRuntimeProvisioningInput) => {
    setManagedConnectionError(null);
    setManagedConnectionFlow("validating");
    try {
      if (managedRuntime.phase === "ready") await reconfigureRuntime(input);
      else await provisionRuntime(input);
      if (managedConnectionFlowRef.current === "validating") {
        setManagedConnectionFlow("starting");
      }
    } catch (error) {
      setManagedConnectionError(
        error instanceof Error ? error.message : "Could not connect to OpenWA.",
      );
      setManagedConnectionFlow("error");
      throw error;
    }
  }, [managedRuntime.phase, provisionRuntime, reconfigureRuntime, setManagedConnectionFlow]);

  useEffect(() => {
    let disposed = false;
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
        setManagedConnectionError(
          error instanceof Error ? error.message : "Could not connect to managed Runtime.",
        );
        setManagedConnectionFlow("error");
        if (managedConnectionInFlight.current === fingerprint) {
          managedConnectionInFlight.current = null;
        }
      });
    };

    void subscribeToManagedRuntime(acceptManagedRuntime)
      .then(dispose => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    void discoverManagedRuntime()
      .then(acceptManagedRuntime)
      .catch(() => {
        if (!disposed) {
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
    connectionRevision.current += 1;
    managedConnectionInFlight.current = null;
    setConnected(null);
    setManagedConnectionError(null);
    setManagedConnectionFlow(managedRuntime.phase === "unavailable" ? "manual" : "configure");
    setSelectedSessionId(null);
  }, [managedRuntime.phase, setManagedConnectionFlow]);

  const refreshSessions = useCallback(async () => {
    if (!connected) return;
    const revision = connectionRevision.current;
    const sessions = await connected.api.listSessions();
    if (revision !== connectionRevision.current) return;
    setConnected((current) => (current ? { ...current, sessions } : current));
    setSelectedSessionId((current) =>
      current && sessions.some((session) => session.id === current)
        ? current
        : sessions.find((session) => session.status === "ready")?.id ??
          sessions[0]?.id ??
          null,
    );
  }, [connected]);

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
      {children}
    </RuntimeConnectionContext.Provider>
  );
}
