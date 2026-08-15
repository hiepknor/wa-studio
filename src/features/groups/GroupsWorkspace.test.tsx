import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import type { RuntimeApi, RuntimeSession } from "@/shared/api/runtime-client";
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

function renderWorkspace(overrides: Partial<RuntimeApi> = {}) {
  const api = {
    listGroups: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } }),
    listSavedGroupLists: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } }),
    ...overrides,
  } as unknown as RuntimeApi;
  render(<ToastProvider><RuntimeConnectionProvider createApi={() => api} probeConnection={vi.fn().mockResolvedValue({ sessionCount: 2, readySessions: 2, sessions: [primary, secondary] })}><Harness /></RuntimeConnectionProvider></ToastProvider>);
  return api;
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("tab", { name: "All groups" });
}

describe("GroupsWorkspace", () => {
  it("defaults to All groups, keeps one Groups workspace, and lazy-loads Saved lists", async () => {
    const user = userEvent.setup();
    const api = renderWorkspace();
    await connect(user);
    expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All groups" })).toHaveAttribute("aria-selected", "true");
    expect(api.listGroups).toHaveBeenCalledTimes(1);
    expect(api.listSavedGroupLists).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Update groups" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Saved lists" }));
    await waitFor(() => expect(api.listSavedGroupLists).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "New list" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update groups" })).not.toBeInTheDocument();
  });

  it("debounces and trims Runtime-backed Saved lists search and omits whitespace", async () => {
    const user = userEvent.setup();
    const listSavedGroupLists = vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 20, offset: 0 } });
    renderWorkspace({ listSavedGroupLists });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Saved lists" }));
    await waitFor(() => expect(listSavedGroupLists).toHaveBeenCalledTimes(1));
    const search = screen.getByRole("searchbox", { name: "Search saved lists" });
    await user.type(search, "  launch  ");
    await waitFor(() => expect(listSavedGroupLists).toHaveBeenLastCalledWith({ sessionId: primary.id, limit: 20, offset: 0, query: "launch" }));
    await user.clear(search);
    await user.type(search, "   ");
    await waitFor(() => expect(listSavedGroupLists).toHaveBeenLastCalledWith({ sessionId: primary.id, limit: 20, offset: 0 }));
  });

  it("uses meta.total for pagination", async () => {
    const user = userEvent.setup();
    const listSavedGroupLists = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: "list-1", sessionId: primary.id, name: "One", description: null, groupCount: 2, revision: 1, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }], meta: { total: 21, limit: 20, offset: 0 } })
      .mockResolvedValueOnce({ data: [{ id: "list-2", sessionId: primary.id, name: "Twenty one", description: "Last page", groupCount: 1, revision: 1, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }], meta: { total: 21, limit: 20, offset: 20 } });
    renderWorkspace({ listSavedGroupLists });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Saved lists" }));
    expect(await screen.findByText("One")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Twenty one")).toBeInTheDocument();
    expect(listSavedGroupLists).toHaveBeenLastCalledWith({ sessionId: primary.id, limit: 20, offset: 20 });
  });

  it("invalidates the old Saved lists request when the session changes", async () => {
    const user = userEvent.setup();
    const oldPage = deferred<Awaited<ReturnType<RuntimeApi["listSavedGroupLists"]>>>();
    const listSavedGroupLists = vi.fn()
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ data: [{ id: "new-list", sessionId: secondary.id, name: "Secondary list", description: null, groupCount: 0, revision: 1, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }], meta: { total: 1, limit: 20, offset: 0 } });
    renderWorkspace({ listSavedGroupLists });
    await connect(user);
    await user.click(screen.getByRole("tab", { name: "Saved lists" }));
    await waitFor(() => expect(listSavedGroupLists).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Switch session" }));
    expect(await screen.findByText("Secondary list")).toBeInTheDocument();
    oldPage.resolve({ data: [{ id: "old-list", sessionId: primary.id, name: "Late primary list", description: null, groupCount: 0, revision: 1, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }], meta: { total: 1, limit: 20, offset: 0 } });
    await Promise.resolve();
    expect(screen.queryByText("Late primary list")).not.toBeInTheDocument();
  });
});
