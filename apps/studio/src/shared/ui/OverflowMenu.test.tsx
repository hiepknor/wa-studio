import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DropdownMenuItem, DropdownMenuSeparator } from "./DropdownMenu";
import { OverflowMenu } from "./OverflowMenu";

describe("OverflowMenu", () => {
  it("standardizes the trigger, portaled menu, and keyboard navigation", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <OverflowMenu ariaLabel="Resource actions" triggerLabel="More actions for resource">
        <DropdownMenuItem
          description="Edit resource details."
          icon="edit"
          onSelect={onEdit}
        >
          Edit resource
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger icon="trash" onSelect={onDelete}>Delete resource</DropdownMenuItem>
      </OverflowMenu>,
    );

    const trigger = screen.getByRole("button", { name: "More actions for resource" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("menu", { name: "Resource actions" })).toBeInTheDocument();
    const editItem = screen.getByRole("menuitem", { name: "Edit resource" });
    expect(editItem).toHaveFocus();
    expect(editItem).toHaveAccessibleDescription("Edit resource details.");
    expect(screen.getByRole("separator")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onDelete).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it("opens from ArrowUp at the last item", async () => {
    const user = userEvent.setup();
    render(
      <OverflowMenu ariaLabel="Resource actions" triggerLabel="More actions for resource">
        <DropdownMenuItem icon="edit" onSelect={vi.fn()}>Edit resource</DropdownMenuItem>
        <DropdownMenuItem danger icon="trash" onSelect={vi.fn()}>Delete resource</DropdownMenuItem>
      </OverflowMenu>,
    );

    const trigger = screen.getByRole("button", { name: "More actions for resource" });
    trigger.focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Delete resource" })).toHaveFocus();
  });

  it("consumes Escape inside a portaled menu before an overlay ancestor can handle it", async () => {
    const user = userEvent.setup();
    const onAncestorKeyDown = vi.fn();
    render(
      <div onKeyDown={onAncestorKeyDown}>
        <OverflowMenu ariaLabel="Resource actions" triggerLabel="More actions for resource">
          <DropdownMenuItem icon="edit" onSelect={vi.fn()}>Edit resource</DropdownMenuItem>
        </OverflowMenu>
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "More actions for resource" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    onAncestorKeyDown.mockClear();
    await user.keyboard("{Escape}");

    expect(onAncestorKeyDown).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps a portaled menu inside the viewport when its content is wider than the viewport", async () => {
    const user = userEvent.setup();
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 200 });
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        const isMenu = this.getAttribute("role") === "menu";
        return {
          bottom: isMenu ? 140 : 40,
          height: isMenu ? 120 : 32,
          left: isMenu ? 0 : 10,
          right: isMenu ? 300 : 42,
          toJSON: () => ({}),
          top: isMenu ? 20 : 8,
          width: isMenu ? 300 : 32,
          x: isMenu ? 0 : 10,
          y: isMenu ? 20 : 8,
        };
      });

    render(
      <OverflowMenu ariaLabel="Resource actions" triggerLabel="More actions for resource">
        <DropdownMenuItem icon="edit" onSelect={vi.fn()}>Edit resource</DropdownMenuItem>
      </OverflowMenu>,
    );
    await user.click(screen.getByRole("button", { name: "More actions for resource" }));

    await waitFor(() => expect(screen.getByRole("menu")).toHaveStyle({ left: "8px" }));
    geometry.mockRestore();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  });
});
