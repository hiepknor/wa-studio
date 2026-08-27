import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ManagedRuntimeSnapshot } from "@/shared/native/managed-runtime";
import { ManagedRuntimeSetupScreen } from "./ManagedRuntimeSetupScreen";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const snapshot: ManagedRuntimeSnapshot = {
  phase: "provisioningRequired",
  manifest: { schemaVersion: 2, service: "wa-runtime", version: "0.1.0", contractVersion: "v1", openwaReleaseTag: "1.2.3", openwaContractSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", profiles: ["desktop-managed"], roles: ["api", "worker", "scheduler"], databaseBackends: ["postgres"], queueBackends: ["postgres"] },
  connection: null,
  error: null,
};

describe("ManagedRuntimeSetupScreen", () => {
  it("submits only the OpenWA URL and API key", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn().mockResolvedValue(undefined);
    render(<ManagedRuntimeSetupScreen flow="configure" onConnect={onConnect} snapshot={snapshot} />);
    expect(screen.getByRole("heading", { name: "Ready on this machine." })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "OpenWA connection" }))
      .toHaveClass("connection-setup-card");
    expect(screen.getByText("WA Studio does not send operational data to a hosted workspace."))
      .toBeInTheDocument();
    expect(screen.queryByText("1 of 1")).not.toBeInTheDocument();
    expect(document.querySelector(".connection-terminal-bar")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("OpenWA base URL"), "https://openwa.onio.cc");
    await user.type(screen.getByLabelText("OpenWA API key"), "openwa-key");
    await user.click(screen.getByRole("button", { name: "Connect OpenWA" }));
    expect(onConnect).toHaveBeenCalledWith({ openwaBaseUrl: "https://openwa.onio.cc", openwaApiKey: "openwa-key" });
  });

  it("locks the setup form while native configuration is in progress", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const onConnect = vi.fn().mockReturnValue(pending.promise);
    render(<ManagedRuntimeSetupScreen flow="configure" onConnect={onConnect} snapshot={snapshot} />);

    await user.type(screen.getByLabelText("OpenWA base URL"), "https://openwa.onio.cc");
    await user.type(screen.getByLabelText("OpenWA API key"), "openwa-key");
    const connectButton = screen.getByRole("button", { name: "Connect OpenWA" });
    act(() => {
      connectButton.click();
      connectButton.click();
    });

    expect(connectButton).toBeDisabled();
    expect(screen.getByLabelText("OpenWA base URL")).toBeDisabled();
    expect(screen.getByLabelText("OpenWA API key")).toBeDisabled();
    expect(onConnect).toHaveBeenCalledOnce();

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(screen.getByRole("button", { name: "Connect OpenWA" })).toBeEnabled();
  });

  it.each([
    ["validating", "Checking OpenWA"],
    ["starting", "Starting local services"],
    ["attaching", "Opening workspace"],
  ] as const)("renders the %s lifecycle without a form", (flow, heading) => {
    render(<ManagedRuntimeSetupScreen flow={flow} onConnect={vi.fn()} snapshot={snapshot} />);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenWA API key")).not.toBeInTheDocument();
  });

  it("renders a stable repair form with the native error", async () => {
    render(<ManagedRuntimeSetupScreen connectionError="Managed PostgreSQL could not start." flow="error" getProfile={vi.fn().mockResolvedValue({ openwaBaseUrl: "https://openwa.onio.cc", openwaAllowedSessionIds: [], allowLiveSends: false, eventInboxBaseUrl: "https://wa-events.onio.cc" })} onConnect={vi.fn()} snapshot={{ ...snapshot, phase: "degraded" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Managed PostgreSQL could not start.");
    expect(await screen.findByDisplayValue("https://openwa.onio.cc")).toBeInTheDocument();
  });

  it("does not overwrite a URL the operator edits while the stored profile loads", async () => {
    const user = userEvent.setup();
    const pendingProfile = deferred<{
      allowLiveSends: boolean;
      eventInboxBaseUrl: string;
      openwaAllowedSessionIds: string[];
      openwaBaseUrl: string;
    } | null>();
    render(
      <ManagedRuntimeSetupScreen
        flow="configure"
        getProfile={vi.fn().mockReturnValue(pendingProfile.promise)}
        onConnect={vi.fn()}
        snapshot={snapshot}
      />,
    );

    const url = screen.getByLabelText("OpenWA base URL");
    await user.type(url, "https://operator.example");
    await act(async () => {
      pendingProfile.resolve({
        allowLiveSends: false,
        eventInboxBaseUrl: "https://events.stored.example",
        openwaAllowedSessionIds: [],
        openwaBaseUrl: "https://stored.example",
      });
      await pendingProfile.promise;
    });

    expect(url).toHaveValue("https://operator.example");
  });

  it("distinguishes loading recovery points from an empty catalog", async () => {
    const pendingBackups = deferred<[]>();
    render(
      <ManagedRuntimeSetupScreen
        flow="error"
        listBackups={vi.fn().mockReturnValue(pendingBackups.promise)}
        onConnect={vi.fn()}
        snapshot={{ ...snapshot, phase: "degraded" }}
      />,
    );

    expect(screen.getByText("Loading verified recovery points…")).toBeInTheDocument();
    expect(screen.queryByText("No local recovery points are available.")).not.toBeInTheDocument();
    await act(async () => {
      pendingBackups.resolve([]);
      await pendingBackups.promise;
    });
    expect(screen.getByText("No local recovery points are available.")).toBeInTheDocument();
  });

  it("offers transactional local recovery while the managed database is degraded", async () => {
    const user = userEvent.setup();
    const pendingRestore = deferred<void>();
    const restoreBackup = vi.fn().mockReturnValue(pendingRestore.promise);
    render(
      <ManagedRuntimeSetupScreen
        flow="error"
        listBackups={vi.fn().mockResolvedValue([{
          id: "automatic-1787312262148.dump.age",
          kind: "automatic",
          createdAtMs: 1_787_312_262_148,
          sizeBytes: 42,
        }])}
        onConnect={vi.fn()}
        restoreBackup={restoreBackup}
        snapshot={{ ...snapshot, phase: "degraded", error: "Database corrupt." }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Restore/u }));
    expect(screen.getByRole("dialog")).toHaveTextContent("quarantine");
    const confirm = screen.getByRole("button", { name: "Quarantine and restore" });
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(restoreBackup).toHaveBeenCalledWith("automatic-1787312262148.dump.age");
    expect(restoreBackup).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingRestore.resolve();
      await pendingRestore.promise;
    });
  });

  it("reports a restore failure inside the active recovery confirmation", async () => {
    const user = userEvent.setup();
    render(
      <ManagedRuntimeSetupScreen
        flow="error"
        listBackups={vi.fn().mockResolvedValue([{
          id: "automatic-1787312262148.dump.age",
          kind: "automatic",
          createdAtMs: 1_787_312_262_148,
          sizeBytes: 42,
        }])}
        onConnect={vi.fn()}
        restoreBackup={vi.fn().mockRejectedValue(new Error("Backup authentication failed."))}
        snapshot={{ ...snapshot, phase: "degraded", error: "Database corrupt." }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Restore/u }));
    const confirmation = screen.getByRole("dialog", { name: "Recover the local Runtime database?" });
    await user.click(within(confirmation).getByRole("button", { name: "Quarantine and restore" }));

    const alert = await within(confirmation).findByRole("alert");
    expect(alert).toHaveTextContent("Could not restore recovery point");
    expect(alert).toHaveTextContent("Backup authentication failed.");
    expect(screen.getAllByText("Backup authentication failed.")).toHaveLength(1);
  });
});
