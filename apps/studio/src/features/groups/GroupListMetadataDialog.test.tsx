import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GroupListMetadataDialog } from "./GroupListMetadataDialog";

describe("GroupListMetadataDialog", () => {
  it("starts with blank metadata, focuses Name, and describes the seed", async () => {
    render(
      <GroupListMetadataDialog
        onClose={vi.fn()}
        onContinue={vi.fn()}
        open
        seedCount={24}
        sessionName="North America ops"
      />,
    );

    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("");
    await waitFor(() => expect(name).toHaveFocus());
    expect(screen.getByText("North America ops")).toBeInTheDocument();
    expect(screen.getByText("24 groups")).toBeInTheDocument();
  });

  it("validates Name and emits normalized metadata without persisting", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(
      <GroupListMetadataDialog
        onClose={vi.fn()}
        onContinue={onContinue}
        open
        seedCount={0}
        sessionName="North America ops"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Name is required.")).toBeInTheDocument();
    expect(onContinue).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Name" }), "  Founder education  ");
    await user.type(screen.getByRole("textbox", { name: "Description · Optional" }), "  Core cohort  ");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledWith({
      description: "Core cohort",
      name: "Founder education",
    });
  });

  it("uses edit-specific framing when supplied by the membership workspace", () => {
    render(
      <GroupListMetadataDialog
        dialogDescription="Update details without leaving membership."
        eyebrow="List details"
        initialName="Founder education"
        onClose={vi.fn()}
        onContinue={vi.fn()}
        open
        seedCount={12}
        sessionName="North America ops"
        title="Edit list details"
      />,
    );

    expect(screen.getByText("List details")).toBeInTheDocument();
    expect(screen.getByText("Update details without leaving membership.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Founder education");
  });
});
