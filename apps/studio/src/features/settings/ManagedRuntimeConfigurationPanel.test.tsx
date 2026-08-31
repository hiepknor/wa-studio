import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/shared/ui/Toast";
import { ManagedRuntimeConfigurationPanel } from "./ManagedRuntimeConfigurationPanel";

const profile = {
  allowLiveSends: false,
  connectorPluginVersion: "0.1.0",
  openwaAllowedSessionIds: ["00000000-0000-4000-8000-000000000001"],
  openwaBaseUrl: "https://openwa.onio.cc",
  eventInboxBaseUrl: "https://wa-events.onio.cc",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("ManagedRuntimeConfigurationPanel", () => {
  it("re-pairs from fresh OpenWA credentials and explicit live-send confirmation", async () => {
    const user = userEvent.setup();
    const getProfile = vi.fn().mockResolvedValue(profile);
    const saveProfile = vi.fn().mockResolvedValue({ ...profile, allowLiveSends: true });

    render(
      <ToastProvider>
        <ManagedRuntimeConfigurationPanel
          getLifecycleStatus={vi.fn().mockResolvedValue(null)}
          getProfile={getProfile}
          phase="ready"
          saveProfile={saveProfile}
        />
      </ToastProvider>,
    );

    await screen.findByDisplayValue("https://openwa.onio.cc");
    expect(screen.getByText("1 session(s)")).toBeInTheDocument();
    expect(screen.getByText("https://wa-events.onio.cc")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook relay base URL")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("OpenWA API key"), "replacement-openwa-key");
    await user.click(screen.getByRole("switch", { name: /Allow live sends/ }));
    await user.click(screen.getByRole("button", { name: "Verify and restart Runtime" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("real OpenWA deliveries");
    await user.click(screen.getByRole("button", { name: "Enable live sends and restart" }));

    expect(saveProfile).toHaveBeenCalledWith({
      allowLiveSends: true,
      openwaApiKey: "replacement-openwa-key",
      openwaBaseUrl: "https://openwa.onio.cc",
    });
    expect(await screen.findByText("Connection updated")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenWA API key")).toHaveValue("");
  });

  it("keeps Event Inbox and session scope automatic during normal reconfiguration", async () => {
    const user = userEvent.setup();
    const saveProfile = vi.fn().mockResolvedValue(profile);
    render(
      <ToastProvider>
        <ManagedRuntimeConfigurationPanel
          getLifecycleStatus={vi.fn().mockResolvedValue(null)}
          getProfile={vi.fn().mockResolvedValue(profile)}
          phase="ready"
          saveProfile={saveProfile}
        />
      </ToastProvider>,
    );

    await screen.findByDisplayValue("https://openwa.onio.cc");
    await user.type(screen.getByLabelText("OpenWA API key"), "replacement-openwa-key");
    await user.click(screen.getByRole("button", { name: "Verify and restart Runtime" }));
    await user.click(screen.getByRole("button", { name: "Save and restart" }));

    expect(saveProfile).toHaveBeenCalledWith({
      allowLiveSends: false,
      openwaApiKey: "replacement-openwa-key",
      openwaBaseUrl: "https://openwa.onio.cc",
    });
  });

  it("reports and discards an unsaved connection draft without exposing the key", async () => {
    const user = userEvent.setup();
    const onNavigationStateChange = vi.fn();
    render(
      <ToastProvider>
        <ManagedRuntimeConfigurationPanel
          getLifecycleStatus={vi.fn().mockResolvedValue(null)}
          getProfile={vi.fn().mockResolvedValue(profile)}
          onNavigationStateChange={onNavigationStateChange}
          phase="ready"
          saveProfile={vi.fn()}
        />
      </ToastProvider>,
    );

    const endpoint = await screen.findByLabelText("OpenWA base URL");
    const key = screen.getByLabelText("OpenWA API key");
    const liveSends = screen.getByRole("switch", { name: /Allow live sends/ });
    await user.clear(endpoint);
    await user.type(endpoint, "https://replacement-openwa.onio.cc");
    await user.type(key, "replacement-openwa-key");
    await user.click(liveSends);

    expect(screen.getByText("Unsaved connection changes")).toBeInTheDocument();
    await waitFor(() => expect(onNavigationStateChange).toHaveBeenLastCalledWith({
      busy: false,
      dirty: true,
    }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(endpoint).toHaveValue(profile.openwaBaseUrl);
    expect(key).toHaveValue("");
    expect(liveSends).not.toBeChecked();
    expect(document.body).not.toHaveTextContent("replacement-openwa-key");
    expect(screen.getByText("Connection is saved")).toBeInTheDocument();
    await waitFor(() => expect(onNavigationStateChange).toHaveBeenLastCalledWith({
      busy: false,
      dirty: false,
    }));
  });

  it("redacts the submitted OpenWA key from native errors", async () => {
    const user = userEvent.setup();
    const apiKey = "replacement-openwa-key";
    const saveProfile = vi.fn().mockRejectedValue(
      new Error(`Credential ${apiKey} rejected`),
    );
    render(
      <ToastProvider>
        <ManagedRuntimeConfigurationPanel
          getLifecycleStatus={vi.fn().mockResolvedValue(null)}
          getProfile={vi.fn().mockResolvedValue(profile)}
          phase="ready"
          saveProfile={saveProfile}
        />
      </ToastProvider>,
    );

    await screen.findByDisplayValue("https://openwa.onio.cc");
    await user.type(screen.getByLabelText("OpenWA API key"), apiKey);
    await user.click(screen.getByRole("button", { name: "Verify and restart Runtime" }));
    await user.click(screen.getByRole("button", { name: "Save and restart" }));

    const dialog = screen.getByRole("dialog", { name: "Update Runtime connection?" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Connection verification failed");
    expect(alert).toHaveTextContent("Credential [redacted] rejected");
    expect(document.body).not.toHaveTextContent(apiKey);
  });

  it("dispatches only one Runtime reconfiguration for repeated confirmation", async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<typeof profile>();
    const saveProfile = vi.fn().mockReturnValue(pendingSave.promise);
    render(
      <ToastProvider>
        <ManagedRuntimeConfigurationPanel
          getLifecycleStatus={vi.fn().mockResolvedValue(null)}
          getProfile={vi.fn().mockResolvedValue(profile)}
          phase="ready"
          saveProfile={saveProfile}
        />
      </ToastProvider>,
    );

    await screen.findByDisplayValue(profile.openwaBaseUrl);
    await user.type(screen.getByLabelText("OpenWA API key"), "replacement-openwa-key");
    await user.click(screen.getByRole("button", { name: "Verify and restart Runtime" }));
    const confirm = screen.getByRole("button", { name: "Save and restart" });

    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(saveProfile).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingSave.resolve(profile);
      await pendingSave.promise;
    });
  });

  it("rotates one connector generation through an explicit single-flight confirmation", async () => {
    const user = userEvent.setup();
    const pendingRotation = deferred<typeof profile>();
    const rotateCredential = vi.fn().mockReturnValue(pendingRotation.promise);
    render(
      <ToastProvider>
        <ManagedRuntimeConfigurationPanel
          getLifecycleStatus={vi.fn().mockResolvedValue(null)}
          getProfile={vi.fn().mockResolvedValue(profile)}
          phase="ready"
          rotateCredential={rotateCredential}
        />
      </ToastProvider>,
    );

    await screen.findByDisplayValue(profile.openwaBaseUrl);
    await user.click(screen.getByRole("button", { name: "Rotate credential" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Rotate credential" });
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(rotateCredential).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveTextContent("fresh healthy connector heartbeat");
    await act(async () => {
      pendingRotation.resolve(profile);
      await pendingRotation.promise;
    });
    expect(await screen.findByText("Connector credential rotated")).toBeInTheDocument();
  });

  it("surfaces a durable interrupted reset and resumes only that recorded operation", async () => {
    const user = userEvent.setup();
    const resetConnection = vi.fn().mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <ManagedRuntimeConfigurationPanel
          getLifecycleStatus={vi.fn().mockResolvedValue({
            operation: "reset",
            phase: "remoteMutated",
          })}
          getProfile={vi.fn().mockResolvedValue(profile)}
          phase="ready"
          resetConnection={resetConnection}
        />
      </ToastProvider>,
    );

    expect(await screen.findByText("Connection maintenance requires recovery")).toBeInTheDocument();
    expect(screen.getByText(/OpenWA disconnect stopped during remote mutated/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotate credential" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Disconnect OpenWA" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("PostgreSQL data are preserved");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect OpenWA" }));

    expect(resetConnection).toHaveBeenCalledOnce();
    expect(await screen.findByText("OpenWA disconnected")).toBeInTheDocument();
  });
});
