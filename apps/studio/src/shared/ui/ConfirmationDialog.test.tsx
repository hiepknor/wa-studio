import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    expect(trigger).toHaveProperty("inert", true);
    expect(document.body.style.overflow).toBe("hidden");
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
    expect(trigger.inert).not.toBe(true);
    expect(document.body.style.overflow).toBe("");
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
    expect(screen.queryByRole("button", { name: "Close confirmation" }))
      .not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    const backdrop = document.querySelector(".confirmation-dialog-backdrop");
    expect(backdrop).not.toBeNull();
    if (backdrop) fireEvent.pointerDown(backdrop);
    await user.click(screen.getByRole("button", { name: "Deleting…" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("consumes only one confirmation request per browser task", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmationDialog
        body="This action cannot be undone."
        confirmLabel="Delete"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        open
        title="Delete item?"
      />,
    );

    const confirm = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledOnce();
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

  it("announces an operation error inside the active modal", () => {
    render(
      <ConfirmationDialog
        body="The operation can be retried."
        confirmLabel="Retry"
        error="The service rejected the request."
        errorTitle="Request failed"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        open
        title="Continue?"
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Continue?" });
    const alert = screen.getByRole("alert");
    expect(dialog).toContainElement(alert);
    expect(alert).toHaveTextContent("Request failed");
    expect(alert).toHaveTextContent("The service rejected the request.");
  });
});
