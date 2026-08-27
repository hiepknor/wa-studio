import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  ManagedRuntimeBackup,
  ManagedRuntimeDiagnostics,
} from "@/shared/native/managed-runtime";
import { ToastProvider } from "@/shared/ui/Toast";
import { BackupRecoverySettings } from "./BackupRecoverySettings";

const backup: ManagedRuntimeBackup = {
  id: "manual-v0.2.0-1787312262148.dump.age",
  kind: "manual",
  createdAtMs: 1_787_312_262_148,
  sizeBytes: 161_190,
};

const diagnostics: ManagedRuntimeDiagnostics = {
  generatedAtMs: 1_787_312_300_000,
  desktopProduct: "wa-studio",
  runtimeService: "wa-runtime",
  runtimePhase: "ready",
  runtimeVersion: "0.2.0",
  processGeneration: 3,
  managedPostgresRunning: true,
  recoveryPointCount: 1,
  latestRecoveryPointAtMs: backup.createdAtMs,
  recoveryFreshness: "fresh",
  lastIntegrityCheckAtMs: 1_787_312_260_000,
  integrityFreshness: "fresh",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function renderRecovery(overrides: Partial<ComponentProps<typeof BackupRecoverySettings>> = {}) {
  const props: ComponentProps<typeof BackupRecoverySettings> = {
    backups: [backup],
    createBackup: vi.fn().mockResolvedValue(undefined),
    diagnostics,
    exportRecoveryArchive: vi.fn().mockResolvedValue(null),
    loadError: null,
    loading: false,
    onReload: vi.fn().mockResolvedValue(true),
    restoreBackup: vi.fn().mockResolvedValue(undefined),
    restoreRecoveryArchive: vi.fn().mockResolvedValue(false),
    runtimeReady: true,
    ...overrides,
  };
  render(<ToastProvider><BackupRecoverySettings {...props} /></ToastProvider>);
  return props;
}

describe("BackupRecoverySettings", () => {
  it("reports a committed backup separately from a failed view refresh", async () => {
    const user = userEvent.setup();
    const createBackup = vi.fn().mockResolvedValue(undefined);
    renderRecovery({
      createBackup,
      onReload: vi.fn().mockRejectedValue(new Error("reload unavailable")),
    });

    await user.click(screen.getByRole("button", { name: "Create backup" }));

    expect(createBackup).toHaveBeenCalledOnce();
    expect(await screen.findByText("Backup created; refresh needed")).toBeInTheDocument();
    expect(screen.queryByText("Recovery operation failed")).not.toBeInTheDocument();
  });

  it("allows only one recovery operation at a time", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const onNavigationStateChange = vi.fn();
    renderRecovery({
      createBackup: vi.fn().mockReturnValue(pending.promise),
      onNavigationStateChange,
    });

    await user.click(screen.getByRole("button", { name: "Create backup" }));

    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Export archive/u })).toBeDisabled();
    await waitFor(() => expect(onNavigationStateChange).toHaveBeenLastCalledWith({
      busy: true,
      dirty: true,
    }));
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(await screen.findByText("Backup created")).toBeInTheDocument();
    await waitFor(() => expect(onNavigationStateChange).toHaveBeenLastCalledWith({
      busy: false,
      dirty: false,
    }));
  });

  it("reports and clears a recovery passphrase draft when its flow is canceled", async () => {
    const user = userEvent.setup();
    const onNavigationStateChange = vi.fn();
    renderRecovery({ onNavigationStateChange });

    await user.click(screen.getByRole("button", { name: /Export archive/u }));
    await user.type(screen.getByLabelText("New recovery passphrase"), "recovery-passphrase-2026");

    await waitFor(() => expect(onNavigationStateChange).toHaveBeenLastCalledWith({
      busy: false,
      dirty: true,
    }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("New recovery passphrase")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("recovery-passphrase-2026");
    await waitFor(() => expect(onNavigationStateChange).toHaveBeenLastCalledWith({
      busy: false,
      dirty: false,
    }));
  });

  it("redacts an archive passphrase from native error copy", async () => {
    const user = userEvent.setup();
    const passphrase = "recovery-passphrase-2026";
    renderRecovery({
      exportRecoveryArchive: vi.fn().mockRejectedValue(
        new Error(`Archive failed for ${passphrase}`),
      ),
    });
    await user.click(screen.getByRole("button", { name: /Export archive/u }));
    await user.type(screen.getByLabelText("New recovery passphrase"), passphrase);
    await user.type(screen.getByLabelText("Confirm passphrase"), passphrase);
    await user.click(screen.getByRole("button", { name: "Export archive" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Archive failed for [redacted]");
    expect(alert).not.toHaveTextContent(passphrase);
  });

  it("dispatches only one destructive restore for repeated confirmation", async () => {
    const user = userEvent.setup();
    const pendingRestore = deferred<void>();
    const restoreBackup = vi.fn().mockReturnValue(pendingRestore.promise);
    renderRecovery({ restoreBackup });

    await user.click(screen.getByRole("button", { name: "Restore" }));
    const confirm = screen.getByRole("button", { name: "Restore backup" });
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(restoreBackup).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingRestore.resolve();
      await pendingRestore.promise;
    });
  });

  it("reports a backup restore failure inside its active confirmation", async () => {
    const user = userEvent.setup();
    renderRecovery({
      restoreBackup: vi.fn().mockRejectedValue(new Error("Backup checksum mismatch.")),
    });

    await user.click(screen.getByRole("button", { name: "Restore" }));
    const dialog = screen.getByRole("dialog", { name: "Restore this backup?" });
    await user.click(within(dialog).getByRole("button", { name: "Restore backup" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Backup restore failed");
    expect(alert).toHaveTextContent("Backup checksum mismatch.");
  });

  it("reports an archive restore failure inside its active confirmation", async () => {
    const user = userEvent.setup();
    renderRecovery({
      restoreRecoveryArchive: vi.fn().mockRejectedValue(new Error("Archive could not be decrypted.")),
    });

    await user.click(screen.getByRole("button", { name: /Import archive/u }));
    await user.type(screen.getByLabelText("Archive passphrase"), "recovery-passphrase-2026");
    await user.click(screen.getByRole("button", { name: "Choose archive and restore" }));
    const dialog = screen.getByRole("dialog", { name: "Restore a portable archive?" });
    await user.click(within(dialog).getByRole("button", { name: "Choose archive and restore" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Archive restore failed");
    expect(alert).toHaveTextContent("Archive could not be decrypted.");
  });
});
