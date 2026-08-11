import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type WindowMode = "normal" | "maximized" | "immersive";

export interface WindowState {
  mode: WindowMode;
  transitioning: boolean;
}

export interface WindowCapabilities {
  immersive: boolean;
  nativeSpaces: boolean;
  restorePlacement: boolean;
  snapLayouts: boolean;
}

const STATE_CHANGED_EVENT = "window://state-changed";

export const windowing = {
  capabilities: () => invoke<WindowCapabilities>("get_window_capabilities"),
  state: () => invoke<WindowState>("get_window_state"),
  setMode: (mode: WindowMode) => invoke<WindowState>("set_window_mode", { mode }),
  toggleImmersive: () => invoke<WindowState>("toggle_immersive"),
  onStateChanged: (handler: (state: WindowState) => void): Promise<UnlistenFn> =>
    listen<WindowState>(STATE_CHANGED_EVENT, ({ payload }) => handler(payload)),
};
