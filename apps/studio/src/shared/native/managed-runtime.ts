import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

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

interface RuntimeReleaseManifestBase {
  service: "wa-runtime";
  version: string;
  contractVersion: "v1";
  profiles: string[];
  roles: string[];
  databaseBackends: string[];
  queueBackends: string[];
}

export type RuntimeReleaseManifest = RuntimeReleaseManifestBase & (
  | {
      schemaVersion: 1;
      openwaReleaseTag?: string;
      openwaContractSha256?: string;
    }
  | {
      schemaVersion: 2;
      openwaReleaseTag: string;
      openwaContractSha256: string;
    }
);

export interface ManagedRuntimeSnapshot {
  phase: ManagedRuntimePhase;
  manifest: RuntimeReleaseManifest | null;
  connection: ManagedRuntimeConnection | null;
  error: string | null;
}

export interface ManagedRuntimeConnection {
  baseUrl: string;
  transport: "native";
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
  kind: "automatic" | "manual" | "pre-migration" | "pre-restore" | "pre-update";
  createdAtMs: number;
  sizeBytes: number;
}

export type ProtectionFreshness = "fresh" | "due" | "missing";

export interface ManagedRuntimeDiagnostics {
  generatedAtMs: number;
  desktopProduct: "wa-studio";
  runtimeService: "wa-runtime";
  runtimePhase: ManagedRuntimePhase;
  runtimeVersion: string | null;
  processGeneration: number | null;
  managedPostgresRunning: boolean;
  recoveryPointCount: number;
  latestRecoveryPointAtMs: number | null;
  recoveryFreshness: ProtectionFreshness;
  lastIntegrityCheckAtMs: number | null;
  integrityFreshness: ProtectionFreshness;
}

export const MANAGED_RUNTIME_STATE_CHANGED_EVENT = "managed-runtime://state-changed";

export function getManagedRuntimeState(): Promise<ManagedRuntimeSnapshot> {
  return invoke<ManagedRuntimeSnapshot>("get_managed_runtime_state");
}

export function getManagedRuntimeDiagnostics(): Promise<ManagedRuntimeDiagnostics> {
  return invoke<ManagedRuntimeDiagnostics>("get_managed_runtime_diagnostics");
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

export function createManagedRuntimeBackup(): Promise<void> {
  return invoke("create_managed_runtime_backup");
}

export function exportManagedRuntimeRecoveryArchive(
  passphrase: string,
): Promise<string | null> {
  return invoke<string | null>("export_managed_runtime_recovery_archive", { passphrase });
}

export function restoreManagedRuntimeBackup(backupId: string): Promise<void> {
  return invoke("restore_managed_runtime_backup", { backupId });
}

export function restoreManagedRuntimeRecoveryArchive(passphrase: string): Promise<boolean> {
  return invoke<boolean>("restore_managed_runtime_recovery_archive", { passphrase });
}

export function subscribeManagedRuntimeState(
  onStateChanged: (snapshot: ManagedRuntimeSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<ManagedRuntimeSnapshot>(
    MANAGED_RUNTIME_STATE_CHANGED_EVENT,
    event => onStateChanged(event.payload),
  );
}
