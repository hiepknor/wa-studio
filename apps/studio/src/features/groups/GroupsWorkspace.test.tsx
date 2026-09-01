import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { RuntimeTransportError } from "@/shared/api/runtime-http";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function Harness() {
  const { connect, connected, selectSession } = useRuntimeConnection();
  if (!connected) {
    return (
      <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "0123456789abcdef0123456789abcdef" })}>
        Connect
      </button>
    );
  }
  return (
    <DrawerProvider>
      <button onClick={() => selectSession("other-session")} type="button">
        Switch session
      </button>
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
    expect(api.listGroups).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.id }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(api.listGroupLists).toHaveBeenCalledWith(
      { sessionId: session.id, limit: 50, offset: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("renders a saved list in the same selectable table", async () => {
    const user = userEvent.setup();
    const api = renderWorkspace();
    await connect(user);
    await chooseScope(user, /Launch groups/);

    expect(await screen.findByText("Saved static list")).toBeInTheDocument();
    expect(api.getGroupListMembership).toHaveBeenCalledWith(
      savedList.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const table = screen.getByRole("table", { name: `Groups saved in ${savedList.name}` });
    expect(within(table).getByRole("checkbox", { name: `Select ${group.name}` })).toBeEnabled();
    expect(within(table).getByText(group.name)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit list" })).toBeEnabled();
    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    expect(screen.getByRole("option", { name: /All groups/ })).toHaveTextContent("All groups1 group");
  });

  it("creates an empty list from the scope panel metadata dialog", async () => {
    const user = userEvent.setup();
    const created = { ...savedList, groupCount: 0, name: "Empty cohort" };
    const createGroupList = vi.fn().mockResolvedValue(created);
    const getGroupListMembership = vi.fn().mockResolvedValue({ data: [], list: created });
    renderWorkspace({ createGroupList, getGroupListMembership });
    await connect(user);

    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    await user.click(screen.getByRole("button", { name: "New list" }));
    const dialog = screen.getByRole("dialog", { name: "New list" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Empty cohort");
    expect(createGroupList).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("table")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create list" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "Create list" }));
    await waitFor(() => expect(createGroupList).toHaveBeenCalledWith({
      description: null,
      groupIds: [],
      name: "Empty cohort",
      sessionId: session.id,
    }, expect.any(String)));
    expect(await screen.findByText("Group list created")).toBeInTheDocument();
  });

  it("creates a list from selection made directly in the directory table", async () => {
    const user = userEvent.setup();
    const createGroupList = vi.fn().mockResolvedValue(savedList);
    renderWorkspace({ createGroupList });
    await connect(user);
    const directory = screen.getByRole("table", { name: "Groups in the active Gateway session" });
    await user.click(within(directory).getByRole("checkbox", { name: `Select ${group.name}` }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Group scope" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    await user.click(screen.getByRole("menuitem", { name: /Create new list/ }));

    const dialog = screen.getByRole("dialog", { name: "New list" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), savedList.name);
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Create and add" }));

    await waitFor(() => expect(createGroupList).toHaveBeenCalledWith(
      expect.objectContaining({ groupIds: [group.id] }),
      expect.any(String),
    ));
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });

  it("routes an Add action directly to first-list creation when the catalog is empty", async () => {
    const user = userEvent.setup();
    const created = { ...savedList, name: "First list" };
    const createGroupList = vi.fn().mockResolvedValue(created);
    const listGroupLists = vi.fn().mockResolvedValue({
      data: [],
      meta: { limit: 50, offset: 0, total: 0 },
    });
    renderWorkspace({ createGroupList, listGroupLists });
    await connect(user);
    await waitFor(() => expect(listGroupLists).toHaveBeenCalled());

    await user.click(screen.getByRole("checkbox", { name: `Select ${group.name}` }));
    const create = await screen.findByRole("button", { name: "New list" });
    expect(screen.queryByRole("button", { name: "Add to list" })).not.toBeInTheDocument();
    await user.click(create);
    const dialog = screen.getByRole("dialog", { name: "New list" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), created.name);
    await user.click(within(dialog).getByRole("button", { name: "Create and add" }));

    await waitFor(() => expect(createGroupList).toHaveBeenCalledWith(
      expect.objectContaining({ groupIds: [group.id], name: created.name }),
      expect.any(String),
    ));
  });

  it("adds the directory selection to an existing list with canonical membership", async () => {
    const user = userEvent.setup();
    const updatedList = {
      ...savedList,
      groupCount: 1,
      membershipRevision: savedList.membershipRevision + 1,
    };
    const getGroupListMembership = vi.fn().mockResolvedValue({ data: [], list: savedList });
    const replaceGroupListGroups = vi.fn().mockResolvedValue({ data: [member], list: updatedList });
    renderWorkspace({ getGroupListMembership, replaceGroupListGroups });
    await connect(user);

    await user.click(screen.getByRole("checkbox", { name: `Select ${group.name}` }));
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    await user.click(screen.getByRole("menuitem", { name: /Add to existing list/ }));
    const dialog = screen.getByRole("dialog", { name: "Add to existing list" });
    await user.click(within(dialog).getByRole("radio", { name: /Launch groups/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add to list" }));

    await waitFor(() => expect(replaceGroupListGroups).toHaveBeenCalledWith(
      savedList.id,
      [group.id],
      savedList.membershipRevision,
    ));
    expect(await screen.findByText("1 group added")).toBeInTheDocument();
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });

  it("guards dirty scope changes and retains the draft when cancelled", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await connect(user);
    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    await user.click(screen.getByRole("button", { name: "New list" }));
    const dialog = screen.getByRole("dialog", { name: "New list" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Draft cohort");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const confirm = screen.getByRole("dialog", { name: "Discard list details?" });
    await user.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "New list" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("dialog", { name: "New list" })).not.toBeInTheDocument();
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

  it("reports a saved-list delete failure inside the active confirmation", async () => {
    const user = userEvent.setup();
    renderWorkspace({ archiveGroupList: vi.fn().mockRejectedValue(new Error("Runtime unavailable.")) });
    await connect(user);
    await chooseScope(user, /Launch groups/);
    await screen.findByText("Saved static list");

    await user.click(screen.getByRole("button", { name: `More actions for ${savedList.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete list/ }));
    const confirmation = screen.getByRole("dialog", { name: "Delete group list?" });
    await user.click(within(confirmation).getByRole("button", { name: "Delete list" }));

    const alert = await within(confirmation).findByRole("alert");
    expect(alert).toHaveTextContent("Could not delete group list");
    expect(alert).toHaveTextContent("The group list could not be deleted.");
  });

  it("reconciles an unconfirmed delete as successful when the list is missing", async () => {
    const user = userEvent.setup();
    renderWorkspace({
      archiveGroupList: vi.fn().mockRejectedValue(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      )),
      getGroupList: vi.fn().mockRejectedValue(new RuntimeRequestError("missing", {
        code: "GROUP_LIST_NOT_FOUND",
        status: 404,
      })),
    });
    await connect(user);
    await chooseScope(user, /Launch groups/);
    await screen.findByText("Saved static list");

    await user.click(screen.getByRole("button", { name: `More actions for ${savedList.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete list/ }));
    await user.click(within(screen.getByRole("dialog", { name: "Delete group list?" }))
      .getByRole("button", { name: "Delete list" }));

    expect(await screen.findByText("Group list deleted")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Group scope" })).toHaveTextContent("All groups");
  });

  it("edits metadata without touching membership", async () => {
    const user = userEvent.setup();
    const metadataList = { ...savedList, name: "Launch groups v2", revision: 5 };
    const updateGroupList = vi.fn().mockResolvedValue(metadataList);
    const replaceGroupListGroups = vi.fn();
    renderWorkspace({ replaceGroupListGroups, updateGroupList });
    await connect(user);
    await chooseScope(user, /Launch groups/);
    await screen.findByText("Saved static list");
    await user.click(screen.getByRole("button", { name: "Edit list" }));
    const editor = screen.getByRole("dialog", { name: "Edit list" });
    expect(within(editor).queryByRole("checkbox")).not.toBeInTheDocument();
    const name = within(editor).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, metadataList.name);
    await user.click(within(editor).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateGroupList).toHaveBeenCalledWith(savedList.id, {
      description: savedList.description,
      expectedRevision: savedList.revision,
      name: metadataList.name,
    }));
    expect(replaceGroupListGroups).not.toHaveBeenCalled();
    expect(await screen.findByText("Saved static list")).toBeInTheDocument();
  });

  it("ignores an in-flight metadata save after the active session changes", async () => {
    const user = userEvent.setup();
    const metadata = deferred<RuntimeGroupList>();
    const updateGroupList = vi.fn().mockReturnValue(metadata.promise);
    const replaceGroupListGroups = vi.fn();
    renderWorkspace({ replaceGroupListGroups, updateGroupList });
    await connect(user);
    await chooseScope(user, /Launch groups/);
    await screen.findByText("Saved static list");
    await user.click(screen.getByRole("button", { name: "Edit list" }));
    const editor = screen.getByRole("dialog", { name: "Edit list" });
    const name = within(editor).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Launch groups v2");
    await user.click(within(editor).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateGroupList).toHaveBeenCalledTimes(1));

    act(() => screen.getByRole("button", { name: "Switch session", hidden: true }).click());
    await act(async () => {
      metadata.resolve({ ...savedList, name: "Launch groups v2", revision: 5 });
      await metadata.promise;
    });

    expect(replaceGroupListGroups).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved static list")).not.toBeInTheDocument();
  });

  it("retries a membership removal once with the latest canonical revision", async () => {
    const user = userEvent.setup();
    const latest = { ...savedList, membershipRevision: 3, revision: 5 };
    const getGroupListMembership = vi.fn()
      .mockResolvedValueOnce({ data: [member], list: savedList })
      .mockResolvedValueOnce({ data: [member], list: savedList })
      .mockResolvedValueOnce({ data: [member], list: latest });
    const finalList = { ...latest, groupCount: 0, membershipRevision: 4, revision: 6 };
    const replaceGroupListGroups = vi.fn()
      .mockRejectedValueOnce(new RuntimeRequestError("opaque", {
        code: "GROUP_LIST_REVISION_CONFLICT",
        status: 409,
      }))
      .mockResolvedValueOnce({ data: [], list: finalList });
    renderWorkspace({ getGroupListMembership, replaceGroupListGroups });
    await connect(user);
    await chooseScope(user, /Launch groups/);
    await screen.findByText("Saved static list");
    await user.click(screen.getByRole("checkbox", { name: `Select ${group.name}` }));
    await user.click(screen.getByRole("button", { name: `Remove from ${savedList.name}` }));
    const confirmation = screen.getByRole("dialog", { name: `Remove from ${savedList.name}?` });
    await user.click(within(confirmation).getByRole("button", { name: "Remove groups" }));

    await waitFor(() => expect(replaceGroupListGroups).toHaveBeenCalledTimes(2));
    expect(replaceGroupListGroups).toHaveBeenNthCalledWith(1, savedList.id, [], savedList.membershipRevision);
    expect(replaceGroupListGroups).toHaveBeenNthCalledWith(2, savedList.id, [], latest.membershipRevision);
    expect(await screen.findByText("1 group removed")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: `Remove from ${savedList.name}?` })).not.toBeInTheDocument();
  });

  it("reuses the create idempotency key across a retry", async () => {
    const user = userEvent.setup();
    const createGroupList = vi.fn()
      .mockRejectedValueOnce(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      ))
      .mockResolvedValue(savedList);
    renderWorkspace({ createGroupList });
    await connect(user);
    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    await user.click(screen.getByRole("button", { name: "New list" }));
    const editor = screen.getByRole("dialog", { name: "New list" });
    await user.type(within(editor).getByRole("textbox", { name: "Name" }), savedList.name);
    await user.click(within(editor).getByRole("button", { name: "Create list" }));
    expect(await screen.findByText(/same request key/)).toBeInTheDocument();
    await user.type(within(editor).getByRole("textbox", { name: "Description · Optional" }), "Changed");
    await user.click(within(editor).getByRole("button", { name: "Create list" }));
    expect(await screen.findByText(/could create a duplicate group list/)).toBeInTheDocument();
    expect(createGroupList).toHaveBeenCalledTimes(1);
    await user.click(within(editor).getByRole("button", { name: "Restore request" }));
    expect(within(editor).getByRole("textbox", { name: "Description · Optional" })).toHaveValue("");
    await user.click(within(editor).getByRole("button", { name: "Create list" }));
    await waitFor(() => expect(createGroupList).toHaveBeenCalledTimes(2));
    expect(createGroupList.mock.calls[0]?.[1]).toBe(createGroupList.mock.calls[1]?.[1]);
  });
});
