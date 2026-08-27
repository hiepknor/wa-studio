import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import {
  RuntimeRequestError,
  type RuntimeApi,
  type RuntimeCampaign,
  type RuntimeCampaignPage,
  type RuntimeSession,
} from "@/shared/api/runtime-client";
import { DrawerHost, DrawerProvider } from "@/shared/ui/Drawer";
import { ToastProvider } from "@/shared/ui/Toast";
import { CampaignsScreen } from "./CampaignsScreen";

const READ_OPTIONS = expect.objectContaining({ signal: expect.any(AbortSignal) });

const primarySession: RuntimeSession = {
  id: "primary-session", name: "Primary", status: "ready", phone: null, pushName: null,
  connectedAt: null, lastActiveAt: null, engineLoaded: true, lastError: null,
  restriction: null, gatewayCreatedAt: "2026-08-14T00:00:00.000Z",
  gatewayUpdatedAt: "2026-08-14T00:00:00.000Z", syncedAt: "2026-08-14T00:00:00.000Z",
};
const secondarySession: RuntimeSession = { ...primarySession, id: "secondary-session", name: "Secondary" };

function campaign(id: string, name: string): RuntimeCampaign {
  return {
    id, sessionId: primarySession.id, name, text: "Message", scheduleType: "IMMEDIATE",
    scheduledAt: null, status: "DRAFT", targetCount: 0, revision: 1, targetsRevision: 0,
    createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function page(data: RuntimeCampaign[], total = data.length, offset = 0): RuntimeCampaignPage {
  return { data, meta: { total, limit: 50, offset } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function Harness({ allowSwitch = false }: { allowSwitch?: boolean }) {
  const { connect, connected, selectSession } = useRuntimeConnection();
  if (!connected) return <button onClick={() => void connect({ baseUrl: "https://runtime.example", apiKey: "0123456789abcdef0123456789abcdef" })}>Connect</button>;
  return <>{allowSwitch && <button onClick={() => selectSession(secondarySession.id)}>Switch session</button>}<CampaignsScreen /></>;
}

function renderList(listCampaigns: RuntimeApi["listCampaigns"], allowSwitch = false) {
  const api = { listCampaigns } as unknown as RuntimeApi;
  const sessions = allowSwitch ? [primarySession, secondarySession] : [primarySession];
  const view = render(
    <ToastProvider><RuntimeConnectionProvider
      createApi={() => api}
      probeConnection={vi.fn().mockResolvedValue({ readySessions: sessions.length, sessionCount: sessions.length, sessions })}
    ><DrawerProvider><Harness allowSwitch={allowSwitch} /><DrawerHost /></DrawerProvider></RuntimeConnectionProvider></ToastProvider>,
  );
  return { api, ...view };
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("searchbox", { name: "Search campaigns" });
}

describe("CampaignsScreen server-side list", () => {
  it("debounces trimmed search, resets offset, and renders the server page without client filtering", async () => {
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>()
      .mockResolvedValueOnce(page([campaign("old", "Current page")], 80, 0))
      .mockResolvedValueOnce(page([campaign("page-2", "Second page")], 80, 50))
      .mockResolvedValueOnce(page([campaign("server", "Authoritative row")], 1, 0));
    const user = userEvent.setup();
    renderList(listCampaigns);
    await connect(user);
    await screen.findByText("Current page");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Second page");

    await user.type(screen.getByRole("searchbox", { name: "Search campaigns" }), "  needle  ");
    expect(listCampaigns).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    expect(listCampaigns).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(3));
    await screen.findByText("Authoritative row");
    expect(listCampaigns).toHaveBeenLastCalledWith(expect.objectContaining({
      offset: 0,
      query: "needle",
    }), READ_OPTIONS);
  });

  it("applies multi-select filters, removes individual values, and clears all", async () => {
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>((input) => Promise.resolve(
      page([], input.statuses?.length || input.scheduleTypes?.length ? 0 : 80, input.offset ?? 0),
    ));
    const user = userEvent.setup();
    renderList(listCampaigns);
    await connect(user);
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(listCampaigns).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 50 }),
      READ_OPTIONS,
    ));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const panel = screen.getByRole("region", { name: "Campaign filters" });
    await user.click(within(panel).getByRole("checkbox", { name: "Draft" }));
    await user.click(within(panel).getByRole("checkbox", { name: "Paused" }));
    await user.click(within(panel).getByRole("checkbox", { name: "Immediate" }));
    await user.click(within(panel).getByRole("checkbox", { name: "Once" }));
    await waitFor(() => expect(listCampaigns).toHaveBeenLastCalledWith(expect.objectContaining({
      offset: 0,
      statuses: ["DRAFT", "PAUSED"],
      scheduleTypes: ["IMMEDIATE", "ONCE"],
    }), READ_OPTIONS));
    expect(screen.getByRole("button", { name: "Filters · 2" })).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Remove Draft filter" }));
    await waitFor(() => expect(listCampaigns).toHaveBeenLastCalledWith(
      expect.objectContaining({ statuses: ["PAUSED"] }),
      READ_OPTIONS,
    ));
    await user.click(within(panel).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(listCampaigns).toHaveBeenLastCalledWith({
      sessionId: primarySession.id,
      limit: 50,
      offset: 0,
    }, READ_OPTIONS));
  });

  it("uses filtered meta.total for pagination and recovers an out-of-range page", async () => {
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>()
      .mockResolvedValueOnce(page([campaign("first", "First")], 51, 0))
      .mockResolvedValueOnce(page([], 1, 50))
      .mockResolvedValueOnce(page([campaign("recovered", "Recovered")], 1, 0));
    const user = userEvent.setup();
    renderList(listCampaigns);
    await connect(user);
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Recovered")).toBeInTheDocument();
    expect(listCampaigns).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0 }),
      READ_OPTIONS,
    );
  });

  it("distinguishes unfiltered and filtered empty states", async () => {
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>().mockResolvedValue(page([], 0));
    const user = userEvent.setup();
    renderList(listCampaigns);
    await connect(user);
    expect(await screen.findByText("No campaigns yet. Create a draft to get started.")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search campaigns" }), "missing");
    expect(await screen.findByText("No campaigns match this search or filters.")).toBeInTheDocument();
  });

  it.each([
    ["CAMPAIGN_FILTER_STATUS_INVALID", "One or more campaign status filters are invalid."],
    ["CAMPAIGN_FILTER_SCHEDULE_TYPE_INVALID", "One or more campaign schedule filters are invalid."],
    ["CAMPAIGN_QUERY_INVALID", "Campaign search must be 200 characters or fewer."],
  ])("renders typed %s validation without parsing Runtime message", async (code, copy) => {
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>().mockRejectedValue(
      new RuntimeRequestError("opaque Runtime message", {
        code,
        fieldErrors: { query: ["opaque field message"] },
        status: 400,
      }),
    );
    const user = userEvent.setup();
    renderList(listCampaigns);
    await connect(user);
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByText("opaque Runtime message")).not.toBeInTheDocument();
  });

  it("sends an oversized query to Runtime and renders its typed field validation", async () => {
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>()
      .mockResolvedValueOnce(page([], 0))
      .mockRejectedValueOnce(new RuntimeRequestError("opaque", {
        code: "CAMPAIGN_QUERY_INVALID",
        fieldErrors: { query: ["too long"] },
        status: 400,
      }));
    const user = userEvent.setup();
    renderList(listCampaigns);
    await connect(user);
    await user.type(screen.getByRole("searchbox", { name: "Search campaigns" }), "x".repeat(201));
    expect(await screen.findByText("Campaign search must be 200 characters or fewer.")).toBeInTheDocument();
    expect(listCampaigns).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "x".repeat(201) }),
      READ_OPTIONS,
    );
  });

  it("prevents late search and filter responses from overwriting newer criteria", async () => {
    const oldSearch = deferred<RuntimeCampaignPage>();
    const newSearch = deferred<RuntimeCampaignPage>();
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>()
      .mockResolvedValueOnce(page([], 0))
      .mockReturnValueOnce(oldSearch.promise)
      .mockReturnValueOnce(newSearch.promise);
    const user = userEvent.setup();
    renderList(listCampaigns);
    await connect(user);
    const search = screen.getByRole("searchbox", { name: "Search campaigns" });
    await user.type(search, "old");
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(2));
    const oldSignal = listCampaigns.mock.calls[1][1]?.signal;
    expect(oldSignal).toBeInstanceOf(AbortSignal);
    await user.clear(search);
    await user.type(search, "new");
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(3));
    expect(oldSignal?.aborted).toBe(true);
    expect(listCampaigns.mock.calls[2][1]?.signal?.aborted).toBe(false);
    newSearch.resolve(page([campaign("new", "New result")], 1));
    expect(await screen.findByText("New result")).toBeInTheDocument();
    oldSearch.resolve(page([campaign("old", "Old result")], 1));
    await act(() => Promise.resolve());
    expect(screen.queryByText("Old result")).not.toBeInTheDocument();
  });

  it("prevents a late filter response from replacing a newer filter set", async () => {
    const draftOnly = deferred<RuntimeCampaignPage>();
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>()
      .mockResolvedValueOnce(page([], 0))
      .mockReturnValueOnce(draftOnly.promise)
      .mockResolvedValueOnce(page([campaign("combined", "Combined filters")], 1));
    const user = userEvent.setup();
    renderList(listCampaigns);
    await connect(user);
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const panel = screen.getByRole("region", { name: "Campaign filters" });
    await user.click(within(panel).getByRole("checkbox", { name: "Draft" }));
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(2));
    await user.click(within(panel).getByRole("checkbox", { name: "Paused" }));
    expect(await screen.findByText("Combined filters")).toBeInTheDocument();
    draftOnly.resolve(page([campaign("stale", "Draft-only stale")], 1));
    await act(() => Promise.resolve());
    expect(screen.queryByText("Draft-only stale")).not.toBeInTheDocument();
  });

  it("invalidates an in-flight page when the workspace session changes", async () => {
    const oldSession = deferred<RuntimeCampaignPage>();
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>((input) => input.sessionId === primarySession.id
      ? oldSession.promise
      : Promise.resolve(page([{ ...campaign("secondary", "Secondary result"), sessionId: secondarySession.id }], 1)));
    const user = userEvent.setup();
    renderList(listCampaigns, true);
    await connect(user);
    await user.click(screen.getByRole("button", { name: "Switch session" }));
    expect(await screen.findByText("Secondary result")).toBeInTheDocument();
    oldSession.resolve(page([campaign("primary", "Primary stale result")], 1));
    await act(() => Promise.resolve());
    expect(screen.queryByText("Primary stale result")).not.toBeInTheDocument();
  });

  it("resets search, filters, and offset when the workspace session changes", async () => {
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>().mockResolvedValue(page([], 80));
    const user = userEvent.setup();
    renderList(listCampaigns, true);
    await connect(user);
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("searchbox", { name: "Search campaigns" }), "release");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(within(screen.getByRole("region", { name: "Campaign filters" }))
      .getByRole("checkbox", { name: "Draft" }));

    await user.click(screen.getByRole("button", { name: "Switch session" }));

    expect(screen.getByRole("searchbox", { name: "Search campaigns" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    await waitFor(() => expect(listCampaigns).toHaveBeenLastCalledWith({
      sessionId: secondarySession.id,
      limit: 50,
      offset: 0,
    }, READ_OPTIONS));
  });

  it("invalidates a pending page request when the screen unmounts", async () => {
    const pending = deferred<RuntimeCampaignPage>();
    const listCampaigns = vi.fn<RuntimeApi["listCampaigns"]>().mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const view = renderList(listCampaigns);
    await connect(user);
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledTimes(1));
    const signal = listCampaigns.mock.calls[0][1]?.signal;

    view.unmount();
    expect(signal?.aborted).toBe(true);
    pending.resolve(page([campaign("late", "Late result")], 1));
    await act(() => Promise.resolve());

    expect(screen.queryByText("Late result")).not.toBeInTheDocument();
  });
});
