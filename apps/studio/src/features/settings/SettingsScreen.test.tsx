import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RuntimeConnectionContext } from "@/app/RuntimeConnectionState";
import type { RuntimeConnectionContextValue } from "@/app/RuntimeConnectionState";
import { WorkspaceNavigationGuardProvider } from "@/app/WorkspaceNavigationGuard";
import type { ManagedRuntimeDiagnostics } from "@/shared/native/managed-runtime";
import { ToastProvider } from "@/shared/ui/Toast";
import { SettingsScreen } from "./SettingsScreen";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function getDiagnostics(): Promise<ManagedRuntimeDiagnostics> {
  return Promise.resolve({
    generatedAtMs: 1_787_312_300_000,
    desktopProduct: "wa-studio" as const,
    runtimeService: "wa-runtime" as const,
    runtimePhase: "ready" as const,
    runtimeVersion: "0.1.0",
    processGeneration: 3,
    managedPostgresRunning: true,
    recoveryPointCount: 1,
    latestRecoveryPointAtMs: 1_787_312_262_148,
    recoveryFreshness: "fresh" as const,
    lastIntegrityCheckAtMs: 1_787_312_260_000,
    integrityFreshness: "fresh" as const,
  });
}

function context(): RuntimeConnectionContextValue {
  return {
    connect: vi.fn(),
    connected: null,
    disconnect: vi.fn(),
    managedConnectionFlow: "connected",
    configureManagedRuntime: vi.fn(),
    managedConnectionError: null,
    managedRuntime: {
      phase: "ready",
      manifest: {
        schemaVersion: 2,
        service: "wa-runtime",
        version: "0.1.0",
        contractVersion: "v1",
        openwaReleaseTag: "1.2.3",
        openwaContractSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        profiles: ["desktop-managed"],
        roles: ["api", "worker", "scheduler", "migrate"],
        databaseBackends: ["postgres"],
        queueBackends: ["postgres"],
      },
      connection: null,
      error: null,
    },
    refreshSessions: vi.fn(),
    selectedSessionId: null,
    selectSession: vi.fn(),
  };
}

