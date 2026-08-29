export type SettingsTab = "overview" | "connection" | "safety" | "recovery" | "updates";

export interface SettingsTaskNavigationState {
  busy: boolean;
  dirty: boolean;
}
