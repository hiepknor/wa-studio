import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  normalizeRuntimeConnection,
  probeRuntimeConnection,
  RuntimeApi,
  type RuntimeConnectionInput,
  type RuntimeConnectionResult,
  type RuntimeSession,
} from "@/shared/api/runtime-client";

interface ConnectedRuntime {
  api: RuntimeApi;
  profile: RuntimeConnectionInput;
  sessions: RuntimeSession[];
}

interface RuntimeConnectionContextValue {
  connect: (input: RuntimeConnectionInput) => Promise<RuntimeConnectionResult>;
  connected: ConnectedRuntime | null;
  disconnect: () => void;
  refreshSessions: () => Promise<void>;
  selectedSessionId: string | null;
  selectSession: (sessionId: string) => void;
}

interface RuntimeConnectionProviderProps extends PropsWithChildren {
  createApi?: (profile: RuntimeConnectionInput) => RuntimeApi;
  probeConnection?: typeof probeRuntimeConnection;
}

const RuntimeConnectionContext = createContext<RuntimeConnectionContextValue | null>(null);

function defaultCreateApi(profile: RuntimeConnectionInput): RuntimeApi {
  return new RuntimeApi(profile);
}

export function RuntimeConnectionProvider({
  children,
  createApi = defaultCreateApi,
  probeConnection = probeRuntimeConnection,
}: RuntimeConnectionProviderProps) {
  const [connected, setConnected] = useState<ConnectedRuntime | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const connectionRevision = useRef(0);

  const connect = useCallback(
    async (input: RuntimeConnectionInput) => {
      const revision = ++connectionRevision.current;
      const result = await probeConnection(input);
      if (revision !== connectionRevision.current) return result;
      const profile = normalizeRuntimeConnection(input);
      setConnected({ api: createApi(profile), profile, sessions: result.sessions });
      setSelectedSessionId(
        result.sessions.find((session) => session.status === "ready")?.id ??
          result.sessions[0]?.id ??
          null,
      );
      return result;
    },
    [createApi, probeConnection],
  );

  const disconnect = useCallback(() => {
    connectionRevision.current += 1;
    setConnected(null);
    setSelectedSessionId(null);
  }, []);

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
      connected,
      disconnect,
      refreshSessions,
      selectedSessionId,
      selectSession: setSelectedSessionId,
    }),
    [connect, connected, disconnect, refreshSessions, selectedSessionId],
  );

  return (
    <RuntimeConnectionContext.Provider value={value}>
      {children}
    </RuntimeConnectionContext.Provider>
  );
}

export function useRuntimeConnection(): RuntimeConnectionContextValue {
  const value = useContext(RuntimeConnectionContext);
  if (!value) throw new Error("useRuntimeConnection must be used inside RuntimeConnectionProvider");
  return value;
}
