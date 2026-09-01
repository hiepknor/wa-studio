import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeSession } from "@/shared/api/runtime-client";
import { SessionSwitcher } from "./SessionSwitcher";

const session: RuntimeSession = {
  connectedAt: "2026-08-11T08:00:00.000Z",
  engineLoaded: true,
  gatewayCreatedAt: "2026-08-10T08:00:00.000Z",
  gatewayUpdatedAt: "2026-08-11T09:00:00.000Z",
  id: "session-id",
  lastActiveAt: "2026-08-11T09:00:00.000Z",
  lastError: null,
  name: "dev-session",
  phone: "84900000000",
  pushName: "Development",
  restriction: null,
  status: "ready",
  syncedAt: "2026-08-11T09:00:00.000Z",
};

const standbySession: RuntimeSession = {
  ...session,
  engineLoaded: false,
  id: "standby-session-id",
  name: "standby-session",
  status: "disconnected",
};

describe("SessionSwitcher", () => {
  it("opens from ArrowUp with the last session highlighted", async () => {
    const user = userEvent.setup();
    render(
      <SessionSwitcher
        onManageSessions={vi.fn()}
        onSelect={vi.fn()}
        selectedSessionId={session.id}
        sessions={[session, standbySession]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Active session" });
    trigger.focus();
    await user.keyboard("{ArrowUp}");

    const search = screen.getByRole("combobox", { name: "Search sessions" });
    await waitFor(() => expect(search).toHaveFocus());
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /standby-session/ }).id,
    );
  });

  it("consumes Escape and resets search after an outside close", async () => {
    const user = userEvent.setup();
    const onAncestorKeyDown = vi.fn();
    render(
      <div onKeyDown={onAncestorKeyDown}>
        <SessionSwitcher
          onManageSessions={vi.fn()}
          onSelect={vi.fn()}
          selectedSessionId={session.id}
          sessions={[session, standbySession]}
        />
        <button type="button">Outside</button>
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "Active session" });
    await user.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search sessions" });
    await user.type(search, "standby");
    onAncestorKeyDown.mockClear();
    await user.keyboard("{Escape}");
    expect(onAncestorKeyDown).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.type(screen.getByRole("combobox", { name: "Search sessions" }), "standby");
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("listbox", { name: "Gateway sessions" })).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole("combobox", { name: "Search sessions" })).toHaveValue("");
  });

  it("closes when the available session collection becomes empty", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SessionSwitcher
        onManageSessions={vi.fn()}
        onSelect={vi.fn()}
        selectedSessionId={session.id}
        sessions={[session]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Active session" }));
    expect(screen.getByRole("listbox", { name: "Gateway sessions" })).toBeInTheDocument();

    rerender(
      <SessionSwitcher
        onManageSessions={vi.fn()}
        onSelect={vi.fn()}
        selectedSessionId={null}
        sessions={[]}
      />,
    );
    expect(screen.queryByRole("listbox", { name: "Gateway sessions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active session" })).toBeDisabled();
  });
});
