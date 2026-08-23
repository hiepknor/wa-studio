import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ManagedRuntimeSnapshot } from "@/shared/native/managed-runtime";
import { ManagedRuntimeSetupScreen } from "./ManagedRuntimeSetupScreen";

const snapshot: ManagedRuntimeSnapshot = {
  phase: "provisioningRequired",
  manifest: { schemaVersion: 1, service: "wa-runtime", version: "0.1.0", contractVersion: "v1", profiles: ["desktop-managed"], roles: ["api", "worker", "scheduler"], databaseBackends: ["postgres"], queueBackends: ["postgres"] },
  connection: null,
  error: null,
};

describe("ManagedRuntimeSetupScreen", () => {
  it("submits only the OpenWA URL and API key", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn().mockResolvedValue(undefined);
    render(<ManagedRuntimeSetupScreen flow="configure" onConnect={onConnect} snapshot={snapshot} />);
    await user.type(screen.getByLabelText("OpenWA base URL"), "https://openwa.onio.cc");
    await user.type(screen.getByLabelText("OpenWA API key"), "openwa-key");
    await user.click(screen.getByRole("button", { name: "Connect OpenWA" }));
    expect(onConnect).toHaveBeenCalledWith({ openwaBaseUrl: "https://openwa.onio.cc", openwaApiKey: "openwa-key" });
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

  it("offers transactional local recovery while the managed database is degraded", async () => {
    const user = userEvent.setup();
    const restoreBackup = vi.fn().mockResolvedValue(undefined);
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
    await user.click(screen.getByRole("button", { name: "Quarantine and restore" }));

    expect(restoreBackup).toHaveBeenCalledWith("automatic-1787312262148.dump.age");
  });
});
