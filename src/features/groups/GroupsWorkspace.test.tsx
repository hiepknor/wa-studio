import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import { RuntimeRequestError, type RuntimeApi, type RuntimeGroupList, type RuntimeSession } from "@/shared/api/runtime-client";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { ToastProvider } from "@/shared/ui/Toast";
import { GroupsWorkspace } from "./GroupsWorkspace";

const primary: RuntimeSession = {
  id: "primary-session", name: "Primary", status: "ready", phone: null, pushName: null,
  connectedAt: null, lastActiveAt: null, engineLoaded: true, lastError: null,
  restriction: null, gatewayCreatedAt: "2026-08-15T00:00:00.000Z",
  gatewayUpdatedAt: "2026-08-15T00:00:00.000Z", syncedAt: "2026-08-15T00:00:00.000Z",
};
const secondary = { ...primary, id: "secondary-session", name: "Secondary" };
const savedList: RuntimeGroupList = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: primary.id,
  name: "Launch groups",
  description: "Static launch selection",
  groupCount: 2,
  revision: 4,
  membershipRevision: 2,
  archivedAt: null,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function Harness() {
  const { connect, connected, selectSession } = useRuntimeConnection();
  if (!connected) return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "key" })}>Connect</button>;
  return <DrawerProvider><button onClick={() => selectSession(secondary.id)}>Switch session</button><GroupsWorkspace /><DrawerHost /></DrawerProvider>;
}

function renderWorkspace(overrides: Partial<RuntimeApi> = {}, strict = false) {
  const api = {
    listGroups: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } }),
    listGroupLists: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } }),
    archiveGroupList: vi.fn(),
    ...overrides,
  } as unknown as RuntimeApi;
  const workspace = <ToastProvider><RuntimeConnectionProvider createApi={() => api} probeConnection={vi.fn().mockResolvedValue({ sessionCount: 2, readySessions: 2, sessions: [primary, secondary] })}><Harness /></RuntimeConnectionProvider></ToastProvider>;
  render(strict ? <StrictMode>{workspace}</StrictMode> : workspace);
  return api;
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("tab", { name: "All groups" });
}

