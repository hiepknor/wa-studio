import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Drawer, DrawerHost, DrawerProvider } from "./Drawer";

function DrawerHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <DrawerProvider data-testid="drawer-frame">
      <button onClick={() => setOpen(true)} ref={triggerRef} type="button">
        Inspect group
      </button>
      <Drawer
        description="2 members"
        eyebrow="Group inspector"
        footer={<button type="button">Footer action</button>}
        onClose={() => setOpen(false)}
        open={open}
        returnFocusRef={triggerRef}
        title="Release room"
      >
        <button type="button">Body action</button>
      </Drawer>
      <DrawerHost data-testid="drawer-host" />
    </DrawerProvider>
  );
}

const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

afterEach(() => {
  setViewportWidth(originalInnerWidth);
  vi.restoreAllMocks();
});

describe("Drawer", () => {
  it("behaves as a modal overlay, traps focus, closes with Escape, and restores focus", async () => {
    setViewportWidth(1100);
    const user = userEvent.setup();
    render(<DrawerHarness />);

    const trigger = screen.getByRole("button", { name: "Inspect group" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Release room" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("2 members");
    expect(screen.getByRole("heading", { name: "Release room" })).toHaveAttribute(
      "title",
      "Release room",
    );
    expect(trigger).toHaveProperty("inert", true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close drawer" })).toHaveFocus());

    screen.getByRole("button", { name: "Footer action" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close drawer" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger.inert).not.toBe(true);
    expect(trigger).toHaveFocus();
  });

  it("becomes a non-modal complementary panel when the workspace is wide", async () => {
    setViewportWidth(1100);
    const user = userEvent.setup();
    render(<DrawerHarness />);

    await user.click(screen.getByRole("button", { name: "Inspect group" }));
    expect(await screen.findByRole("dialog", { name: "Release room" })).toBeInTheDocument();

    setViewportWidth(1400);
    fireEvent(window, new Event("resize"));

    const panel = await screen.findByRole("complementary", { name: "Release room" });
    expect(panel).not.toHaveAttribute("aria-modal");
    expect(screen.getByTestId("drawer-frame")).toHaveAttribute("data-drawer-mode", "docked");
    expect(screen.getByTestId("drawer-host").querySelector(".drawer-backdrop")).toBeNull();
  });
});
