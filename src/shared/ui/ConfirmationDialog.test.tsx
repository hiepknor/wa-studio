import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationDialog } from "./ConfirmationDialog";

describe("ConfirmationDialog", () => {
  it("traps focus, closes with Escape, and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "Open delete dialog";
    document.body.append(trigger);
    trigger.focus();
    const view = render(
      <ConfirmationDialog
        body="This action cannot be undone."
        confirmLabel="Delete"
        onCancel={onCancel}
        onConfirm={vi.fn()}
        open
        title="Delete item?"
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();

    view.rerender(
      <ConfirmationDialog
        body="This action cannot be undone."
        confirmLabel="Delete"
        onCancel={onCancel}
        onConfirm={vi.fn()}
        open={false}
        title="Delete item?"
      />,
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it("blocks dismissal and duplicate submission while busy", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmationDialog
        body="Deleting the selected item."
        busy
        busyLabel="Deleting…"
        confirmLabel="Delete"
        confirmVariant="danger"
        onCancel={onCancel}
        onConfirm={onConfirm}
        open
        title="Delete item?"
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Delete item?" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(dialog).toHaveFocus();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Close confirmation" }));
    await user.click(screen.getByRole("button", { name: "Deleting…" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps focus trapped when confirmation is disabled", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmationDialog
        body="The item is not currently deletable."
        confirmDisabled
        confirmLabel="Delete"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        open
        title="Delete item?"
      />,
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });
});