describe("GroupsWorkspace", () => {
  it("defaults to All groups, keeps one Groups workspace, and lazy-loads Group lists", async () => {
    const user = userEvent.setup();
    const api = renderWorkspace();
    await connect(user);
    expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All groups" })).toHaveAttribute("aria-selected", "true");
    expect(api.listGroups).toHaveBeenCalledTimes(1);
    expect(api.listGroupLists).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Update groups" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Group lists" }));
    await waitFor(() => expect(api.listGroupLists).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "New list" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update groups" })).not.toBeInTheDocument();
  });

  it("loads the initial Group lists page under StrictMode", async () => {
    const user = userEvent.setup();
    const listGroupLists = vi.fn().mockResolvedValue({
      data: [{
        id: "strict-list",
        sessionId: primary.id,
        name: "Strict list",
        description: null,
        groupCount: 2,
        revision: 1,
        membershipRevision: 1,
        archivedAt: null,
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
      }],
      meta: { total: 1, limit: 20, offset: 0 },
    });
    renderWorkspace({ listGroupLists }, true);
    await connect(user);

    await user.click(screen.getByRole("tab", { name: "Group lists" }));

    expect(await screen.findByRole("button", { name: "Strict list" })).toBeInTheDocument();
    expect(screen.queryByText("Loading group lists…")).not.toBeInTheDocument();
  });

  it("debounces and trims Runtime-backed Group lists search and omits whitespace", async () => {
    const user = userEvent.setup();
    const listGroupLists = vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } });
    renderWorkspace({ listGroupLists });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Group lists" }));
    await waitFor(() => expect(listGroupLists).toHaveBeenCalledTimes(1));
    const search = screen.getByRole("searchbox", { name: "Search group lists" });
    await user.type(search, "  launch  ");
    await waitFor(() => expect(listGroupLists).toHaveBeenLastCalledWith({ sessionId: primary.id, limit: 20, offset: 0, query: "launch" }));
    await user.clear(search);
    await user.type(search, "   ");
    await waitFor(() => expect(listGroupLists).toHaveBeenLastCalledWith({ sessionId: primary.id, limit: 20, offset: 0 }));
  });

  it("uses meta.total for pagination", async () => {
    const user = userEvent.setup();
    const listGroupLists = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: "list-1", sessionId: primary.id, name: "One", description: null, groupCount: 2, revision: 1, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }], meta: { total: 21, limit: 20, offset: 0 } })
      .mockResolvedValueOnce({ data: [{ id: "list-2", sessionId: primary.id, name: "Twenty one", description: "Last page", groupCount: 1, revision: 1, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }], meta: { total: 21, limit: 20, offset: 20 } });
    renderWorkspace({ listGroupLists });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Group lists" }));
    expect(await screen.findByText("One")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Twenty one")).toBeInTheDocument();
    expect(listGroupLists).toHaveBeenLastCalledWith({ sessionId: primary.id, limit: 20, offset: 20 });
  });

  it("invalidates the old Group lists request when the session changes", async () => {
    const user = userEvent.setup();
    const oldPage = deferred<Awaited<ReturnType<RuntimeApi["listGroupLists"]>>>();
    const listGroupLists = vi.fn()
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ data: [{ id: "new-list", sessionId: secondary.id, name: "Secondary list", description: null, groupCount: 0, revision: 1, membershipRevision: 0, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }], meta: { total: 1, limit: 20, offset: 0 } });
    renderWorkspace({ listGroupLists });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Group lists" }));
    await waitFor(() => expect(listGroupLists).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Switch session" }));
    expect(await screen.findByText("Secondary list")).toBeInTheDocument();
    oldPage.resolve({ data: [{ id: "old-list", sessionId: primary.id, name: "Late primary list", description: null, groupCount: 0, revision: 1, membershipRevision: 0, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }], meta: { total: 1, limit: 20, offset: 0 } });
    await Promise.resolve();
    expect(screen.queryByText("Late primary list")).not.toBeInTheDocument();
  });

  it("E2E happy path: deletes a Group List from the row only after Runtime returns 204", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const archiveGroupList = vi.fn().mockReturnValue(pending.promise);
    const listGroupLists = vi.fn()
      .mockResolvedValueOnce({ data: [savedList], meta: { total: 1, limit: 20, offset: 0 } })
      .mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } });
    renderWorkspace({ archiveGroupList, listGroupLists });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Group lists" }));
    await screen.findByRole("button", { name: savedList.name });

    await user.click(screen.getByRole("button", { name: `More actions for ${savedList.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete list/ }));
    const dialog = screen.getByRole("dialog", { name: "Delete group list?" });
    expect(dialog).toHaveTextContent("Campaigns that already applied this list and their current targets will not be changed.");
    await user.click(screen.getByRole("button", { name: "Delete list" }));

    expect(archiveGroupList).toHaveBeenCalledWith(savedList.id, savedList.revision);
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: savedList.name })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Delete group list?" })).toBeInTheDocument();

    pending.resolve(undefined);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete group list?" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: savedList.name })).not.toBeInTheDocument();
    expect(await screen.findByText("Group list deleted")).toBeInTheDocument();
    expect(screen.getByText("Existing campaigns were not changed.")).toBeInTheDocument();
  });

  it("refreshes a Group List revision conflict without retrying deletion", async () => {
    const user = userEvent.setup();
    const refreshed = { ...savedList, name: "Launch groups updated", revision: 5 };
    const archiveGroupList = vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
      code: "GROUP_LIST_REVISION_CONFLICT",
      status: 409,
    }));
    const listGroupLists = vi.fn()
      .mockResolvedValueOnce({ data: [savedList], meta: { total: 1, limit: 20, offset: 0 } })
      .mockResolvedValue({ data: [refreshed], meta: { total: 1, limit: 20, offset: 0 } });
    renderWorkspace({ archiveGroupList, listGroupLists });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Group lists" }));
    await screen.findByRole("button", { name: savedList.name });

    await user.click(screen.getByRole("button", { name: `More actions for ${savedList.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete list/ }));
    await user.click(screen.getByRole("button", { name: "Delete list" }));

    expect(await screen.findByText("The group list changed. Review it before deleting.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: refreshed.name })).toBeInTheDocument();
    expect(archiveGroupList).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Delete group list?" })).not.toBeInTheDocument();
  });

  it("keeps the Group List and dialog available after a network failure", async () => {
    const user = userEvent.setup();
    const archiveGroupList = vi.fn().mockRejectedValue(new TypeError("network down"));
    renderWorkspace({
      archiveGroupList,
      listGroupLists: vi.fn().mockResolvedValue({ data: [savedList], meta: { total: 1, limit: 20, offset: 0 } }),
    });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Group lists" }));
    await screen.findByRole("button", { name: savedList.name });

    await user.click(screen.getByRole("button", { name: `More actions for ${savedList.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete list/ }));
    await user.click(screen.getByRole("button", { name: "Delete list" }));

    expect(await screen.findByText("The group list could not be deleted. Check the Runtime connection and try again.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Delete group list?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: savedList.name })).toBeInTheDocument();
    expect(archiveGroupList).toHaveBeenCalledTimes(1);
  });

  it("removes a stale Group List when Runtime reports it missing", async () => {
    const user = userEvent.setup();
    const archiveGroupList = vi.fn().mockRejectedValue(new RuntimeRequestError("opaque", {
      code: "GROUP_LIST_NOT_FOUND",
      status: 404,
    }));
    const listGroupLists = vi.fn()
      .mockResolvedValueOnce({ data: [savedList], meta: { total: 1, limit: 20, offset: 0 } })
      .mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } });
    renderWorkspace({ archiveGroupList, listGroupLists });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Group lists" }));
    await screen.findByRole("button", { name: savedList.name });

    await user.click(screen.getByRole("button", { name: `More actions for ${savedList.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete list/ }));
    await user.click(screen.getByRole("button", { name: "Delete list" }));

    expect(await screen.findByText("This item no longer exists or is no longer available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: savedList.name })).not.toBeInTheDocument();
  });

  it("closes the Group List detail drawer after successful deletion", async () => {
    const user = userEvent.setup();
    const archiveGroupList = vi.fn().mockResolvedValue(undefined);
    const listGroupLists = vi.fn()
      .mockResolvedValueOnce({ data: [savedList], meta: { total: 1, limit: 20, offset: 0 } })
      .mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } });
    renderWorkspace({
      archiveGroupList,
      getGroupListMembership: vi.fn().mockResolvedValue({ list: savedList, data: [] }),
      listGroupLists,
    });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Group lists" }));
    await user.click(await screen.findByRole("button", { name: savedList.name }));
    const drawer = screen.getByRole("dialog", { name: savedList.name });

    await user.click(within(drawer).getByRole("button", { name: `More actions for ${savedList.name}` }));
    await user.click(screen.getByRole("menuitem", { name: /Delete list/ }));
    await user.click(screen.getByRole("button", { name: "Delete list" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: savedList.name })).not.toBeInTheDocument());
    expect(archiveGroupList).toHaveBeenCalledWith(savedList.id, savedList.revision);
  });
});
