import { createContext, useContext } from "react";

import type {
  RuntimeApi,
  RuntimeConnectionInput,
  RuntimeConnectionProfile,
  RuntimeConnectionResult,
  RuntimeOperationalHealth,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import type {
  ManagedRuntimeProvisioningInput,
  ManagedRuntimeSnapshot,
} from "@/shared/native/managed-runtime";

export type ManagedConnectionFlow =
  | "booting"
  | "configure"
  | "validating"
  | "starting"
  | "attaching"
  | "connected"
  | "error"
  | "manual";

export interface ConnectedRuntime {
  api: RuntimeApi;
  profile: RuntimeConnectionProfile;
  sessions: RuntimeSession[];
}

export interface RuntimeConnectionContextValue {
  connect: (input: RuntimeConnectionInput) => Promise<RuntimeConnectionResult>;
  configureManagedRuntime: (input: ManagedRuntimeProvisioningInput) => Promise<void>;
  connected: ConnectedRuntime | null;
  disconnect: () => void;
  managedConnectionFlow: ManagedConnectionFlow;
  managedConnectionError: string | null;
  managedRuntime: ManagedRuntimeSnapshot;
  operationalHealth: RuntimeOperationalHealth | null;
  refreshOperationalHealth: () => Promise<boolean>;
  refreshSessions: () => Promise<boolean>;
  selectedSessionId: string | null;
  selectSession: (sessionId: string) => void;
}

export const RuntimeConnectionContext = createContext<RuntimeConnectionContextValue | null>(null);

export function useRuntimeConnection(): RuntimeConnectionContextValue {
  const value = useContext(RuntimeConnectionContext);
  if (!value) throw new Error("useRuntimeConnection must be used inside RuntimeConnectionProvider");
  return value;
}
