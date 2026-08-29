import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeApi, RuntimeStateRevisions } from "@/shared/api/runtime-client";
import {
  RuntimeInvalidationProvider,
  useRuntimeInvalidation,
  useRuntimeResourceRevision,
} from "./runtime-invalidation";

const sessionId = "00000000-0000-4000-8000-000000000001";

function snapshot(overrides: Partial<RuntimeStateRevisions> = {}): RuntimeStateRevisions {
  return {
    activity: 1,
    campaigns: 1,
    deliveries: 1,
    groupLists: 1,
    groups: 1,
    runs: 1,
    sessions: 1,
    sessionId,
    ...overrides,
  };
}

function RevisionProbe() {
  const { invalidate } = useRuntimeInvalidation();
  const groups = useRuntimeResourceRevision(["groups"], sessionId);
  const sessions = useRuntimeResourceRevision(["sessions"], sessionId);
  return <>
    <output aria-label="groups revision">{groups}</output>
    <output aria-label="sessions revision">{sessions}</output>
    <button onClick={() => invalidate({ resources: ["groups"], sessionId })}>Invalidate groups</button>
  </>;
}

describe("RuntimeInvalidationProvider", () => {
  it("translates remote revision changes into scoped revalidation signals", async () => {
    const getStateRevisions = vi.fn<RuntimeApi["getStateRevisions"]>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ groups: 2, sessions: 2 }));
    const refreshSessions = vi.fn().mockResolvedValue(true);
    const api = { getStateRevisions } as unknown as RuntimeApi;

    render(
      <RuntimeInvalidationProvider
        api={api}
        onSessionsChanged={refreshSessions}
        sessionId={sessionId}
      >
        <RevisionProbe />
      </RuntimeInvalidationProvider>,
    );

    await waitFor(() => expect(getStateRevisions).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByLabelText("groups revision")).toHaveTextContent("groups:0:1"));
    expect(screen.getByLabelText("sessions revision")).toHaveTextContent("sessions:1:0");
    expect(refreshSessions).toHaveBeenCalledOnce();

    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(getStateRevisions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText("groups revision")).toHaveTextContent("groups:0:2"));
    expect(screen.getByLabelText("sessions revision")).toHaveTextContent("sessions:2:0");
    expect(refreshSessions).toHaveBeenCalledTimes(2);
  });

  it("supports immediate mutation invalidation without a polling client", async () => {
    render(<RuntimeInvalidationProvider><RevisionProbe /></RuntimeInvalidationProvider>);
    expect(screen.getByLabelText("groups revision")).toHaveTextContent("groups:0:0");
    await act(async () => screen.getByRole("button", { name: "Invalidate groups" }).click());
    expect(screen.getByLabelText("groups revision")).toHaveTextContent("groups:0:1");
  });

  it("continues observing session discovery before a session is selected", async () => {
    const getStateRevisions = vi.fn<RuntimeApi["getStateRevisions"]>()
      .mockResolvedValue(snapshot({ sessionId: null }));
    const api = { getStateRevisions } as unknown as RuntimeApi;

    render(
      <RuntimeInvalidationProvider api={api}>
        <RevisionProbe />
      </RuntimeInvalidationProvider>,
    );

    await waitFor(() => expect(getStateRevisions).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await waitFor(() => expect(screen.getByLabelText("sessions revision")).toHaveTextContent("sessions:1:0"));
    expect(screen.getByLabelText("groups revision")).toHaveTextContent("groups:0:0");
  });
});
