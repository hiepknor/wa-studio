import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeApi,
  RuntimeOpenWASafetyScope,
} from "@/shared/api/runtime-client";
import { ToastProvider } from "@/shared/ui/Toast";
import { OpenWASafetySettings } from "./OpenWASafetySettings";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function snapshot(
  overrides: Partial<RuntimeOpenWASafetyScope> = {},
): RuntimeOpenWASafetyScope {
  return {
    scopeType: "SESSION",
    effectiveScopeType: "SESSION",
    circuitState: "CLOSED",
    rateMode: "NORMAL",
    status: "READY",
    reason: null,
    cooldownUntil: null,
    profile: "CANARY",
    policyVersion: 4,
    revision: 1,
    lastSuccessAt: "2026-08-29T08:00:00.000Z",
    lastFailureAt: null,
    updatedAt: "2026-08-29T08:00:00.000Z",
    ...overrides,
  };
}

describe("OpenWASafetySettings", () => {
  it("confirms a higher-throughput profile and replaces the rendered snapshot", async () => {
    const user = userEvent.setup();
    const api = {
      getOpenWASafety: vi.fn().mockResolvedValue(snapshot()),
      setOpenWASafetyProfile: vi.fn().mockResolvedValue(snapshot({
        profile: "STANDARD",
        revision: 2,
      })),
    } as unknown as RuntimeApi;

    render(
      <ToastProvider>
        <OpenWASafetySettings api={api} sessionId={SESSION_ID} sessionName="Production" />
      </ToastProvider>,
    );

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Safety profile" }));
    await user.click(screen.getByRole("option", { name: /Standard/ }));
    const dialog = screen.getByRole("dialog", { name: "Change safety profile?" });
    expect(dialog).toHaveTextContent("higher sustained send rate");
    await user.click(within(dialog).getByRole("button", { name: "Use Standard" }));

    await waitFor(() => expect(api.setOpenWASafetyProfile).toHaveBeenCalledWith(
      SESSION_ID,
      "STANDARD",
      expect.any(String),
    ));
    expect(await screen.findByText("Safety profile updated")).toBeInTheDocument();
  });

  it("explains the parent scope when it is the effective blocker", async () => {
    const api = {
      getOpenWASafety: vi.fn().mockResolvedValue(snapshot({
        effectiveScopeType: "UPSTREAM",
        status: "BLOCKED",
        reason: "UPSTREAM_OPERATOR_BLOCK",
      })),
    } as unknown as RuntimeApi;

    render(
      <ToastProvider>
        <OpenWASafetySettings api={api} sessionId={SESSION_ID} sessionName="Production" />
      </ToastProvider>,
    );

    expect(await screen.findByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("OpenWA upstream")).toBeInTheDocument();
    expect(screen.getByText("Reason: UPSTREAM_OPERATOR_BLOCK")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block session" })).toBeInTheDocument();
  });
});
