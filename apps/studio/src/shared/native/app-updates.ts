import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AppUpdateMetadata {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string | null;
}

export interface AppUpdateSnapshot {
  enabled: boolean;
  currentVersion: string;
  disabledReason: string | null;
  pending: AppUpdateMetadata | null;
}

export type AppUpdateProgressPhase =
  | "downloading"
  | "downloaded"
  | "backingUp"
  | "installing"
  | "restarting";

export interface AppUpdateProgress {
  phase: AppUpdateProgressPhase;
  downloadedBytes: number | null;
  totalBytes: number | null;
}

const APP_UPDATE_PROGRESS_EVENT = "app-update://progress";

export function getAppUpdateState(): Promise<AppUpdateSnapshot> {
  return invoke<AppUpdateSnapshot>("get_app_update_state");
}

export function checkForAppUpdate(): Promise<AppUpdateSnapshot> {
  return invoke<AppUpdateSnapshot>("check_for_app_update");
}

export function installAppUpdate(acknowledgeRuntimeInterruption: boolean): Promise<void> {
  return invoke("install_app_update", { acknowledgeRuntimeInterruption });
}

export function subscribeAppUpdateProgress(
  onProgress: (progress: AppUpdateProgress) => void,
): Promise<UnlistenFn> {
  return listen<AppUpdateProgress>(APP_UPDATE_PROGRESS_EVENT, event => onProgress(event.payload));
}
