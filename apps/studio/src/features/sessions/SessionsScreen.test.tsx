import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import type { RuntimeApi, RuntimeSession } from "@/shared/api/runtime-client";
import { ToastProvider } from "@/shared/ui/Toast";
import { SessionsScreen } from "./SessionsScreen";

const readySession: RuntimeSession = {
  id: "ready-id",
  name: "Production gateway",
  status: "ready",
  phone: "8490111222",
  pushName: "Operations",
  connectedAt: null,
  lastActiveAt: null,
  engineLoaded: true,
  lastError: null,
  restriction: null,
  gatewayCreatedAt: "2026-08-13T09:00:00.000Z",
  gatewayUpdatedAt: "2026-08-13T09:00:00.000Z",
  syncedAt: "2026-08-13T09:00:00.000Z",
};

const failedSession: RuntimeSession = {
  ...readySession,
  id: "failed-id",
  name: "Recovery gateway",
  phone: null,
  pushName: null,
  status: "failed",
  engineLoaded: false,
  syncedAt: "2026-08-12T09:00:00.000Z",
};

function Harness({ onOpenGroups }: { onOpenGroups: () => void }) {
  const { connect, connected } = useRuntimeConnection();
  if (!connected) {
    return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "key" })}>Connect</button>;
  }
  return <SessionsScreen onOpenGroups={onOpenGroups} />;
}

function renderSessions(
  overrides: Partial<RuntimeApi> = {},
  sessions: RuntimeSession[] = [readySession, failedSession],
) {
  const onOpenGroups = vi.fn();
  const api = {
    listSessions: vi.fn().mockResolvedValue(sessions),
    ...overrides,
  } as unknown as RuntimeApi;
  render(
    <ToastProvider>
      <RuntimeConnectionProvider
        createApi={() => api}
        probeConnection={vi.fn().mockResolvedValue({
          readySessions: sessions.filter((session) => session.status === "ready").length,
          sessionCount: sessions.length,
          sessions,
        })}
      >
        <Harness onOpenGroups={onOpenGroups} />
      </RuntimeConnectionProvider>
    </ToastProvider>,
  );
  return { api, onOpenGroups };
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("searchbox", { name: "Session search" });
}

describe("SessionsScreen", () => {
  it("shows the Runtime session name with WhatsApp name and phone as its identity", async () => {
    const user = userEvent.setup();
    renderSessions();
    await connect(user);

    const sessionName = screen.getByText("Production gateway");
    const identity = screen.getByText("Operations · 8490111222");
    expect(sessionName).toHaveClass("data-primary-text");
    expect(identity).toHaveClass("data-secondary-text");
    expect(identity).toHaveAttribute("title", "Session ID: ready-id");
    expect(screen.getByText("failed-id")).toHaveClass("data-secondary-text");
    expect(screen.getByText("Ready")).toHaveClass("ui-badge-success");
    expect(screen.getByText("Failed")).toHaveClass("ui-badge-danger");
    expect(screen.getByText("2 sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("uses the shared table anatomy and paginates the local session directory", async () => {
    const user = userEvent.setup();
    const sessions = Array.from({ length: 21 }, (_, index) => ({
      ...readySession,
      id: `session-${index + 1}`,
      name: `Gateway ${index + 1}`,
      phone: `849000${String(index + 1).padStart(4, "0")}`,
    }));
    renderSessions({}, sessions);
    await connect(user);

    const table = screen.getByRole("table", { name: "WA Runtime sessions" });
    expect(table).toHaveClass("sessions-table");
    expect(table.querySelector(".sessions-column-workspace")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(21);
    expect(screen.getByText("21 sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Gateway 21")).toBeInTheDocument();
    expect(screen.queryByText("Gateway 1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("uses the shared search and filter interaction without an empty-table reset action", async () => {
    const user = userEvent.setup();
    renderSessions();
    await connect(user);

    const search = screen.getByRole("searchbox", { name: "Session search" });
    await user.type(search, "8490111");
    expect(screen.getByText("Production gateway")).toBeInTheDocument();
    expect(screen.queryByText("Recovery gateway")).not.toBeInTheDocument();
    await user.clear(search);

    await user.click(screen.getByRole("button", { name: "Filters" }));
    const panel = screen.getByRole("region", { name: "Session filters" });
    await user.click(within(panel).getByText("Failed"));
    await user.click(within(panel).getByText("Not loaded"));
    await user.click(within(panel).getByText("Not selected"));
    expect(screen.getByRole("button", { name: "Filters · 3" })).toBeInTheDocument();
    expect(screen.getByText("Recovery gateway")).toBeInTheDocument();
    expect(screen.queryByText("Production gateway")).not.toBeInTheDocument();

    await user.type(search, "missing");
    expect(screen.getByText("No sessions match this search or filters.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear search and filters/i })).not.toBeInTheDocument();
  });

  it("keeps search criteria while Reload refreshes only session metadata", async () => {
    const user = userEvent.setup();
    const requestSessionSync = vi.fn();
    const listSessions = vi.fn().mockResolvedValue([readySession, failedSession]);
    renderSessions({ listSessions, requestSessionSync });
    await connect(user);
    const search = screen.getByRole("searchbox", { name: "Session search" });
    await user.type(search, "Production");

    await user.click(screen.getByRole("button", { name: "Reload sessions" }));

    await waitFor(() => expect(listSessions).toHaveBeenCalledOnce());
    expect(requestSessionSync).not.toHaveBeenCalled();
    expect(search).toHaveValue("Production");
    expect(await screen.findByText("Sessions reloaded")).toBeInTheDocument();
  });

  it("does not expose full sync and routes an unsynchronized session to Groups", async () => {
    const user = userEvent.setup();
    const unsyncedSession = { ...failedSession, syncedAt: "" };
    const onOpenGroups = vi.fn();
    const api = { listSessions: vi.fn() } as unknown as RuntimeApi;
    render(
      <ToastProvider>
        <RuntimeConnectionProvider
          createApi={() => api}
          probeConnection={vi.fn().mockResolvedValue({ readySessions: 1, sessionCount: 2, sessions: [readySession, unsyncedSession] })}
        >
          <Harness onOpenGroups={onOpenGroups} />
        </RuntimeConnectionProvider>
      </ToastProvider>,
    );
    await connect(user);
    expect(screen.queryByRole("button", { name: /Sync/i })).not.toBeInTheDocument();
    expect(screen.getByText("Not synced")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Groups" }));
    expect(onOpenGroups).toHaveBeenCalledOnce();
  });
});
