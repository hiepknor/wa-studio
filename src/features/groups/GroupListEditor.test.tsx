import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeApi,
  RuntimeGroup,
  RuntimeGroupListGroup,
  RuntimeSavedGroupList,
} from "@/shared/api/runtime-client";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { GroupListEditor } from "./GroupListEditor";

const sessionId = "session-id";
const savedList: RuntimeSavedGroupList = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId,
  name: "Launch groups",
  description: "Static launch selection",
  groupCount: 1,
  revision: 2,
  archivedAt: null,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

function group(id: string, name: string, status: "ALLOWED" | "DENIED" | "UNKNOWN" = "ALLOWED", isActive = true): RuntimeGroup {
  return {
    sessionId, id, name, description: null, ownerId: null, linkedParentId: null,
    participantsCount: 12, isAdmin: true, isReadOnly: false, isAnnounce: false,
    settingsLocked: false, isActive, detailsSyncedAt: null,
    syncedAt: "2026-08-15T00:00:00.000Z",
    sendCapability: { status, reason: "test", checkedAt: null, invalidatedAt: null, revision: 1 },
  };
}

function member(item: RuntimeGroup): RuntimeGroupListGroup {
  return {
    groupId: item.id,
    groupName: item.name,
    isActive: item.isActive,
    participantsCount: item.participantsCount,
    sendCapability: item.sendCapability,
  };
}

function renderEditor(list: RuntimeSavedGroupList | null, overrides: Partial<RuntimeApi> = {}) {
  const groups = [
    group("allowed@g.us", "Allowed room"),
    group("denied@g.us", "Denied room", "DENIED", false),
    group("unknown@g.us", "Unknown room", "UNKNOWN"),
  ];
  const api = {
    listGroups: vi.fn().mockResolvedValue({ data: groups, meta: { total: 3, limit: 20, offset: 0 } }),
    getGroupListMembership: vi.fn().mockResolvedValue({ list: savedList, data: [member(groups[1])] }),
    createGroupList: vi.fn(),
    updateGroupList: vi.fn(),
    replaceGroupListGroups: vi.fn(),
    archiveGroupList: vi.fn(),
    ...overrides,
  } as unknown as RuntimeApi;
  const onSaved = vi.fn();
  const onArchived = vi.fn();
  const onClose = vi.fn();
  render(<DrawerProvider><GroupListEditor api={api} list={list} onArchived={onArchived} onClose={onClose} onSaved={onSaved} sessionId={sessionId} /><DrawerHost /></DrawerProvider>);
  return { api, onArchived, onClose, onSaved };
}

describe("GroupListEditor", () => {
  it("creates an empty list and keeps one Idempotency-Key through retry/replay", async () => {
    const user = userEvent.setup();
    const created = { ...savedList, groupCount: 0 };
    const createGroupList = vi.fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(created);
    const getGroupListMembership = vi.fn().mockResolvedValue({ list: created, data: [] });
    const { onSaved } = renderEditor(null, { createGroupList, getGroupListMembership });
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Empty list");
    await user.click(screen.getByRole("button", { name: "Save list" }));
    expect(await screen.findByText("response lost")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save list" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
    expect(createGroupList).toHaveBeenCalledTimes(2);
    expect(createGroupList.mock.calls[0][0]).toEqual({ sessionId, name: "Empty list", description: null, groupIds: [] });
    expect(createGroupList.mock.calls[0][1]).toBe(createGroupList.mock.calls[1][1]);
    expect(createGroupList.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("selects the current page, including inactive DENIED and UNKNOWN groups, and creates atomically", async () => {
    const user = userEvent.setup();
    const created = { ...savedList, groupCount: 3 };
    const createGroupList = vi.fn().mockResolvedValue(created);
    const getGroupListMembership = vi.fn().mockResolvedValue({
      list: created,
      data: [
        member(group("allowed@g.us", "Allowed room")),
        member(group("denied@g.us", "Denied room", "DENIED", false)),
        member(group("unknown@g.us", "Unknown room", "UNKNOWN")),
      ],
    });
    const { onSaved } = renderEditor(null, { createGroupList, getGroupListMembership });
    expect(await screen.findByRole("checkbox", { name: "Select Denied room" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Select Unknown room" })).toBeEnabled();
    await user.click(screen.getByRole("checkbox", { name: "Select all groups on this page" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "All states");
    await user.click(screen.getByRole("button", { name: "Save list" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
    expect(createGroupList).toHaveBeenCalledWith(expect.objectContaining({
      groupIds: ["allowed@g.us", "denied@g.us", "unknown@g.us"],
    }), expect.any(String));
  });

  it("restores complete membership, saves metadata and replacement, and confirms archive/dirty close", async () => {
    const user = userEvent.setup();
    const denied = member(group("denied@g.us", "Denied room", "DENIED", false));
    const updated = { ...savedList, name: "Updated list", revision: 3 };
    const updateGroupList = vi.fn().mockResolvedValue(updated);
    const replaceGroupListGroups = vi.fn().mockResolvedValue({ list: updated, data: [] });
    const archiveGroupList = vi.fn().mockResolvedValue(undefined);
    const { onArchived, onClose, onSaved } = renderEditor(savedList, {
      getGroupListMembership: vi.fn().mockResolvedValue({ list: savedList, data: [denied] }),
      updateGroupList,
      replaceGroupListGroups,
      archiveGroupList,
    });
    expect(await screen.findByRole("checkbox", { name: "Select Denied room" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Select Denied room" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Updated list");
    await user.click(screen.getByRole("button", { name: "Save list" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
    expect(updateGroupList).toHaveBeenCalledWith(savedList.id, { name: "Updated list", description: savedList.description });
    expect(replaceGroupListGroups).toHaveBeenCalledWith(savedList.id, []);

    await user.click(screen.getByRole("button", { name: "Archive list" }));
    const archiveDialog = screen.getByRole("dialog", { name: "Archive group list?" });
    expect(archiveDialog).toHaveTextContent("Existing campaign target snapshots are not changed.");
    await user.click(archiveDialog.querySelector<HTMLButtonElement>(".button-danger")!);
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(savedList.id));

    await user.type(name, " dirty");
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(screen.getByRole("heading", { name: "Discard group list changes?" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps canonical saved membership and explicit staged changes when replacement fails", async () => {
    const user = userEvent.setup();
    const denied = member(group("denied@g.us", "Denied room", "DENIED", false));
    const metadataSaved = { ...savedList, name: "Metadata saved", revision: 3 };
    const getGroupListMembership = vi.fn()
      .mockResolvedValueOnce({ list: savedList, data: [denied] })
      .mockResolvedValueOnce({ list: metadataSaved, data: [denied] });
    const replaceGroupListGroups = vi.fn().mockRejectedValue(new Error("Membership replacement failed."));
    const { onSaved } = renderEditor(savedList, {
      getGroupListMembership,
      updateGroupList: vi.fn().mockResolvedValue(metadataSaved),
      replaceGroupListGroups,
    });
    const deniedCheckbox = await screen.findByRole("checkbox", { name: "Select Denied room" });
    await user.click(deniedCheckbox);
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Metadata saved");
    await user.click(screen.getByRole("button", { name: "Save list" }));
    expect(await screen.findByText("Membership replacement failed.")).toBeInTheDocument();
    await waitFor(() => expect(getGroupListMembership).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("checkbox", { name: "Select Denied room" })).not.toBeChecked();
    expect(screen.getByDisplayValue("Metadata saved")).toBeInTheDocument();
    expect(screen.getByText("0 selected · Not saved")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
