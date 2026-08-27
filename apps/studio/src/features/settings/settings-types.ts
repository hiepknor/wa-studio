export type SettingsTab = "overview" | "connection" | "recovery" | "updates";

export interface SettingsTaskNavigationState {
  busy: boolean;
  dirty: boolean;
}
