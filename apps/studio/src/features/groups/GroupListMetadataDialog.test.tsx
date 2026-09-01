import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeGroupList } from "@/shared/api/runtime-client";
import { GroupListMetadataDialog } from "./GroupListMetadataDialog";
import {
  createGroupListMetadataDraft,
  editGroupListMetadataDraft,
  updateGroupListMetadataDraft,
  type GroupListMetadataDraft,
} from "./groups-workspace-state";

const list: RuntimeGroupList = {
  archivedAt: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  description: "Priority accounts",
  groupCount: 2,
  id: "list-1",
  membershipRevision: 3,
  name: "North America",
  revision: 4,
  sessionId: "session-1",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function ControlledDialog({
  initialDraft,
  onSave,
}: {
  initialDraft: GroupListMetadataDraft;
  onSave: () => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  return (
    <GroupListMetadataDialog
      draft={draft}
      fieldErrors={{}}
      hasUnconfirmedCreateIntent={false}
      onClose={vi.fn()}
      onRestoreUnconfirmedCreateIntent={vi.fn()}
      onSave={onSave}
      onUpdate={(metadata) => setDraft((current) =>
        updateGroupListMetadataDraft(current, metadata))}
      saveError={null}
      saving={false}
    />
  );
}

describe("GroupListMetadataDialog", () => {
  it("keeps new-list creation limited to name and description", async () => {
    const draft = createGroupListMetadataDraft({
      idempotencyKey: "create-key",
      memberIds: ["group-1", "group-2"],
      sessionId: "session-1",
      source: "selection",
    });
    render(<ControlledDialog initialDraft={draft} onSave={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "New list" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveFocus());
    expect(within(dialog).getByRole("textbox", { name: "Description · Optional" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("table")).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("2 selected groups");
    expect(within(dialog).getByRole("button", { name: "Create and add" })).toBeDisabled();
  });

  it("enables an edit save only after metadata changes", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ControlledDialog initialDraft={editGroupListMetadataDraft(list)} onSave={onSave} />);

    const dialog = screen.getByRole("dialog", { name: "Edit list" });
    const save = within(dialog).getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    const description = within(dialog).getByRole("textbox", { name: "Description · Optional" });
    await user.clear(description);
    await user.type(description, "Updated purpose");
    expect(save).toBeEnabled();
    await user.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
