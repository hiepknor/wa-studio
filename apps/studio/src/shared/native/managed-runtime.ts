import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import type { RuntimeConnectionInput } from "@/shared/api/runtime-client";

export type ManagedRuntimePhase =
  | "discovering"
  | "provisioningRequired"
  | "databaseStarting"
  | "migrating"
  | "runtimeStarting"
  | "reconfiguring"
  | "restoring"
  | "updating"
  | "ready"
  | "degraded"
  | "stopping"
  | "unavailable";

export interface RuntimeReleaseManifest {
  schemaVersion: 1;
  service: "wa-runtime";
  version: string;
  contractVersion: "v1";
  profiles: string[];
  roles: string[];
  databaseBackends: string[];
  queueBackends: string[];
}

export interface ManagedRuntimeSnapshot {
  phase: ManagedRuntimePhase;
  manifest: RuntimeReleaseManifest | null;
  connection: RuntimeConnectionInput | null;
  error: string | null;
}

export interface ManagedRuntimeProvisioningInput {
  openwaBaseUrl: string;
  openwaApiKey: string;
  allowLiveSends?: boolean;
}

export interface ManagedRuntimeProvisioningProfile {
  openwaBaseUrl: string;
  openwaAllowedSessionIds: string[];
  allowLiveSends: boolean;
  eventInboxBaseUrl: string;
}

export interface ManagedRuntimeBackup {
  id: string;
  kind: "pre-migration" | "pre-restore" | "pre-update";
  createdAtMs: number;
  sizeBytes: number;
}

export const MANAGED_RUNTIME_STATE_CHANGED_EVENT = "managed-runtime://state-changed";

export function getManagedRuntimeState(): Promise<ManagedRuntimeSnapshot> {
  return invoke<ManagedRuntimeSnapshot>("get_managed_runtime_state");
}

export function provisionManagedRuntime(
  input: ManagedRuntimeProvisioningInput,
): Promise<void> {
  return invoke("provision_managed_runtime", { input });
}

export function resetManagedRuntimeDatabase(): Promise<void> {
  return invoke("reset_managed_runtime_database");
}

export function getManagedRuntimeProvisioningProfile(): Promise<ManagedRuntimeProvisioningProfile | null> {
  return invoke<ManagedRuntimeProvisioningProfile | null>(
    "get_managed_runtime_provisioning_profile",
  );
}

export function reconfigureManagedRuntime(
  input: ManagedRuntimeProvisioningInput,
): Promise<ManagedRuntimeProvisioningProfile> {
  return invoke<ManagedRuntimeProvisioningProfile>("reconfigure_managed_runtime", { input });
}

export function listManagedRuntimeBackups(): Promise<ManagedRuntimeBackup[]> {
  return invoke<ManagedRuntimeBackup[]>("list_managed_runtime_backups");
}

export function restoreManagedRuntimeBackup(backupId: string): Promise<void> {
  return invoke("restore_managed_runtime_backup", { backupId });
}

export function subscribeManagedRuntimeState(
  onStateChanged: (snapshot: ManagedRuntimeSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<ManagedRuntimeSnapshot>(
    MANAGED_RUNTIME_STATE_CHANGED_EVENT,
    event => onStateChanged(event.payload),
  );
}
