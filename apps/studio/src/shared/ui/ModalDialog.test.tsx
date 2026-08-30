import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ConfirmationDialog } from "./ConfirmationDialog";
import { ModalDialog } from "./ModalDialog";

function Harness({
  closeDisabled = false,
  focusBody = false,
}: {
  closeDisabled?: boolean;
  focusBody?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const bodyActionRef = useRef<HTMLButtonElement>(null);
  return (
    <main data-testid="application">
      <button onClick={() => setOpen(true)} type="button">Open workflow</button>
      <ModalDialog
        closeDisabled={closeDisabled}
        description="Choose a reusable snapshot."
        eyebrow="Group list"
        footer={<><button type="button">Back</button><button type="button">Apply</button></>}
        initialFocusRef={focusBody ? bodyActionRef : undefined}
        onClose={() => setOpen(false)}
        open={open}
        title="Apply group list"
      >
        <button ref={bodyActionRef} type="button">Body action</button>
      </ModalDialog>
    </main>
  );
}

function StackedHarness() {
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  return (
    <main data-testid="stacked-application">
      <button onClick={() => setWorkflowOpen(true)} type="button">Open stacked workflow</button>
      <ModalDialog
        onClose={() => setWorkflowOpen(false)}
        open={workflowOpen}
        title="Edit workflow"
      >
        <button onClick={() => setConfirmationOpen(true)} type="button">
          Review close
        </button>
      </ModalDialog>
      <ConfirmationDialog
        body="Both modal layers will close in the same commit."
        confirmLabel="Close workflow"
        onCancel={() => setConfirmationOpen(false)}
        onConfirm={() => {
          setWorkflowOpen(false);
          setConfirmationOpen(false);
        }}
        open={confirmationOpen}
        title="Close the workflow?"
      />
    </main>
  );
}

describe("ModalDialog", () => {
  it("portals above the application, traps focus, closes, and restores focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open workflow" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Apply group list" });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog).toHaveAccessibleDescription("Choose a reusable snapshot.");
    const applicationRoot = screen.getByTestId("application").parentElement;
    expect(applicationRoot).toHaveProperty("inert", true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.queryByRole("button", { name: "Close modal" }))
      .not.toBeInTheDocument();
    const latePortal = document.createElement("div");
    latePortal.dataset.testid = "late-portal";
    document.body.append(latePortal);
    await waitFor(() => expect(latePortal).toHaveProperty("inert", true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus());

    screen.getByRole("button", { name: "Apply" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(applicationRoot?.inert).not.toBe(true);
    expect(latePortal.inert).not.toBe(true);
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
    latePortal.remove();
  });

  it("dismisses from the visual backdrop without exposing a second close control", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open workflow" }));

    const backdrop = document.querySelector(".modal-dialog-backdrop");
    expect(backdrop).not.toBeNull();
    if (backdrop) fireEvent.pointerDown(backdrop);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open workflow" })).toHaveFocus();
  });

  it("restores application isolation and root focus when stacked layers close together", async () => {
    const user = userEvent.setup();
    render(<StackedHarness />);
    const trigger = screen.getByRole("button", { name: "Open stacked workflow" });
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Review close" }));

    const modalLayer = document.querySelector<HTMLElement>(".modal-dialog-layer");
    const confirmationLayer = document.querySelector<HTMLElement>(".confirmation-dialog-layer");
    expect(modalLayer).toHaveProperty("inert", true);
    expect(confirmationLayer?.inert).not.toBe(true);
    expect(document.body.style.overflow).toBe("hidden");

    await user.click(screen.getByRole("button", { name: "Close workflow" }));

    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(screen.getByTestId("stacked-application").parentElement?.inert).not.toBe(true);
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
  });

  it("prevents dismissing a mutation in progress", async () => {
    const user = userEvent.setup();
    render(<Harness closeDisabled />);
    await user.click(screen.getByRole("button", { name: "Open workflow" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Apply group list" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
  });

  it("supports a workflow-specific initial focus target", async () => {
    const user = userEvent.setup();
    render(<Harness focusBody />);
    await user.click(screen.getByRole("button", { name: "Open workflow" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Body action" })).toHaveFocus());
  });

  it("does not steal focus already moved inside the dialog", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open workflow" }));
    const bodyAction = screen.getByRole("button", { name: "Body action" });
    bodyAction.focus();

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    expect(bodyAction).toHaveFocus();
  });
});