describe("SettingsScreen", () => {
  it("requires confirmation and restores a selected encrypted backup", async () => {
    const user = userEvent.setup();
    const listBackups = vi.fn().mockResolvedValue([
      {
        id: "pre-migration-v0.1.0-1787312262148.dump.age",
        kind: "pre-migration",
        createdAtMs: 1_787_312_262_148,
        sizeBytes: 161_190,
      },
    ]);
    const restoreBackup = vi.fn().mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <SettingsScreen
            getDiagnostics={getDiagnostics}
            getUpdateState={vi.fn().mockResolvedValue({
              currentVersion: "0.2.0",
              disabledReason: "Test build",
              enabled: false,
              pending: null,
            })}
            getProvisioningProfile={vi.fn().mockResolvedValue(null)}
            listBackups={listBackups}
            restoreBackup={restoreBackup}
            subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
          />
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Backups & recovery" }));
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("creates a safety backup first");
    await user.click(screen.getByRole("button", { name: "Restore backup" }));

    expect(restoreBackup).toHaveBeenCalledWith(
      "pre-migration-v0.1.0-1787312262148.dump.age",
    );
    expect(await screen.findByText("Backup restored")).toBeInTheDocument();
    expect(screen.getByText("Your local data")).toBeInTheDocument();
  });

  it("checks and explicitly confirms a signed update that pauses Runtime", async () => {
    const user = userEvent.setup();
    const getUpdateState = vi.fn().mockResolvedValue({
      currentVersion: "0.2.0",
      disabledReason: null,
      enabled: true,
      pending: null,
    });
    const checkUpdate = vi.fn().mockResolvedValue({
      currentVersion: "0.2.0",
      disabledReason: null,
      enabled: true,
      pending: {
        currentVersion: "0.2.0",
        date: "2026-08-21T00:00:00Z",
        notes: "Runtime reliability improvements.",
        version: "0.3.0",
      },
    });
    const installUpdate = vi.fn().mockResolvedValue(undefined);

    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <SettingsScreen
            checkUpdate={checkUpdate}
            getDiagnostics={getDiagnostics}
            getUpdateState={getUpdateState}
            getProvisioningProfile={vi.fn().mockResolvedValue(null)}
            installUpdate={installUpdate}
            listBackups={vi.fn().mockResolvedValue([])}
            subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
          />
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Updates" }));
    await screen.findByRole("heading", { name: "Updates" });
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Runtime reliability improvements.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install update" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("pause active local campaigns");
    await user.click(screen.getByRole("button", { name: "Pause Runtime and install" }));

    expect(installUpdate).toHaveBeenCalledWith(true);
  });

  it("creates local recovery points and exports portable archives with confirmed passphrases", async () => {
    const user = userEvent.setup();
    const createBackup = vi.fn().mockResolvedValue(undefined);
    const exportRecoveryArchive = vi.fn().mockResolvedValue("wa-runtime-recovery.dump.age");
    const listBackups = vi.fn().mockResolvedValue([]);
    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <SettingsScreen
            createBackup={createBackup}
            exportRecoveryArchive={exportRecoveryArchive}
            getDiagnostics={getDiagnostics}
            getUpdateState={vi.fn().mockResolvedValue({
              currentVersion: "0.2.0",
              disabledReason: "Test build",
              enabled: false,
              pending: null,
            })}
            getProvisioningProfile={vi.fn().mockResolvedValue(null)}
            listBackups={listBackups}
            subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
          />
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Backups & recovery" }));
    await user.click(await screen.findByRole("button", { name: "Create backup" }));
    expect(createBackup).toHaveBeenCalledOnce();
    expect(listBackups).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: /Export archive/u }));
    await user.type(screen.getByLabelText("New recovery passphrase"), "recovery-passphrase-2026");
    await user.type(
      screen.getByLabelText("Confirm passphrase"),
      "recovery-passphrase-2026",
    );
    await user.click(screen.getByRole("button", { name: "Export archive" }));

    expect(exportRecoveryArchive).toHaveBeenCalledWith("recovery-passphrase-2026");
    expect(await screen.findByText("Recovery archive exported")).toBeInTheDocument();
  });

  it("opens with an accessible task-based overview", async () => {
    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <SettingsScreen
            getDiagnostics={getDiagnostics}
            getUpdateState={vi.fn().mockResolvedValue({
              currentVersion: "0.2.0",
              disabledReason: null,
              enabled: true,
              pending: null,
            })}
            listBackups={vi.fn().mockResolvedValue([])}
            subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
          />
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "WA Runtime is ready" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Product overview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "WA Runtime is ready" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Settings sections" })).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "settings-overview-tab");
    expect(screen.getByRole("tabpanel")).not.toHaveAttribute("tabindex");
    expect(screen.getByText("1.2.3 reviewed")).toBeInTheDocument();
    expect(document.querySelector(".settings-status-hero")).not.toBeInTheDocument();
    expect(document.querySelector(".settings-summary-card")).not.toBeInTheDocument();
  });

  it("guards Settings tab and workspace navigation while connection changes are unsaved", async () => {
    const user = userEvent.setup();
    const onGuardChange = vi.fn();
    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <WorkspaceNavigationGuardProvider onGuardChange={onGuardChange}>
            <SettingsScreen
              getDiagnostics={getDiagnostics}
              getProvisioningProfile={vi.fn().mockResolvedValue({
                allowLiveSends: false,
                eventInboxBaseUrl: "https://wa-events.onio.cc",
                openwaAllowedSessionIds: ["00000000-0000-4000-8000-000000000001"],
                openwaBaseUrl: "https://openwa.onio.cc",
              })}
              getUpdateState={vi.fn().mockResolvedValue({
                currentVersion: "0.2.0",
                disabledReason: "Test build",
                enabled: false,
                pending: null,
              })}
              listBackups={vi.fn().mockResolvedValue([])}
              subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
            />
          </WorkspaceNavigationGuardProvider>
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Connection" }));
    await user.type(await screen.findByLabelText("OpenWA API key"), "replacement-openwa-key");
    await waitFor(() => expect(onGuardChange).toHaveBeenLastCalledWith({
      message: "Unsaved OpenWA endpoint, credential, or live-send changes will be discarded. WA Runtime is not changed.",
      title: "Leave connection changes?",
    }));

    await user.click(screen.getByRole("tab", { name: "Updates" }));
    const guard = screen.getByRole("dialog", { name: "Discard connection changes?" });
    expect(screen.getByRole("tab", { name: "Connection" })).toHaveAttribute("aria-selected", "true");
    await user.click(within(guard).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("tab", { name: "Connection" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "Updates" }));
    await user.click(screen.getByRole("button", { name: "Discard and continue" }));
    expect(screen.getByRole("tab", { name: "Updates" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "Updates" })).toBeInTheDocument();
    await waitFor(() => expect(onGuardChange).toHaveBeenLastCalledWith(null));
  });

  it("guards and clears a recovery passphrase draft before changing Settings tasks", async () => {
    const user = userEvent.setup();
    const onGuardChange = vi.fn();
    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <WorkspaceNavigationGuardProvider onGuardChange={onGuardChange}>
            <SettingsScreen
              getDiagnostics={getDiagnostics}
              getUpdateState={vi.fn().mockResolvedValue({
                currentVersion: "0.2.0",
                disabledReason: "Test build",
                enabled: false,
                pending: null,
              })}
              listBackups={vi.fn().mockResolvedValue([])}
              subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
            />
          </WorkspaceNavigationGuardProvider>
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Backups & recovery" }));
    await user.click(await screen.findByRole("button", { name: /Export archive/u }));
    const passphrase = screen.getByLabelText("New recovery passphrase");
    await user.type(passphrase, "recovery-passphrase-2026");
    await waitFor(() => expect(onGuardChange).toHaveBeenLastCalledWith({
      message: "Entered recovery passphrases will be cleared before leaving this task. No archive operation has started.",
      title: "Leave recovery setup?",
    }));

    await user.click(screen.getByRole("tab", { name: "Updates" }));
    const guard = screen.getByRole("dialog", { name: "Discard recovery setup?" });
    await user.click(within(guard).getByRole("button", { name: "Keep editing" }));
    expect(passphrase).toHaveValue("recovery-passphrase-2026");

    await user.click(screen.getByRole("tab", { name: "Updates" }));
    await user.click(screen.getByRole("button", { name: "Discard and continue" }));
    expect(screen.queryByLabelText("New recovery passphrase")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Updates" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(onGuardChange).toHaveBeenLastCalledWith(null));
  });

  it("blocks Settings task changes until an active recovery operation settles", async () => {
    const user = userEvent.setup();
    const pendingBackup = deferred<void>();
    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <SettingsScreen
            createBackup={vi.fn().mockReturnValue(pendingBackup.promise)}
            getDiagnostics={getDiagnostics}
            getUpdateState={vi.fn().mockResolvedValue({
              currentVersion: "0.2.0",
              disabledReason: "Test build",
              enabled: false,
              pending: null,
            })}
            listBackups={vi.fn().mockResolvedValue([])}
            subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
          />
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Backups & recovery" }));
    await user.click(await screen.findByRole("button", { name: "Create backup" }));
    await user.click(screen.getByRole("tab", { name: "Updates" }));

    const guard = screen.getByRole("dialog", { name: "Recovery operation in progress" });
    expect(guard).toHaveAttribute("aria-busy", "true");
    expect(within(guard).getByRole("button", { name: "Keep editing" })).toBeDisabled();
    expect(within(guard).getByRole("button", { name: "Finishing operation…" })).toBeDisabled();

    await act(async () => {
      pendingBackup.resolve();
      await pendingBackup.promise;
    });
    expect(await screen.findByRole("dialog", { name: "Recovery operation finished" }))
      .toHaveTextContent("The backup or recovery operation has finished.");
    await user.click(await within(guard).findByRole("button", { name: "Continue" }));
    expect(screen.getByRole("tab", { name: "Updates" })).toHaveAttribute("aria-selected", "true");
  });

  it("blocks Settings task changes until update installation settles", async () => {
    const user = userEvent.setup();
    const pendingInstall = deferred<void>();
    const installUpdate = vi.fn().mockReturnValue(pendingInstall.promise);
    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <SettingsScreen
            getDiagnostics={getDiagnostics}
            getUpdateState={vi.fn().mockResolvedValue({
              currentVersion: "0.2.0",
              disabledReason: null,
              enabled: true,
              pending: {
                currentVersion: "0.2.0",
                date: "2026-08-21T00:00:00Z",
                notes: "Runtime reliability improvements.",
                version: "0.3.0",
              },
            })}
            installUpdate={installUpdate}
            listBackups={vi.fn().mockResolvedValue([])}
            subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
          />
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Updates" }));
    await user.click(await screen.findByRole("button", { name: "Install update" }));
    await user.click(screen.getByRole("button", { name: "Pause Runtime and install" }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledOnce());
    act(() => {
      screen.getByRole("tab", { name: "Overview" }).click();
    });

    const guard = await screen.findByRole("dialog", { name: "Update installation in progress" });
    expect(guard).toHaveAttribute("aria-busy", "true");
    expect(within(guard).getByRole("button", { name: "Keep editing" })).toBeDisabled();
    expect(within(guard).getByRole("button", { name: "Installing update…" })).toBeDisabled();

    await act(async () => {
      pendingInstall.resolve();
      await pendingInstall.promise;
    });
    expect(await screen.findByRole("dialog", { name: "Update operation finished" }))
      .toHaveTextContent("The update installation has finished.");
    await user.click(await within(guard).findByRole("button", { name: "Continue" }));
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  });

  it("retains both Runtime and update failures on the overview", async () => {
    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <SettingsScreen
            getDiagnostics={vi.fn().mockRejectedValue(new Error("Runtime diagnostics unavailable."))}
            getUpdateState={vi.fn().mockRejectedValue(new Error("Update channel unavailable."))}
            listBackups={vi.fn().mockResolvedValue([])}
            subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
          />
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Runtime diagnostics unavailable.");
    expect(alert).toHaveTextContent("Update channel unavailable.");
  });

  it("retains available diagnostics when the backup catalog fails", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <SettingsScreen
            getDiagnostics={getDiagnostics}
            getUpdateState={vi.fn().mockResolvedValue({
              currentVersion: "0.2.0",
              disabledReason: "Test build",
              enabled: false,
              pending: null,
            })}
            listBackups={vi.fn().mockRejectedValue(new Error("Backup catalog unavailable."))}
            subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
          />
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Backups & recovery" }));

    expect(await screen.findByText("Recovery data could not be refreshed")).toBeInTheDocument();
    expect(screen.getByText("Backup catalog unavailable.")).toBeInTheDocument();
    expect(screen.getAllByText("Protected")).toHaveLength(2);
  });

  it("ignores an older Runtime refresh that resolves after a newer one", async () => {
    const user = userEvent.setup();
    const oldBackups = deferred<Array<{
      id: string;
      kind: "manual";
      createdAtMs: number;
      sizeBytes: number;
    }>>();
    const oldDiagnostics = deferred<Awaited<ReturnType<typeof getDiagnostics>>>();
    const currentDiagnostics = await getDiagnostics();
    const listBackups = vi.fn()
      .mockReturnValueOnce(oldBackups.promise)
      .mockResolvedValueOnce([{
        id: "current-backup.dump.age",
        kind: "manual" as const,
        createdAtMs: 1_787_312_400_000,
        sizeBytes: 128,
      }]);
    const inspectDiagnostics = vi.fn()
      .mockReturnValueOnce(oldDiagnostics.promise)
      .mockResolvedValueOnce(currentDiagnostics);

    render(
      <ToastProvider>
        <RuntimeConnectionContext.Provider value={context()}>
          <SettingsScreen
            getDiagnostics={inspectDiagnostics}
            getUpdateState={vi.fn().mockResolvedValue({
              currentVersion: "0.2.0",
              disabledReason: "Test build",
              enabled: false,
              pending: null,
            })}
            listBackups={listBackups}
            subscribeUpdateProgress={vi.fn().mockResolvedValue(vi.fn())}
          />
        </RuntimeConnectionContext.Provider>
      </ToastProvider>,
    );

    await waitFor(() => expect(listBackups).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(listBackups).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("tab", { name: "Backups & recovery" }));
    expect(await screen.findByText("current-backup.dump.age")).toBeInTheDocument();

    await act(async () => {
      oldBackups.resolve([{
        id: "stale-backup.dump.age",
        kind: "manual",
        createdAtMs: 1_787_312_000_000,
        sizeBytes: 64,
      }]);
      oldDiagnostics.resolve({
        ...currentDiagnostics,
        recoveryFreshness: "missing",
      });
      await Promise.all([oldBackups.promise, oldDiagnostics.promise]);
    });

    expect(screen.getByText("current-backup.dump.age")).toBeInTheDocument();
    expect(screen.queryByText("stale-backup.dump.age")).not.toBeInTheDocument();
    expect(screen.queryByText("Not protected")).not.toBeInTheDocument();
  });
});
