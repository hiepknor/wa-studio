import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SelectMenu } from "./SelectMenu";

const OPTIONS = [
  { description: "No scheduled timestamp.", label: "Immediate", value: "IMMEDIATE" },
  { description: "Send at one scheduled time.", label: "Once", value: "ONCE" },
] as const;

function ControlledSelectMenu({ onChange = vi.fn() }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState<"IMMEDIATE" | "ONCE">("IMMEDIATE");
  return (
    <SelectMenu
      description="Runtime schedule policy."
      label="Schedule"
      onChange={(nextValue) => {
        setValue(nextValue);
        onChange(nextValue);
      }}
      options={OPTIONS}
      value={value}
    />
  );
}

describe("SelectMenu", () => {
  it("exposes a labelled combobox and selects an option from the shared listbox", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSelectMenu onChange={onChange} />);

    const trigger = screen.getByRole("combobox", { name: "Schedule" });
    expect(trigger).toHaveAccessibleDescription("Runtime schedule policy.");
    expect(trigger).toHaveTextContent("Immediate");

    await user.click(trigger);
    expect(screen.getByRole("listbox", { name: "Schedule" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Immediate/ })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("option", { name: /Once/ }));

    expect(onChange).toHaveBeenCalledWith("ONCE");
    expect(trigger).toHaveTextContent("Once");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("supports arrow navigation, selection, and Escape focus restoration", async () => {
    const user = userEvent.setup();
    render(<ControlledSelectMenu />);
    const trigger = screen.getByRole("combobox", { name: "Schedule" });
    trigger.focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Immediate/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(trigger).toHaveTextContent("Once");
    expect(trigger).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not open when disabled", async () => {
    const user = userEvent.setup();
    render(
      <SelectMenu
        disabled
        label="Schedule"
        onChange={vi.fn()}
        options={OPTIONS}
        value="IMMEDIATE"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Schedule" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
