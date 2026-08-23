import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RuntimeConnectionContext } from "@/app/RuntimeConnectionState";
import type { RuntimeConnectionContextValue } from "@/app/RuntimeConnectionState";
import { SettingsScreen } from "./SettingsScreen";

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
});
