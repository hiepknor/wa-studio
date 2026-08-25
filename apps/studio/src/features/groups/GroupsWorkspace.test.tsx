import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import type {
  RuntimeApi,
  RuntimeGroup,
  RuntimeGroupList,
  RuntimeGroupListGroup,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import { RuntimeRequestError } from "@/shared/api/runtime-client";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { ToastProvider } from "@/shared/ui/Toast";
import { GroupsWorkspace } from "./GroupsWorkspace";

const session: RuntimeSession = {
  connectedAt: null,
  engineLoaded: true,
  gatewayCreatedAt: "2026-08-15T00:00:00.000Z",
  gatewayUpdatedAt: "2026-08-15T00:00:00.000Z",
  id: "primary-session",
  lastActiveAt: null,
  lastError: null,
  name: "Primary",
  phone: null,
  pushName: null,
  restriction: null,
  status: "ready",
  syncedAt: "2026-08-15T00:00:00.000Z",
};

const savedList: RuntimeGroupList = {
  archivedAt: null,
  createdAt: "2026-08-15T00:00:00.000Z",
  description: "Static launch selection",
  groupCount: 1,
  id: "11111111-1111-4111-8111-111111111111",
  membershipRevision: 2,
  name: "Launch groups",
  revision: 4,
  sessionId: session.id,
  updatedAt: "2026-08-15T00:00:00.000Z",
};

const group: RuntimeGroup = {
  description: null,
  detailsSyncedAt: "2026-08-15T00:00:00.000Z",
  id: "launch@g.us",
  isActive: true,
  isAdmin: true,
  isAnnounce: false,
  isReadOnly: false,
  linkedParentId: null,
  name: "Launch group",
  ownerId: null,
  participantsCount: 42,
  sendCapability: {
    checkedAt: "2026-08-15T00:00:00.000Z",
    invalidatedAt: null,
    reason: "SEND_ALLOWED",
    revision: 1,
    status: "ALLOWED",
  },
  sessionId: session.id,
  settingsLocked: false,
  syncedAt: "2026-08-15T00:00:00.000Z",
};

const member: RuntimeGroupListGroup = {
  groupId: group.id,
  groupName: group.name,
  isActive: group.isActive,
  participantsCount: group.participantsCount,
  sendCapability: group.sendCapability,
  syncedAt: group.syncedAt,
};

function Harness() {
  const { connect, connected } = useRuntimeConnection();
  if (!connected) {
    return (
      <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "key" })}>
        Connect
      </button>
    );
  }
  return (
    <DrawerProvider>
      <GroupsWorkspace />
      <DrawerHost />
    </DrawerProvider>
  );
}

function renderWorkspace(overrides: Partial<RuntimeApi> = {}) {
  const api = {
    archiveGroupList: vi.fn().mockResolvedValue(undefined),
    createGroupList: vi.fn().mockResolvedValue(savedList),
    getGroupList: vi.fn().mockResolvedValue(savedList),
    getGroupListMembership: vi.fn().mockResolvedValue({ data: [member], list: savedList }),
    listGroupLists: vi.fn().mockResolvedValue({
      data: [savedList],
      meta: { limit: 50, offset: 0, total: 1 },
    }),
    listGroups: vi.fn().mockResolvedValue({
      data: [group],
      meta: { limit: 20, offset: 0, total: 1 },
    }),
    replaceGroupListGroups: vi.fn().mockResolvedValue({ data: [member], list: savedList }),
    updateGroupList: vi.fn().mockResolvedValue(savedList),
    ...overrides,
  } as unknown as RuntimeApi;
  render(
    <ToastProvider>
      <RuntimeConnectionProvider
        createApi={() => api}
        probeConnection={vi.fn().mockResolvedValue({
          readySessions: 1,
          sessionCount: 1,
          sessions: [session],
        })}
      >
        <Harness />
      </RuntimeConnectionProvider>
    </ToastProvider>,
  );
  return api;
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("combobox", { name: "Group scope" });
}

async function chooseScope(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("combobox", { name: "Group scope" }));
  await user.click(await screen.findByRole("option", { name }));
}

