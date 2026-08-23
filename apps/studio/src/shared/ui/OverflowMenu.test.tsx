import { render, screen } from "@testing-library/react";
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
});
