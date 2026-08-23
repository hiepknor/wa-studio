import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeApi } from "@/shared/api/runtime-client";
import type { ManagedRuntimeSnapshot } from "@/shared/native/managed-runtime";
import { RuntimeConnectionProvider, useRuntimeConnection } from "./RuntimeConnectionContext";

function ConnectionObserver() {
  const { connected, disconnect, managedConnectionFlow } = useRuntimeConnection();
  return (
    <div>
      <span>{connected?.profile.baseUrl ?? "disconnected"}</span>
      <span>{managedConnectionFlow}</span>
      {connected && <button onClick={disconnect} type="button">Disconnect</button>}
    </div>
  );
}

const managedReady = (): ManagedRuntimeSnapshot => ({
  phase: "ready",
  manifest: {
    schemaVersion: 1,
    service: "wa-runtime",
    version: "0.1.0",
    contractVersion: "v1",
    profiles: ["desktop-managed"],
    roles: ["api", "worker", "scheduler", "migrate"],
    databaseBackends: ["postgres"],
    queueBackends: ["redis"],
  },
  connection: {
    baseUrl: "http://127.0.0.1:3100",
    transport: "native",
  },
  error: null,
});

describe("RuntimeConnectionProvider managed mode", () => {
  it("automatically connects when the supervisor reports a ready Runtime", async () => {
    const probeConnection = vi.fn().mockResolvedValue({
      sessionCount: 0,
      readySessions: 0,
      sessions: [],
    });

    render(
      <RuntimeConnectionProvider
        createApi={() => ({}) as RuntimeApi}
        discoverManagedRuntime={async () => managedReady()}
        probeConnection={probeConnection}
        subscribeToManagedRuntime={async () => () => undefined}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByText("http://127.0.0.1:3100")).toBeInTheDocument());
    expect(probeConnection).toHaveBeenCalledWith(managedReady().connection);
  });

  it("keeps remote connection mode available while provisioning is incomplete", async () => {
    const probeConnection = vi.fn();
    const snapshot: ManagedRuntimeSnapshot = {
      ...managedReady(),
      phase: "provisioningRequired",
      connection: null,
    };

    render(
      <RuntimeConnectionProvider
        discoverManagedRuntime={async () => snapshot}
        probeConnection={probeConnection}
        subscribeToManagedRuntime={async () => () => undefined}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByText("disconnected")).toBeInTheDocument());
    expect(probeConnection).not.toHaveBeenCalled();
  });

  it("returns a managed connection to configuration mode after disconnect", async () => {
    const user = userEvent.setup();
    render(
      <RuntimeConnectionProvider
        createApi={() => ({}) as RuntimeApi}
        discoverManagedRuntime={async () => managedReady()}
        probeConnection={vi.fn().mockResolvedValue({
          sessionCount: 0,
          readySessions: 0,
          sessions: [],
        })}
        subscribeToManagedRuntime={async () => () => undefined}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));

    expect(screen.getByText("disconnected")).toBeInTheDocument();
    expect(screen.getByText("configure")).toBeInTheDocument();
  });

  it("opens configuration mode when attaching to a ready Runtime fails", async () => {
    render(
      <RuntimeConnectionProvider
        createApi={() => ({}) as RuntimeApi}
        discoverManagedRuntime={async () => managedReady()}
        probeConnection={vi.fn().mockRejectedValue(new Error("Runtime API key was rejected."))}
        subscribeToManagedRuntime={async () => () => undefined}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
  });
});