describe("GroupsWorkspace unified canvas", () => {
  it("has one Groups destination and loads directory plus saved scopes", async () => {
    const user = userEvent.setup();
    const api = renderWorkspace();
    await connect(user);

    expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "All groups" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Group lists" })).not.toBeInTheDocument();
    expect(await screen.findByText(group.name)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    expect(await screen.findByRole("option", { name: /Launch groups/ })).toBeInTheDocument();
    expect(api.listGroups).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id }));
    expect(api.listGroupLists).toHaveBeenCalledWith({ sessionId: session.id, limit: 50, offset: 0 });
  });

  it("renders a saved list in the same table without editable selection", async () => {
    const user = userEvent.setup();
    const api = renderWorkspace();
    await connect(user);
    await chooseScope(user, /Launch groups/);

    expect(await screen.findByText("Saved static list")).toBeInTheDocument();
    expect(api.getGroupListMembership).toHaveBeenCalledWith(savedList.id);
    const table = screen.getByRole("table", { name: `Groups saved in ${savedList.name}` });
    expect(within(table).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(table).getByText(group.name)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
  });

  it("creates an empty list only after the metadata and membership steps", async () => {
    const user = userEvent.setup();
    const created = { ...savedList, groupCount: 0, name: "Empty cohort" };
    const createGroupList = vi.fn().mockResolvedValue(created);
    const getGroupListMembership = vi.fn().mockResolvedValue({ data: [], list: created });
    renderWorkspace({ createGroupList, getGroupListMembership });
    await connect(user);

    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    await user.click(screen.getByRole("button", { name: /New list/ }));
    const dialog = screen.getByRole("dialog", { name: "Create group list" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Empty cohort");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));

    expect(screen.getByText("New list draft")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search groups for this list" })).toHaveFocus());
    expect(createGroupList).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createGroupList).toHaveBeenCalledWith({
      description: null,
      groupIds: [],
      name: "Empty cohort",
      sessionId: session.id,
    }, expect.any(String)));
    expect(await screen.findByText("Group list saved")).toBeInTheDocument();
  });

  it("preserves directory selection after saving it as a list", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await connect(user);
    const checkbox = await screen.findByRole("checkbox", { name: `Select ${group.name}` });
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Save as list · 1" }));
    const dialog = screen.getByRole("dialog", { name: "Create group list" });
    expect(within(dialog).getByText("1 groups")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), savedList.name);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved static list");

    await chooseScope(user, /All groups/);
    expect(await screen.findByRole("checkbox", { name: `Select ${group.name}` })).toBeChecked();
  });

  it("guards dirty scope changes and retains the draft when cancelled", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await connect(user);
    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    await user.click(screen.getByRole("button", { name: /New list/ }));
    const dialog = screen.getByRole("dialog", { name: "Create group list" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Draft cohort");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));

    await chooseScope(user, /All groups/);
    const confirm = screen.getByRole("dialog", { name: "Discard group list changes?" });
    await user.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByText("New list draft")).toBeInTheDocument();

    await chooseScope(user, /All groups/);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByText("New list draft")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Group scope" })).toHaveTextContent("All groups");
  });

  it("deletes a saved list from its context without changing campaigns", async () => {
    const user = userEvent.setup();
    const archiveGroupList = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({ archiveGroupList });
    await connect(user);
    await chooseScope(user, /Launch groups/);
    await screen.findByText("Saved static list");

    await user.click(screen.getByRole("button", { name: `More actions for ${savedList.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete list/ }));
    const dialog = screen.getByRole("dialog", { name: "Delete group list?" });
    expect(dialog).toHaveTextContent("Existing campaigns and their current targets will not be changed.");
    await user.click(within(dialog).getByRole("button", { name: "Delete list" }));

    await waitFor(() => expect(archiveGroupList).toHaveBeenCalledWith(savedList.id, savedList.revision));
    expect(await screen.findByText("Group list deleted")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Group scope" })).toHaveTextContent("All groups");
  });

  it("saves edited metadata before membership with canonical revisions", async () => {
    const user = userEvent.setup();
    const metadataList = { ...savedList, name: "Launch groups v2", revision: 5 };
    const finalList = {
      ...metadataList,
      groupCount: 0,
      membershipRevision: 3,
      revision: 6,
    };
    const updateGroupList = vi.fn().mockResolvedValue(metadataList);
    const replaceGroupListGroups = vi.fn().mockResolvedValue({ data: [], list: finalList });
    renderWorkspace({ replaceGroupListGroups, updateGroupList });
    await connect(user);
    await chooseScope(user, /Launch groups/);
    await screen.findByText("Saved static list");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("checkbox", { name: `Select ${group.name}` }));
    await user.click(screen.getByRole("button", { name: "Details" }));
    const details = screen.getByRole("dialog", { name: "Edit list details" });
    const name = within(details).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, metadataList.name);
    await user.click(within(details).getByRole("button", { name: "Apply details" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateGroupList).toHaveBeenCalledWith(savedList.id, {
      description: savedList.description,
      expectedRevision: savedList.revision,
      name: metadataList.name,
    }));
    expect(replaceGroupListGroups).toHaveBeenCalledWith(
      savedList.id,
      [],
      metadataList.membershipRevision,
    );
    expect(await screen.findByText("Saved static list")).toBeInTheDocument();
  });

  it("reloads canonical membership after a conflict while retaining staged changes", async () => {
    const user = userEvent.setup();
    const latest = { ...savedList, membershipRevision: 3, revision: 5 };
    const getGroupListMembership = vi.fn()
      .mockResolvedValueOnce({ data: [member], list: savedList })
      .mockResolvedValue({ data: [member], list: latest });
    const replaceGroupListGroups = vi.fn().mockRejectedValue(
      new RuntimeRequestError("opaque", {
        code: "GROUP_LIST_REVISION_CONFLICT",
        status: 409,
      }),
    );
    renderWorkspace({ getGroupListMembership, replaceGroupListGroups });
    await connect(user);
    await chooseScope(user, /Launch groups/);
    await screen.findByText("Saved static list");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const checkbox = screen.getByRole("checkbox", { name: `Select ${group.name}` });
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/changed concurrently/)).toBeInTheDocument();
    expect(replaceGroupListGroups).toHaveBeenCalledWith(savedList.id, [], savedList.membershipRevision);
    await waitFor(() => expect(getGroupListMembership).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("checkbox", { name: `Select ${group.name}` })).not.toBeChecked();
    expect(screen.getByText(/Saved 1 · Staged 0/)).toBeInTheDocument();
  });

  it("reuses the create idempotency key across a retry", async () => {
    const user = userEvent.setup();
    const createGroupList = vi.fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValue(savedList);
    renderWorkspace({ createGroupList });
    await connect(user);
    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    await user.click(screen.getByRole("button", { name: /New list/ }));
    const metadata = screen.getByRole("dialog", { name: "Create group list" });
    await user.type(within(metadata).getByRole("textbox", { name: "Name" }), savedList.name);
    await user.click(within(metadata).getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("network down")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createGroupList).toHaveBeenCalledTimes(2));
    expect(createGroupList.mock.calls[0]?.[1]).toBe(createGroupList.mock.calls[1]?.[1]);
  });
});
