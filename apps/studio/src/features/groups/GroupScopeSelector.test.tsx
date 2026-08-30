import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeGroupList } from "@/shared/api/runtime-client";
import { GroupScopeSelector } from "./GroupScopeSelector";

const lists: RuntimeGroupList[] = [
  {
    archivedAt: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    description: "Launch operations",
    groupCount: 12,
    id: "list-1",
    membershipRevision: 2,
    name: "North America",
    revision: 3,
    sessionId: "session-1",
    updatedAt: "2026-08-25T00:00:00.000Z",
  },
];

describe("GroupScopeSelector", () => {
  it("opens into search, exposes grouped scopes, and selects a saved list", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onSelectList = vi.fn();
    render(
      <GroupScopeSelector
        directoryCount={128}
        lists={lists}
        onNewList={vi.fn()}
        onQueryChange={onQueryChange}
        onSelectDirectory={vi.fn()}
        onSelectList={onSelectList}
        query=""
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Group scope" });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search saved lists" })).toHaveFocus());
    expect(screen.getByRole("option", { name: /All groups/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /All groups/ })).toHaveTextContent("All groups128 groups");
    const savedOption = screen.getByRole("option", { name: /North America/ });
    expect(savedOption).toHaveTextContent("North America12 groupsLaunch operations");
    expect(screen.getByText("1 saved list · Current session only")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search saved lists" }), "north");
    expect(onQueryChange).toHaveBeenLastCalledWith("h");
    await user.click(screen.getByRole("option", { name: /North America/ }));
    expect(onSelectList).toHaveBeenCalledWith(lists[0]);
    expect(trigger).toHaveFocus();
  });

  it("does not unmount options when WebKit reports a null blur target", async () => {
    const user = userEvent.setup();
    const onSelectList = vi.fn();
    render(
      <GroupScopeSelector
        lists={lists}
        onNewList={vi.fn()}
        onQueryChange={vi.fn()}
        onSelectDirectory={vi.fn()}
        onSelectList={onSelectList}
        query=""
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    const search = screen.getByRole("searchbox", { name: "Search saved lists" });
    await waitFor(() => expect(search).toHaveFocus());

    search.blur();
    const savedOption = screen.getByRole("option", { name: /North America/ });
    await user.click(savedOption);

    expect(onSelectList).toHaveBeenCalledWith(lists[0]);
  });

  it("supports keyboard traversal and restores trigger focus on Escape", async () => {
    const user = userEvent.setup();
    render(
      <GroupScopeSelector
        lists={lists}
        onNewList={vi.fn()}
        onQueryChange={vi.fn()}
        onSelectDirectory={vi.fn()}
        onSelectList={vi.fn()}
        query=""
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Group scope" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const search = screen.getByRole("searchbox", { name: "Search saved lists" });
    await waitFor(() => expect(search).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /All groups/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("consumes search Escape and closes if the selector becomes disabled", async () => {
    const user = userEvent.setup();
    const onAncestorKeyDown = vi.fn();
    const selector = (disabled = false) => (
      <div onKeyDown={onAncestorKeyDown}>
        <GroupScopeSelector
          disabled={disabled}
          lists={lists}
          onNewList={vi.fn()}
          onQueryChange={vi.fn()}
          onSelectDirectory={vi.fn()}
          onSelectList={vi.fn()}
          query=""
        />
      </div>
    );
    const { rerender } = render(selector());
    const trigger = screen.getByRole("combobox", { name: "Group scope" });

    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search saved lists" })).toHaveFocus());
    onAncestorKeyDown.mockClear();
    await user.keyboard("{Escape}");
    expect(onAncestorKeyDown).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    rerender(selector(true));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps creation separate from scope navigation", async () => {
    const user = userEvent.setup();
    const onNewList = vi.fn();
    render(
      <GroupScopeSelector
        lists={[]}
        onNewList={onNewList}
        onQueryChange={vi.fn()}
        onSelectDirectory={vi.fn()}
        onSelectList={vi.fn()}
        query=""
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    const newList = screen.getByRole("button", { name: "New list" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("No saved lists")).toBeInTheDocument();
    expect(screen.getByText("Create one to reuse a group selection.")).toBeInTheDocument();
    expect(screen.getByText("Saved lists belong to the current session")).toBeInTheDocument();
    expect(newList).not.toHaveAttribute("role", "option");
    await user.click(newList);
    expect(onNewList).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("distinguishes an empty catalog from an empty search result", async () => {
    const user = userEvent.setup();
    render(
      <GroupScopeSelector
        lists={[]}
        onNewList={vi.fn()}
        onQueryChange={vi.fn()}
        onSelectDirectory={vi.fn()}
        onSelectList={vi.fn()}
        query="missing"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    expect(screen.getByText("No matching lists")).toBeInTheDocument();
    expect(screen.getByText("Try another list name.")).toBeInTheDocument();
    expect(screen.getByText("0 matching lists · Current session only")).toBeInTheDocument();
    expect(screen.queryByText("No saved lists")).not.toBeInTheDocument();
  });
});
