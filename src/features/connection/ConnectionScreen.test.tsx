import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InkProvider } from "@hiepknor/ink-react";
import { describe, expect, it, vi } from "vitest";

import { ConnectionScreen } from "./ConnectionScreen";

function renderScreen(
  probeConnection: NonNullable<Parameters<typeof ConnectionScreen>[0]>["probeConnection"],
) {
  return render(
    <InkProvider density="compact">
      <ConnectionScreen probeConnection={probeConnection} />
    </InkProvider>,
  );
}

async function submitConnection() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Runtime API key"), "development-key");
  await user.click(screen.getByRole("button", { name: "Test connection" }));
}

describe("ConnectionScreen", () => {
  it("shows a loading state while the Runtime probe is pending", async () => {
    const probeConnection = vi.fn(
      () => new Promise<{ sessionCount: number; readySessions: number }>(() => undefined),
    );
    renderScreen(probeConnection);

    await submitConnection();

    expect(screen.getByRole("button", { name: "Checking Runtime connection" })).toBeDisabled();
    expect(screen.getByLabelText("Runtime URL")).toBeDisabled();
    expect(screen.getByLabelText("Runtime API key")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Verifying Runtime readiness");
  });

  it("submits with the keyboard and announces a readiness failure", async () => {
    const user = userEvent.setup();
    const probeConnection = vi
      .fn()
      .mockRejectedValue(new Error("Runtime is not ready (HTTP 503)."));
    renderScreen(probeConnection);

    const apiKeyField = screen.getByLabelText("Runtime API key");
    await user.type(apiKeyField, "development-key{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Runtime is not ready (HTTP 503).",
    );
  });

  it("announces a rejected API key", async () => {
    const probeConnection = vi.fn().mockRejectedValue(new Error("Runtime API key was rejected."));
    renderScreen(probeConnection);

    await submitConnection();

    expect(await screen.findByRole("alert")).toHaveTextContent("Runtime API key was rejected.");
  });

  it("reports session readiness after a successful probe", async () => {
    const probeConnection = vi.fn().mockResolvedValue({ sessionCount: 3, readySessions: 2 });
    renderScreen(probeConnection);

    await submitConnection();

    expect(await screen.findByRole("status")).toHaveTextContent("2 of 3 sessions ready.");
    expect(probeConnection).toHaveBeenCalledWith({
      apiKey: "development-key",
      baseUrl: "http://127.0.0.1:3100",
    });
  });
});
