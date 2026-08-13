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
  RuntimeGroupListInput,
  RuntimeGroupPage,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
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
      <GroupsHarness />
    </RuntimeConnectionProvider>,
  );
  return api;
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("searchbox", { name: "Search all synchronized groups" });
}

describe("GroupsScreen global search and filters", () => {
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
    expect(screen.getByText("Search: Release room")).toBeInTheDocument();
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
    await user.click(screen.getByRole("checkbox", { name: "Denied" }));
    await user.click(screen.getByRole("checkbox", { name: "Unknown" }));
    await user.click(screen.getByRole("checkbox", { name: "Current" }));
    await user.click(screen.getByRole("checkbox", { name: "Stale" }));
    await user.click(screen.getByRole("radio", { name: "Inactive" }));

    await waitFor(() => expect(listGroups).toHaveBeenLastCalledWith({
      sessionId: session.id,
      limit: 20,
      offset: 0,
      capabilityStatus: ["DENIED", "UNKNOWN"],
      capabilityFreshness: ["CURRENT", "STALE"],
      isActive: false,
    }));
    expect(screen.getByRole("button", { name: "Filters · 5" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
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
    const listGroups = vi.fn((input: RuntimeGroupListInput) => {
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
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("shows filtered empty results and clamps an out-of-range page", async () => {
    const user = userEvent.setup();
    let pageMoved = false;
    const listGroups = vi.fn((input: RuntimeGroupListInput) => {
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
    const listGroups = vi.fn((input: RuntimeGroupListInput) => {
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
