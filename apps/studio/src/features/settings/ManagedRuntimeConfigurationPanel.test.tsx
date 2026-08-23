import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ManagedRuntimeConfigurationPanel } from "./ManagedRuntimeConfigurationPanel";

const profile = {
  allowLiveSends: false,
  openwaAllowedSessionIds: ["00000000-0000-4000-8000-000000000001"],
  openwaBaseUrl: "https://openwa.onio.cc",
  eventInboxBaseUrl: "https://wa-events.onio.cc",
};

describe("ManagedRuntimeConfigurationPanel", () => {
  it("re-pairs from fresh OpenWA credentials and explicit live-send confirmation", async () => {
    const user = userEvent.setup();
    const getProfile = vi.fn().mockResolvedValue(profile);
    const saveProfile = vi.fn().mockResolvedValue({ ...profile, allowLiveSends: true });

    render(
      <ManagedRuntimeConfigurationPanel
        getProfile={getProfile}
        phase="ready"
        saveProfile={saveProfile}
      />,
    );

    await screen.findByDisplayValue("https://openwa.onio.cc");
    expect(screen.getByText(/1 OpenWA session/)).toHaveTextContent("https://wa-events.onio.cc");
    expect(screen.queryByLabelText("Webhook relay base URL")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("OpenWA API key"), "replacement-openwa-key");
    await user.click(screen.getByRole("checkbox", { name: /Allow live sends/ }));
    await user.click(screen.getByRole("button", { name: "Verify and restart Runtime" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("real OpenWA sends");
    await user.click(screen.getByRole("button", { name: "Enable live sends and restart" }));

    expect(saveProfile).toHaveBeenCalledWith({
      allowLiveSends: true,
      openwaApiKey: "replacement-openwa-key",
      openwaBaseUrl: "https://openwa.onio.cc",
    });
    expect(await screen.findByText("Configuration saved")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenWA API key")).toHaveValue("");
  });

  it("keeps Event Inbox and session scope automatic during normal reconfiguration", async () => {
    const user = userEvent.setup();
    const saveProfile = vi.fn().mockResolvedValue(profile);
    render(
      <ManagedRuntimeConfigurationPanel
        getProfile={vi.fn().mockResolvedValue(profile)}
        phase="ready"
        saveProfile={saveProfile}
      />,
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
});
