import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SelectMenu } from "./SelectMenu";

const selectMenuCss = readFileSync("src/shared/ui/select-menu.css", "utf8");
const textFieldCss = readFileSync("src/shared/ui/text-field.css", "utf8");

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
  it("derives dropdown height from the shared field control token", () => {
    expect(textFieldCss).toContain("--field-control-font-size: 10px");
    expect(textFieldCss).toContain("--field-control-font-size: 12px");
    expect(textFieldCss).toContain("--field-control-height: 28px");
    expect(textFieldCss).toContain("--field-control-height: 36px");
    expect(textFieldCss).toContain("--field-control-height: 42px");
    expect(textFieldCss).toContain("height: var(--field-control-height)");
    expect(selectMenuCss).toContain("height: var(--field-control-height)");
    expect(selectMenuCss).toContain("font-size: var(--field-control-font-size)");
    expect(selectMenuCss).not.toMatch(/height:\s*(?:36|42)px/);
  });

  it("exposes a labelled combobox and selects an option from the shared listbox", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSelectMenu onChange={onChange} />);

    const trigger = screen.getByRole("combobox", { name: "Schedule" });
    expect(trigger.closest(".ui-field")).toHaveClass("ui-field-sm");
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

  it("opens upward when the rendered options would be clipped by an overflow ancestor", async () => {
    const user = userEvent.setup();
    const rect = (top: number, bottom: number) => ({
      bottom,
      height: bottom - top,
      left: 0,
      right: 320,
      toJSON: () => ({}),
      top,
      width: 320,
      x: 0,
      y: top,
    });
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this.classList.contains("select-boundary")) return rect(0, 240);
        if (this.getAttribute("role") === "combobox") return rect(150, 190);
        if (this.getAttribute("role") === "listbox") return rect(196, 326);
        return rect(0, 0);
      });
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function getScrollHeight(this: HTMLElement) {
        return this.getAttribute("role") === "listbox" ? 130 : 0;
      });

    render(
      <div className="select-boundary" style={{ overflow: "hidden" }}>
        <ControlledSelectMenu />
      </div>,
    );
    await user.click(screen.getByRole("combobox", { name: "Schedule" }));

    const listbox = screen.getByRole("listbox", { name: "Schedule" });
    expect(listbox).toHaveAttribute("data-placement", "up");
    expect(listbox).toHaveStyle({ maxHeight: "144px" });

    geometry.mockRestore();
    scrollHeight.mockRestore();
  });

  it("uses the shared field size contract", () => {
    const { rerender } = render(
      <SelectMenu
        label="Schedule"
        onChange={vi.fn()}
        options={OPTIONS}
        size="md"
        value="IMMEDIATE"
      />,
    );

    expect(screen.getByRole("combobox", { name: "Schedule" }).closest(".ui-field"))
      .toHaveClass("ui-field-md");

    rerender(
      <SelectMenu
        label="Schedule"
        onChange={vi.fn()}
        options={OPTIONS}
        size="sm"
        value="IMMEDIATE"
      />,
    );
    expect(screen.getByRole("combobox", { name: "Schedule" }).closest(".ui-field"))
      .toHaveClass("ui-field-sm");
  });
});
