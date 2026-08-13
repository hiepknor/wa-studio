import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { SearchField } from "./SearchField";

function Harness() {
  const [value, setValue] = useState("");
  return (
    <SearchField
      label="Search records"
      onChange={setValue}
      placeholder="Search name or ID"
      value={value}
    />
  );
}

describe("SearchField", () => {
  it("uses the native search control and propagates changes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const search = screen.getByRole("searchbox", { name: "Search records" });

    await user.type(search, "release");
    expect(search).toHaveValue("release");
    expect(search).toHaveAttribute("type", "search");
  });
});
