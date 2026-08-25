import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

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
    await waitFor(() => expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus());

    screen.getByRole("button", { name: "Apply" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(applicationRoot?.inert).not.toBe(true);
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
});
