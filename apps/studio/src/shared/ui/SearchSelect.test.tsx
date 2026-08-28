import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { SearchSelect } from "./SearchSelect";

const OPTIONS = [
  { label: "All statuses", value: "ALL" },
  { group: "Queue", keywords: "waiting", label: "Pending", value: "PENDING" },
  { group: "Successful", label: "Delivered", value: "DELIVERED" },
  { group: "Exceptions", label: "Failed", value: "FAILED" },
] as const;

function Harness() {
  const [value, setValue] = useState<"ALL" | "PENDING" | "DELIVERED" | "FAILED">("ALL");
  return <SearchSelect label="Delivery status" onChange={setValue} options={OPTIONS} searchLabel="Search delivery statuses" value={value} />;
}

describe("SearchSelect", () => {
  it("filters grouped options and commits one selection", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Delivery status" });
    await user.click(trigger);
    const search = screen.getByRole("searchbox", { name: "Search delivery statuses" });
    expect(search).toHaveFocus();
    expect(screen.getByText("Queue")).toBeVisible();
    await user.type(search, "deliver");
    expect(screen.queryByRole("option", { name: "Pending" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Delivered" }));
    expect(trigger).toHaveTextContent("Delivered");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("returns focus to the trigger when escape closes the popover", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Delivery status" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
