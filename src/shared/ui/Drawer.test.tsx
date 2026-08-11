import { useRef, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Drawer,
  DrawerHost,
  DrawerProvider,
} from "./Drawer";
import { DRAWER_DOCK_MIN_WIDTH } from "./drawer-config";

function DrawerHarness({ title = "Release room" }: { title?: string }) {
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
        title={title}
      >
        <button type="button">Body action</button>
      </Drawer>
      <DrawerHost data-testid="drawer-host" />
    </DrawerProvider>
  );
}

function RetargetableDrawerHarness() {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState("none");
  const latestTriggerRef = useRef<HTMLButtonElement>(null);

  function openFrom(trigger: HTMLButtonElement) {
    latestTriggerRef.current = trigger;
    setSelection(trigger.textContent ?? "unknown");
    setOpen(true);
  }

  return (
    <DrawerProvider>
      <button onClick={(event) => openFrom(event.currentTarget)} type="button">First group</button>
      <button onClick={(event) => openFrom(event.currentTarget)} type="button">Second group</button>
      <Drawer
        onClose={() => setOpen(false)}
        open={open}
        returnFocusRef={latestTriggerRef}
        title={`Group details: ${selection}`}
      >
        Inspector content
      </Drawer>
      <DrawerHost />
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
  vi.unstubAllGlobals();
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
    expect(screen.getByTestId("drawer-frame")).toHaveAttribute("data-drawer-mode", "overlay");
    expect(dialog.closest(".drawer-layer")).toHaveAttribute("data-mode", "overlay");
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
    expect(screen.getByRole("dialog", { name: "Release room" })).toBeInTheDocument();
    expect(trigger).toHaveProperty("inert", true);
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

    act(() => {
      setViewportWidth(DRAWER_DOCK_MIN_WIDTH - 1);
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("dialog", { name: "Release room" })).toBeInTheDocument();

    act(() => {
      setViewportWidth(DRAWER_DOCK_MIN_WIDTH);
      window.dispatchEvent(new Event("resize"));
    });

    const panel = await screen.findByRole("complementary", { name: "Release room" });
    expect(panel).not.toHaveAttribute("aria-modal");
    expect(screen.getByTestId("drawer-frame")).toHaveAttribute("data-drawer-mode", "docked");
    expect(screen.getByTestId("drawer-host").querySelector(".drawer-backdrop")).toBeNull();
  });

  it("returns an open docked drawer to overlay mode when the viewport narrows", async () => {
    setViewportWidth(DRAWER_DOCK_MIN_WIDTH);
    const user = userEvent.setup();
    render(<DrawerHarness />);

    await user.click(screen.getByRole("button", { name: "Inspect group" }));
    expect(await screen.findByRole("complementary", { name: "Release room" }))
      .toBeInTheDocument();

    act(() => {
      setViewportWidth(820);
      window.dispatchEvent(new Event("resize"));
    });

    const dialog = await screen.findByRole("dialog", { name: "Release room" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("drawer-frame")).toHaveAttribute("data-drawer-mode", "overlay");
    expect(screen.getByTestId("drawer-host").querySelector(".drawer-backdrop"))
      .toBeInTheDocument();
  });

  it("keeps a long Vietnamese and unbroken entity name available in full", async () => {
    const longName = "Nhóm điều phối chiến dịch Đồng hồ cao cấp ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const user = userEvent.setup();
    render(<DrawerHarness title={longName} />);

    await user.click(screen.getByRole("button", { name: "Inspect group" }));

    const heading = await screen.findByRole("heading", { name: longName });
    expect(heading).toHaveAttribute("title", longName);
    expect(heading).toHaveClass("drawer-title");
  });

  it("restores docked focus to the most recent trigger", async () => {
    setViewportWidth(DRAWER_DOCK_MIN_WIDTH);
    const user = userEvent.setup();
    render(<RetargetableDrawerHarness />);

    await user.click(screen.getByRole("button", { name: "First group" }));
    expect(await screen.findByRole("complementary", { name: "Group details: First group" }))
      .toBeInTheDocument();
    const secondTrigger = screen.getByRole("button", { name: "Second group" });
    await user.click(secondTrigger);
    await user.click(screen.getByRole("button", { name: "Close drawer" }));

    await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
    expect(secondTrigger).toHaveFocus();
  });
});
