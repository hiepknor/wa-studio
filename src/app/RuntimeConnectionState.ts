import { createContext, useContext } from "react";

import type {
  RuntimeApi,
  RuntimeConnectionInput,
  RuntimeConnectionResult,
  RuntimeSession,
} from "@/shared/api/runtime-client";

export interface ConnectedRuntime {
  api: RuntimeApi;
  profile: RuntimeConnectionInput;
  sessions: RuntimeSession[];
}

export interface RuntimeConnectionContextValue {
  connect: (input: RuntimeConnectionInput) => Promise<RuntimeConnectionResult>;
  connected: ConnectedRuntime | null;
  disconnect: () => void;
  refreshSessions: () => Promise<void>;
  selectedSessionId: string | null;
  selectSession: (sessionId: string) => void;
}

export const RuntimeConnectionContext = createContext<RuntimeConnectionContextValue | null>(null);

export function useRuntimeConnection(): RuntimeConnectionContextValue {
  const value = useContext(RuntimeConnectionContext);
  if (!value) throw new Error("useRuntimeConnection must be used inside RuntimeConnectionProvider");
  return value;
}
