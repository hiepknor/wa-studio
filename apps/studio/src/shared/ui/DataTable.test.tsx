import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DataTable,
  DataTableEmptyCell,
  DataTableScroll,
  DataTableSelectionBar,
} from "./DataTable";

describe("DataTable", () => {
  it("requires an accessible caption and owns the production anatomy", () => {
    render(
      <DataTable caption="Runtime sessions" className="sessions-table">
        <thead><tr><th scope="col">Session</th></tr></thead>
        <tbody><tr><td>North America operations</td></tr></tbody>
      </DataTable>,
    );

    expect(screen.getByRole("table", { name: "Runtime sessions" })).toHaveClass(
      "ui-data-table",
      "sessions-table",
    );
  });

  it("exposes busy and updating state on the shared scroll owner", () => {
    render(
      <DataTableScroll busy updating className="sessions-table-scroll">
        <span>Rows</span>
      </DataTableScroll>,
    );

    const scrollOwner = screen.getByText("Rows").parentElement;
    expect(scrollOwner).toHaveClass("ui-data-table-scroll", "sessions-table-scroll");
    expect(scrollOwner).toHaveAttribute("aria-busy", "true");
    expect(scrollOwner).toHaveAttribute("data-updating", "true");
  });

  it("standardizes empty cells and selection feedback", () => {
    render(<>
      <DataTable caption="Empty groups">
        <tbody><tr><DataTableEmptyCell colSpan={3}>No groups</DataTableEmptyCell></tr></tbody>
      </DataTable>
      <DataTableSelectionBar
        actions={<button type="button">Clear</button>}
        active
        ariaLabel="Selected groups actions"
        detail="Choose a saved-list destination"
        selectedCount={2}
      />
    </>);

    expect(screen.getByText("No groups")).toHaveClass("ui-data-table-empty");
    const selection = screen.getByRole("region", { name: "Selected groups actions" });
    expect(selection).toHaveAttribute("data-active", "true");
    expect(selection).toHaveTextContent("2 selectedChoose a saved-list destinationClear");
  });
});
