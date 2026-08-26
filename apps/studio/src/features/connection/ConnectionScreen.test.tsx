import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConnectionScreen } from "./ConnectionScreen";

function renderScreen(
  probeConnection: NonNullable<Parameters<typeof ConnectionScreen>[0]>["probeConnection"],
) {
  return render(<ConnectionScreen probeConnection={probeConnection} />);
}

async function submitConnection() {
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("External Runtime base URL"),
    "https://wa-runtime.example.com",
  );
  await user.type(screen.getByLabelText("External Runtime API key"), "development-key");
  await user.click(screen.getByRole("button", { name: "Attach external Runtime" }));
}

describe("ConnectionScreen", () => {
  it("identifies direct Runtime attachment as a developer fallback", () => {
    renderScreen(vi.fn());

    expect(screen.getByRole("heading", { name: "Attach an external Runtime" })).toBeInTheDocument();
    expect(screen.getByText("Developer mode")).toBeInTheDocument();
    expect(screen.getByLabelText("External Runtime base URL"))
      .toHaveValue("");
    expect(screen.getByPlaceholderText("http://127.0.0.1:34100"))
      .toBeInTheDocument();
    expect(screen.getByText("The API key remains in memory and is never written to disk."))
      .toBeInTheDocument();
    expect(screen.getByRole("form", { name: "WA Runtime connection" }))
      .toHaveClass("connection-setup-card");
    expect(document.querySelector(".connection-terminal-bar")).not.toBeInTheDocument();
  });

  it("shows a loading state while the Runtime probe is pending", async () => {
    const probeConnection = vi.fn(
      () =>
        new Promise<{ sessionCount: number; readySessions: number; sessions: [] }>(
          () => undefined,
        ),
    );
    renderScreen(probeConnection);

    await submitConnection();

    expect(screen.getByRole("button", { name: "Attaching external Runtime" })).toBeDisabled();
    expect(screen.getByLabelText("External Runtime base URL")).toBeDisabled();
    expect(screen.getByLabelText("External Runtime API key")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Attaching external Runtime");
  });

  it("submits with the keyboard and announces a readiness failure", async () => {
    const user = userEvent.setup();
    const probeConnection = vi
      .fn()
      .mockRejectedValue(new Error("WA Runtime is not ready (HTTP 503)."));
    renderScreen(probeConnection);

    await user.type(
      screen.getByLabelText("External Runtime base URL"),
      "https://wa-runtime.example.com",
    );
    const apiKeyField = screen.getByLabelText("External Runtime API key");
    await user.type(apiKeyField, "development-key{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "WA Runtime is not ready (HTTP 503).",
    );
  });

  it("announces a rejected API key", async () => {
    const probeConnection = vi.fn().mockRejectedValue(new Error("WA Runtime API key was rejected."));
    renderScreen(probeConnection);

    await submitConnection();

    expect(await screen.findByRole("alert")).toHaveTextContent("WA Runtime API key was rejected.");
  });

  it("reports session readiness after a successful probe", async () => {
    const probeConnection = vi
      .fn()
      .mockResolvedValue({ sessionCount: 3, readySessions: 2, sessions: [] });
    renderScreen(probeConnection);

    await submitConnection();

    expect(await screen.findByRole("status")).toHaveTextContent("2 of 3 sessions ready.");
    expect(probeConnection).toHaveBeenCalledWith({
      apiKey: "development-key",
      baseUrl: "https://wa-runtime.example.com",
    });
  });
});
