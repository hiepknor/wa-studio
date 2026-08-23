import { describe, expect, it, vi } from "vitest";

import { installHmrContextRecovery } from "./installHmrContextRecovery";

type HmrListener = () => void;

function fakeHot() {
  const listeners = new Map<string, HmrListener>();
  return {
    hot: {
      on: vi.fn((event: string, listener: HmrListener) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
    } as unknown as NonNullable<ImportMeta["hot"]>,
    update: () => listeners.get("vite:beforeUpdate")?.(),
  };
}

describe("installHmrContextRecovery", () => {
  it("reloads once for a provider identity error immediately after HMR", () => {
    const { hot, update } = fakeHot();
    const reload = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 10_000;
    const dispose = installHmrContextRecovery(hot, { now: () => now, reload });

    update();
    window.dispatchEvent(new ErrorEvent("error", {
      error: new Error("useToast must be used inside ToastProvider"),
    }));
    window.dispatchEvent(new ErrorEvent("error", {
      error: new Error("useToast must be used inside ToastProvider"),
    }));

    expect(reload).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    dispose();
    now += 1;
    warn.mockRestore();
  });

  it("does not hide startup, unrelated, or expired errors", () => {
    const { hot, update } = fakeHot();
    const reload = vi.fn();
    let now = 20_000;
    const dispose = installHmrContextRecovery(hot, { now: () => now, reload });

    window.dispatchEvent(new ErrorEvent("error", {
      error: new Error("useToast must be used inside ToastProvider"),
    }));
    update();
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("Unrelated render error") }));
    now += 3_000;
    window.dispatchEvent(new ErrorEvent("error", {
      error: new Error("useRuntimeConnection must be used inside RuntimeConnectionProvider"),
    }));

    expect(reload).not.toHaveBeenCalled();
    dispose();
  });
});
