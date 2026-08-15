import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import type {
  RuntimeApi,
  RuntimeGroup,
  RuntimeGroupDirectoryInput,
  RuntimeGroupPage,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { ToastProvider } from "@/shared/ui/Toast";
import { GroupsScreen } from "./GroupsScreen";

const session: RuntimeSession = {
  id: "session-id",
  name: "staging-session-2",
  status: "ready",
  phone: null,
  pushName: null,
  connectedAt: null,
  lastActiveAt: null,
  engineLoaded: true,
  lastError: null,
  restriction: null,
  gatewayCreatedAt: "2026-08-13T01:00:00.000Z",
  gatewayUpdatedAt: "2026-08-13T01:00:00.000Z",
  syncedAt: "2026-08-13T01:00:00.000Z",
};

const secondSession: RuntimeSession = {
  ...session,
  id: "second-session-id",
  name: "second-session",
};

function group(id: string, name: string, sessionId = session.id): RuntimeGroup {
  return {
    sessionId,
    id,
    name,
    description: `${name} description`,
    ownerId: null,
    linkedParentId: null,
    participantsCount: 2,
    isAdmin: true,
    isReadOnly: false,
    isAnnounce: false,
    settingsLocked: false,
    isActive: true,
    detailsSyncedAt: "2026-08-13T01:00:00.000Z",
    syncedAt: "2026-08-13T01:00:00.000Z",
    sendCapability: {
      status: "ALLOWED",
      reason: "session_is_admin",
      checkedAt: "2026-08-13T01:00:00.000Z",
      invalidatedAt: null,
      revision: 1,
    },
  };
}

const defaultPage: RuntimeGroupPage = {
  data: [group("release@g.us", "Release room")],
  meta: { total: 1, limit: 20, offset: 0 },
};

function GroupsHarness() {
  const { connect, connected, selectSession } = useRuntimeConnection();
  if (!connected) {
    return (
      <button
        onClick={() => void connect({ baseUrl: "http://127.0.0.1:3100", apiKey: "key" })}
        type="button"
      >
        Connect
      </button>
    );
  }
  return (
    <DrawerProvider>
      <button onClick={() => selectSession(secondSession.id)} type="button">
        Switch session
      </button>
      <GroupsScreen />
      <DrawerHost />
    </DrawerProvider>
  );
}

function renderGroups(listGroups: RuntimeApi["listGroups"]) {
  const api = {
    getGroup: vi.fn(),
    listGroupMembers: vi.fn(),
    listGroups,
    requestGroupCapabilityRefresh: vi.fn(),
  } as unknown as RuntimeApi;
  render(
    <RuntimeConnectionProvider
      createApi={() => api}
      probeConnection={vi.fn().mockResolvedValue({
        sessionCount: 2,
        readySessions: 2,
        sessions: [session, secondSession],
      })}
    >
      <ToastProvider><GroupsHarness /></ToastProvider>
    </RuntimeConnectionProvider>,
  );
  return api;
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("searchbox", { name: "Search all synchronized groups" });
}

describe("GroupsScreen global search and filters", () => {
  it("shows the initial empty state returned by Runtime", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue({
      data: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });
    renderGroups(listGroups);
    await connect(user);

    expect(await screen.findByText("No groups were returned for this session."))
      .toBeInTheDocument();
    expect(screen.getByText("0–0 of 0")).toBeInTheDocument();
    expect(screen.getByText("Page 0 of 0")).toBeInTheDocument();
  });

  it("shows a scoped list error and retries the same Runtime query", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn()
      .mockRejectedValueOnce(new Error("Runtime is temporarily unavailable."))
      .mockResolvedValueOnce(defaultPage);
    renderGroups(listGroups);
    await connect(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load groups");
    expect(alert).toHaveTextContent("Runtime is temporarily unavailable.");
    expect(screen.getByText("Groups are unavailable.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Release room")).toBeInTheDocument();
    expect(listGroups).toHaveBeenNthCalledWith(2, {
      sessionId: session.id,
      limit: 20,
      offset: 0,
    });
    expect(screen.queryByText("Could not load groups")).not.toBeInTheDocument();
  });

  it("debounces trimmed global search across the Runtime-supported fields", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue(defaultPage);
    renderGroups(listGroups);
    await connect(user);

    const search = screen.getByRole("searchbox", {
      name: "Search all synchronized groups",
    });
    expect(search).toHaveAttribute("placeholder", "Search name, ID, or description");
    await user.type(search, "  Release room  ");

    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      query: "Release room",
    }));
    expect(search).toHaveAttribute("type", "search");
    expect(screen.queryByText("Search: Release room")).not.toBeInTheDocument();
  });

  it.each([
    ["group ID", "120363000000000000@g.us"],
    ["description", "weekly release coordination"],
  ])("sends a %s search to Runtime without page-local filtering", async (_, query) => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue({
      data: [group("server-selected@g.us", "Server-selected result")],
      meta: { total: 1, limit: 20, offset: 0 },
    });
    renderGroups(listGroups);
    await connect(user);

    await user.type(
      screen.getByRole("searchbox", { name: "Search all synchronized groups" }),
      query,
    );

    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      query,
    }));
    expect(screen.getByText("Server-selected result")).toBeInTheDocument();
  });

  it("sends combined multi-status, freshness, and inactive filters", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue(defaultPage);
    renderGroups(listGroups);
    await connect(user);

    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("radio", { name: "Active" })).toBeChecked();
    expect(screen.getByText("No filters applied")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Denied" }));
    await user.click(screen.getByRole("checkbox", { name: "Unknown" }));
    await user.click(screen.getByRole("checkbox", { name: "Stale" }));
    await user.click(screen.getByRole("radio", { name: "Inactive" }));

    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      capabilityStatus: ["DENIED", "UNKNOWN"],
      capabilityFreshness: ["STALE"],
      isActive: false,
    }));
    expect(screen.getByRole("button", { name: "Filters · 3" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
    const deniedChip = screen.getByRole("button", {
      name: "Remove Capability: Denied filter",
    });
    expect(deniedChip.closest(".data-filter-summary")).not.toBeNull();
    expect(screen.getByRole("button", {
      name: "Remove Capability: Unknown filter",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Remove Freshness: Stale filter",
    })).toBeInTheDocument();

    await user.click(deniedChip);
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      capabilityStatus: ["UNKNOWN"],
      capabilityFreshness: ["STALE"],
      isActive: false,
    }));
    expect(screen.getByRole("button", { name: "Filters · 3" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close group filters" }));
    expect(screen.getByRole("button", { name: "Filters · 3" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("region", { name: "Group filters" })).not.toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Filters · 3" }),
    ).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Filters · 3" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Group filters" })).not.toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Filters · 3" }),
    ).toHaveFocus());
  });

  it("preserves a complete filter domain and sends every selected value", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue(defaultPage);
    renderGroups(listGroups);
    await connect(user);

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("checkbox", { name: "Allowed" }));
    await user.click(screen.getByRole("checkbox", { name: "Denied" }));
    await user.click(screen.getByRole("checkbox", { name: "Unknown" }));

    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      capabilityStatus: ["ALLOWED", "DENIED", "UNKNOWN"],
    }));
    expect(screen.getByRole("button", { name: "Filters · 1" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText("No filters applied")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Allowed" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Denied" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Unknown" })).toBeChecked();
    expect(screen.getByRole("button", {
      name: "Remove Capability: Allowed filter",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Remove Capability: Denied filter",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Remove Capability: Unknown filter",
    })).toBeInTheDocument();
  });

  it("clears search independently from filters and clears filters independently from search", async () => {
    const user = userEvent.setup();
    const listGroups = vi.fn().mockResolvedValue(defaultPage);
    renderGroups(listGroups);
    await connect(user);

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("checkbox", { name: "Denied" }));
    const search = screen.getByRole("searchbox", { name: "Search all synchronized groups" });
    await user.type(search, "needle");
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      query: "needle",
      capabilityStatus: ["DENIED"],
    }));

    await user.clear(search);
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", {
      name: "Remove Capability: Denied filter",
    })).toBeInTheDocument();
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      capabilityStatus: ["DENIED"],
    }));

    await user.type(search, "keep me");
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith(expect.objectContaining({
      query: "keep me",
      capabilityStatus: ["DENIED"],
    })));
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(search).toHaveValue("keep me");
    expect(screen.queryByRole("button", {
      name: "Remove Capability: Denied filter",
    })).not.toBeInTheDocument();
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      query: "keep me",
    }));
  });

  it("marks retained rows as updating while new criteria are loading", async () => {
    const user = userEvent.setup();
    let resolveFiltered: ((page: RuntimeGroupPage) => void) | undefined;
    const filtered = new Promise<RuntimeGroupPage>((resolve) => {
      resolveFiltered = resolve;
    });
    const listGroups = vi.fn((input: RuntimeGroupDirectoryInput) => (
      input.query ? filtered : Promise.resolve(defaultPage)
    ));
    renderGroups(listGroups);
    await connect(user);
    expect(await screen.findByText("Release room")).toBeInTheDocument();

    await user.type(
      screen.getByRole("searchbox", { name: "Search all synchronized groups" }),
      "new result",
    );
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith(expect.objectContaining({
      query: "new result",
    })));

    expect(screen.getByText("Updating results…")).toBeInTheDocument();
    const results = screen.getByRole("table").parentElement;
    expect(results).toHaveAttribute("aria-busy", "true");
    expect(results).toHaveAttribute("data-updating", "true");

    resolveFiltered?.({
      data: [group("updated@g.us", "Updated result")],
      meta: { total: 1, limit: 20, offset: 0 },
    });
    expect(await screen.findByText("Updated result")).toBeInTheDocument();
    expect(results).toHaveAttribute("aria-busy", "false");
    expect(results).not.toHaveAttribute("data-updating");
  });

  it("resets pagination for search and uses filtered meta.total", async () => {
    const user = userEvent.setup();
    const secondPage = {
      data: [group("second@g.us", "Second page")],
      meta: { total: 41, limit: 20, offset: 20 },
    };
    const filteredPage = {
      data: [group("match@g.us", "Backend match")],
      meta: { total: 3, limit: 20, offset: 0 },
    };
    const listGroups = vi.fn((input: RuntimeGroupDirectoryInput) => {
      if (input.query === "needle") return Promise.resolve(filteredPage);
      if (input.offset === 20) return Promise.resolve(secondPage);
      return Promise.resolve({
        ...defaultPage,
        meta: { total: 41, limit: 20, offset: 0 },
      });
    });
    renderGroups(listGroups);
    await connect(user);

    await user.click(await screen.findByRole("button", { name: "Next" }));
    await screen.findByText("Second page");
    await user.type(
      screen.getByRole("searchbox", { name: "Search all synchronized groups" }),
      "needle",
    );

    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      query: "needle",
    }));
    expect(await screen.findByText("Backend match")).toBeInTheDocument();
    expect(screen.getByText("1–1 of 3 matches")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });

  it("shows filtered empty results and clamps an out-of-range page", async () => {
    const user = userEvent.setup();
    let pageMoved = false;
    const listGroups = vi.fn((input: RuntimeGroupDirectoryInput) => {
      if (input.query === "no result") {
        return Promise.resolve({ data: [], meta: { total: 0, limit: 20, offset: 0 } });
      }
      if (input.offset === 20) {
        pageMoved = true;
        return Promise.resolve({ data: [], meta: { total: 1, limit: 20, offset: 20 } });
      }
      return Promise.resolve({
        ...defaultPage,
        meta: { total: pageMoved ? 1 : 21, limit: 20, offset: 0 },
      });
    });
    renderGroups(listGroups);
    await connect(user);

    await user.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
    }));
    expect(await screen.findByText("Release room")).toBeInTheDocument();

    await user.type(
      screen.getByRole("searchbox", { name: "Search all synchronized groups" }),
      "no result",
    );
    expect(await screen.findByText("No groups match this search or filters."))
      .toBeInTheDocument();
    expect(screen.getByText("0–0 of 0 matches")).toBeInTheDocument();
    expect(screen.getByText("Page 0 of 0")).toBeInTheDocument();
  });

  it("ignores stale search and previous-session responses", async () => {
    const user = userEvent.setup();
    let resolveStaleSearch: ((page: RuntimeGroupPage) => void) | undefined;
    let resolveFirstSession: ((page: RuntimeGroupPage) => void) | undefined;
    const staleSearch = new Promise<RuntimeGroupPage>((resolve) => {
      resolveStaleSearch = resolve;
    });
    const firstSession = new Promise<RuntimeGroupPage>((resolve) => {
      resolveFirstSession = resolve;
    });
    const listGroups = vi.fn((input: RuntimeGroupDirectoryInput) => {
      if (input.sessionId === secondSession.id) {
        return Promise.resolve({
          data: [group("second-session@g.us", "Second session result", secondSession.id)],
          meta: { total: 1, limit: 20, offset: 0 },
        });
      }
      if (input.query === "old") return staleSearch;
      if (input.query === "new") {
        return Promise.resolve({
          data: [group("new@g.us", "Newest search")],
          meta: { total: 1, limit: 20, offset: 0 },
        });
      }
      return firstSession;
    });
    renderGroups(listGroups);
    await connect(user);

    const search = screen.getByRole("searchbox", { name: "Search all synchronized groups" });
    await user.type(search, "old");
    await waitFor(() => expect(listGroups).toHaveBeenCalledWith(expect.objectContaining({
      query: "old",
    })));
    await user.clear(search);
    await user.type(search, "new");
    expect(await screen.findByText("Newest search")).toBeInTheDocument();
    resolveStaleSearch?.({
      data: [group("stale@g.us", "Stale search")],
      meta: { total: 1, limit: 20, offset: 0 },
    });
    expect(screen.queryByText("Stale search")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Switch session" }));
    expect(await screen.findByText("Second session result")).toBeInTheDocument();
    resolveFirstSession?.(defaultPage);
    expect(screen.queryByText("Release room")).not.toBeInTheDocument();
  });
});
