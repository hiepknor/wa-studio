import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeApi, RuntimeConnectionResult } from "@/shared/api/runtime-client";
import type { ManagedRuntimeSnapshot } from "@/shared/native/managed-runtime";
import { RuntimeConnectionProvider, useRuntimeConnection } from "./RuntimeConnectionContext";

function ConnectionObserver() {
  const {
    connected,
    disconnect,
    managedConnectionError,
    managedConnectionFlow,
    managedRuntime,
  } = useRuntimeConnection();
  return (
    <div>
      <span data-testid="connection-origin">{connected?.profile.baseUrl ?? "disconnected"}</span>
      <span data-testid="connection-flow">{managedConnectionFlow}</span>
      <span data-testid="managed-phase">{managedRuntime.phase}</span>
      {managedConnectionError && <span>{managedConnectionError}</span>}
      {connected && <button onClick={disconnect} type="button">Disconnect</button>}
    </div>
  );
}

function ConfigurationObserver() {
  const { configureManagedRuntime, managedConnectionError, managedConnectionFlow } =
    useRuntimeConnection();
  return (
    <div>
      <button
        onClick={() => void configureManagedRuntime({
          openwaApiKey: "submitted-openwa-key",
          openwaBaseUrl: "https://openwa.example.com",
        }).catch(() => undefined)}
        type="button"
      >
        Configure
      </button>
      <span>{managedConnectionFlow}</span>
      {managedConnectionError && <span>{managedConnectionError}</span>}
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

const managedReady = (): ManagedRuntimeSnapshot => ({
  phase: "ready",
  availability: "online",
  capabilities: {
    canRead: true,
    canEditDrafts: true,
    canSync: true,
    canLaunchCampaign: true,
    canSend: true,
  },
  maintenance: null,
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
    expect(probeConnection).toHaveBeenCalledWith(
      managedReady().connection,
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps remote connection mode available while provisioning is incomplete", async () => {
    const probeConnection = vi.fn();
    const snapshot: ManagedRuntimeSnapshot = {
      ...managedReady(),
      phase: "provisioningRequired",
      availability: "needsSetup",
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

  it("opens configuration when setup becomes required after initial discovery", async () => {
    let publishSnapshot: ((snapshot: ManagedRuntimeSnapshot) => void) | undefined;
    const discovering: ManagedRuntimeSnapshot = {
      ...managedReady(),
      phase: "discovering",
      availability: "starting",
      manifest: null,
      connection: null,
    };
    render(
      <RuntimeConnectionProvider
        discoverManagedRuntime={async () => discovering}
        subscribeToManagedRuntime={async handler => {
          publishSnapshot = handler;
          return () => undefined;
        }}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("connection-flow")).toHaveTextContent("starting"));
    act(() => publishSnapshot?.({
      ...managedReady(),
      phase: "provisioningRequired",
      availability: "needsSetup",
      connection: null,
    }));

    expect(screen.getByTestId("managed-phase")).toHaveTextContent("provisioningRequired");
    expect(screen.getByTestId("connection-flow")).toHaveTextContent("configure");
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

  it("aborts a managed connection probe when the provider unmounts", async () => {
    const probeConnection = vi.fn().mockReturnValue(new Promise(() => undefined));
    const view = render(
      <RuntimeConnectionProvider
        discoverManagedRuntime={async () => managedReady()}
        probeConnection={probeConnection}
        subscribeToManagedRuntime={async () => () => undefined}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(probeConnection).toHaveBeenCalledTimes(1));
    const signal = probeConnection.mock.calls[0][2]?.signal as AbortSignal | undefined;

    view.unmount();

    expect(signal?.aborted).toBe(true);
  });

  it("does not let a superseded attach failure overwrite a newer connection", async () => {
    const firstProbe = deferred<RuntimeConnectionResult>();
    let publishSnapshot: ((snapshot: ManagedRuntimeSnapshot) => void) | undefined;
    const probeConnection = vi.fn()
      .mockReturnValueOnce(firstProbe.promise)
      .mockResolvedValueOnce({ sessionCount: 0, readySessions: 0, sessions: [] });
    const initialSnapshot: ManagedRuntimeSnapshot = {
      ...managedReady(),
      connection: null,
      phase: "runtimeStarting",
      availability: "starting",
    };
    render(
      <RuntimeConnectionProvider
        createApi={() => ({}) as RuntimeApi}
        discoverManagedRuntime={async () => initialSnapshot}
        probeConnection={probeConnection}
        subscribeToManagedRuntime={async handler => {
          publishSnapshot = handler;
          return () => undefined;
        }}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(publishSnapshot).toBeDefined());

    act(() => publishSnapshot?.(managedReady()));
    await waitFor(() => expect(probeConnection).toHaveBeenCalledOnce());
    act(() => publishSnapshot?.({
      ...managedReady(),
      connection: { baseUrl: "http://127.0.0.1:3200", transport: "native" },
    }));

    await waitFor(() => {
      expect(screen.getByTestId("connection-origin")).toHaveTextContent(
        "http://127.0.0.1:3200",
      );
    });
    await act(async () => {
      firstProbe.reject(new Error("Stale Runtime attach failed."));
      await firstProbe.promise.catch(() => undefined);
    });

    expect(screen.getByTestId("connection-origin")).toHaveTextContent(
      "http://127.0.0.1:3200",
    );
    expect(screen.getByTestId("connection-flow")).toHaveTextContent("connected");
    expect(screen.queryByText("Stale Runtime attach failed.")).not.toBeInTheDocument();
  });

  it("does not apply a discovery snapshot after a newer supervisor event", async () => {
    const discovery = deferred<ManagedRuntimeSnapshot>();
    let publishSnapshot: ((snapshot: ManagedRuntimeSnapshot) => void) | undefined;
    render(
      <RuntimeConnectionProvider
        createApi={() => ({}) as RuntimeApi}
        discoverManagedRuntime={() => discovery.promise}
        probeConnection={vi.fn().mockResolvedValue({
          sessionCount: 0,
          readySessions: 0,
          sessions: [],
        })}
        subscribeToManagedRuntime={async handler => {
          publishSnapshot = handler;
          return () => undefined;
        }}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(publishSnapshot).toBeDefined());
    act(() => publishSnapshot?.(managedReady()));
    await waitFor(() => expect(screen.getByTestId("connection-flow")).toHaveTextContent("connected"));

    await act(async () => {
      discovery.resolve({
        ...managedReady(),
        connection: null,
        phase: "provisioningRequired",
        availability: "needsSetup",
      });
      await discovery.promise;
    });

    expect(screen.getByTestId("managed-phase")).toHaveTextContent("ready");
    expect(screen.getByTestId("connection-flow")).toHaveTextContent("connected");
  });

  it("does not apply a discovery failure after a newer supervisor event", async () => {
    const discovery = deferred<ManagedRuntimeSnapshot>();
    let publishSnapshot: ((snapshot: ManagedRuntimeSnapshot) => void) | undefined;
    render(
      <RuntimeConnectionProvider
        createApi={() => ({}) as RuntimeApi}
        discoverManagedRuntime={() => discovery.promise}
        probeConnection={vi.fn().mockResolvedValue({
          sessionCount: 0,
          readySessions: 0,
          sessions: [],
        })}
        subscribeToManagedRuntime={async handler => {
          publishSnapshot = handler;
          return () => undefined;
        }}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(publishSnapshot).toBeDefined());
    act(() => publishSnapshot?.(managedReady()));
    await waitFor(() => expect(screen.getByTestId("connection-flow")).toHaveTextContent("connected"));

    await act(async () => {
      discovery.reject(new Error("Stale discovery failed."));
      await discovery.promise.catch(() => undefined);
    });

    expect(screen.getByTestId("managed-phase")).toHaveTextContent("ready");
    expect(screen.getByTestId("connection-flow")).toHaveTextContent("connected");
  });

  it("detaches a stale native connection when the supervisor degrades", async () => {
    let publishSnapshot: ((snapshot: ManagedRuntimeSnapshot) => void) | undefined;
    const initialSnapshot: ManagedRuntimeSnapshot = {
      ...managedReady(),
      connection: null,
      phase: "runtimeStarting",
      availability: "starting",
    };
    render(
      <RuntimeConnectionProvider
        createApi={() => ({}) as RuntimeApi}
        discoverManagedRuntime={async () => initialSnapshot}
        probeConnection={vi.fn().mockResolvedValue({
          sessionCount: 0,
          readySessions: 0,
          sessions: [],
        })}
        subscribeToManagedRuntime={async handler => {
          publishSnapshot = handler;
          return () => undefined;
        }}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(publishSnapshot).toBeDefined());
    act(() => publishSnapshot?.(managedReady()));
    await waitFor(() => expect(screen.getByTestId("connection-flow")).toHaveTextContent("connected"));

    act(() => publishSnapshot?.({
      ...managedReady(),
      availability: "degraded",
      capabilities: {
        canRead: false,
        canEditDrafts: false,
        canSync: false,
        canLaunchCampaign: false,
        canSend: false,
      },
      connection: null,
      error: "Local services did not close safely.",
      phase: "degraded",
    }));

    expect(screen.getByTestId("connection-origin")).toHaveTextContent("disconnected");
    expect(screen.getByTestId("connection-flow")).toHaveTextContent("error");
    expect(screen.getByText("Local services did not close safely.")).toBeInTheDocument();
  });

  it("cancels an in-flight native attach when the supervisor degrades", async () => {
    const probe = deferred<RuntimeConnectionResult>();
    let publishSnapshot: ((snapshot: ManagedRuntimeSnapshot) => void) | undefined;
    const initialSnapshot: ManagedRuntimeSnapshot = {
      ...managedReady(),
      connection: null,
      phase: "runtimeStarting",
      availability: "starting",
    };
    render(
      <RuntimeConnectionProvider
        createApi={() => ({}) as RuntimeApi}
        discoverManagedRuntime={async () => initialSnapshot}
        probeConnection={vi.fn().mockReturnValue(probe.promise)}
        subscribeToManagedRuntime={async handler => {
          publishSnapshot = handler;
          return () => undefined;
        }}
      >
        <ConnectionObserver />
      </RuntimeConnectionProvider>,
    );
    await waitFor(() => expect(publishSnapshot).toBeDefined());
    act(() => publishSnapshot?.(managedReady()));
    await waitFor(() => expect(screen.getByTestId("connection-flow")).toHaveTextContent("attaching"));

    act(() => publishSnapshot?.({
      ...managedReady(),
      availability: "degraded",
      capabilities: {
        canRead: false,
        canEditDrafts: false,
        canSync: false,
        canLaunchCampaign: false,
        canSend: false,
      },
      connection: null,
      error: "Runtime stopped during attachment.",
      phase: "degraded",
    }));
    await act(async () => {
      probe.resolve({ sessionCount: 0, readySessions: 0, sessions: [] });
      await probe.promise;
    });

    expect(screen.getByTestId("connection-origin")).toHaveTextContent("disconnected");
    expect(screen.getByTestId("connection-flow")).toHaveTextContent("error");
    expect(screen.getByText("Runtime stopped during attachment.")).toBeInTheDocument();
  });

  it("redacts the submitted OpenWA key from managed provisioning errors", async () => {
    const user = userEvent.setup();
    const initialSnapshot: ManagedRuntimeSnapshot = {
      ...managedReady(),
      connection: null,
      phase: "provisioningRequired",
      availability: "needsSetup",
    };
    render(
      <RuntimeConnectionProvider
        discoverManagedRuntime={async () => initialSnapshot}
        provisionRuntime={vi.fn().mockRejectedValue(
          new Error("Credential submitted-openwa-key was rejected."),
        )}
        subscribeToManagedRuntime={async () => () => undefined}
      >
        <ConfigurationObserver />
      </RuntimeConnectionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Configure" }));

    expect(await screen.findByText("Credential [redacted] was rejected.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("submitted-openwa-key");
  });
});
