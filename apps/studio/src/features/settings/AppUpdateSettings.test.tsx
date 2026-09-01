import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AppUpdateSnapshot } from "@/shared/native/app-updates";
import { ToastProvider } from "@/shared/ui/Toast";
import { AppUpdateSettings } from "./AppUpdateSettings";

const updateState: AppUpdateSnapshot = {
  currentVersion: "0.2.0",
  disabledReason: null,
  enabled: true,
  pending: {
    currentVersion: "0.2.0",
    date: "2026-08-21T00:00:00Z",
    notes: "Runtime reliability improvements.",
    version: "0.3.0",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("AppUpdateSettings", () => {
  it("dispatches only one signed install for repeated confirmation", async () => {
    const user = userEvent.setup();
    const pendingInstall = deferred<void>();
    const installUpdate = vi.fn().mockReturnValue(pendingInstall.promise);
    render(
      <ToastProvider>
        <AppUpdateSettings
          checkUpdate={vi.fn().mockResolvedValue(updateState)}
          error={null}
          installUpdate={installUpdate}
          progress={null}
          runtimeReady
          updateState={updateState}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Install update" }));
    const confirm = screen.getByRole("button", { name: "Pause Runtime and install" });
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(installUpdate).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingInstall.resolve();
      await pendingInstall.promise;
    });
  });

  it("keeps an installation failure inside the active confirmation", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <AppUpdateSettings
          checkUpdate={vi.fn().mockResolvedValue(updateState)}
          error={null}
          installUpdate={vi.fn().mockRejectedValue(new Error("Signature verification failed."))}
          progress={null}
          runtimeReady
          updateState={updateState}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Install update" }));
    const dialog = screen.getByRole("dialog", { name: "Install signed WA Studio update?" });
    await user.click(within(dialog).getByRole("button", { name: "Pause Runtime and install" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Update installation failed");
    expect(alert).toHaveTextContent("Signature verification failed.");
  });

  it("registers installation as a busy navigation task until it settles", async () => {
    const user = userEvent.setup();
    const pendingInstall = deferred<void>();
    const onNavigationStateChange = vi.fn();
    render(
      <ToastProvider>
        <AppUpdateSettings
          checkUpdate={vi.fn().mockResolvedValue(updateState)}
          error={null}
          installUpdate={vi.fn().mockReturnValue(pendingInstall.promise)}
          onNavigationStateChange={onNavigationStateChange}
          progress={null}
          runtimeReady
          updateState={updateState}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Install update" }));
    await user.click(screen.getByRole("button", { name: "Pause Runtime and install" }));
    await waitFor(() => expect(onNavigationStateChange)
      .toHaveBeenLastCalledWith({ busy: true, dirty: true }));

    await act(async () => {
      pendingInstall.resolve();
      await pendingInstall.promise;
    });
    await waitFor(() => expect(onNavigationStateChange)
      .toHaveBeenLastCalledWith({ busy: false, dirty: false }));
  });
});
