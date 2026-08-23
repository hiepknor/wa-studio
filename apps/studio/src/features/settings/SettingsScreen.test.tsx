import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RuntimeConnectionContext } from "@/app/RuntimeConnectionState";
import type { RuntimeConnectionContextValue } from "@/app/RuntimeConnectionState";
import { SettingsScreen } from "./SettingsScreen";

function getDiagnostics() {
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
        schemaVersion: 1,
        service: "wa-runtime",
        version: "0.1.0",
        contractVersion: "v1",
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
      </RuntimeConnectionContext.Provider>,
    );

    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("one PostgreSQL transaction");
    await user.click(screen.getByRole("button", { name: "Restore backup" }));

    expect(restoreBackup).toHaveBeenCalledWith(
      "pre-migration-v0.1.0-1787312262148.dump.age",
    );
    expect(await screen.findByText("Settings operation completed")).toBeInTheDocument();
    expect(screen.getAllByText("Fresh")).toHaveLength(2);
    expect(screen.getByText("Local recovery posture")).toBeInTheDocument();
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
      </RuntimeConnectionContext.Provider>,
    );

    await screen.findByText("0.2.0");
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
      </RuntimeConnectionContext.Provider>,
    );

    await user.click(await screen.findByRole("button", { name: "Create backup" }));
    expect(createBackup).toHaveBeenCalledOnce();
    expect(listBackups).toHaveBeenCalledTimes(2);

    await user.type(screen.getByLabelText("Recovery passphrase"), "recovery-passphrase-2026");
    await user.type(
      screen.getByLabelText("Confirm passphrase for export"),
      "recovery-passphrase-2026",
    );
    await user.click(screen.getByRole("button", { name: "Export archive" }));

    expect(exportRecoveryArchive).toHaveBeenCalledWith("recovery-passphrase-2026");
    expect(await screen.findByText(/was exported and verified/u)).toBeInTheDocument();
  });
});
