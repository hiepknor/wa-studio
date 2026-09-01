import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeApi, RuntimeSyncRun } from "@/shared/api/runtime-client";
import { RuntimeTransportError } from "@/shared/api/runtime-http";
import { useSessionSync } from "./useSessionSync";

const pendingRun: RuntimeSyncRun = {
  id: "run-id",
  sessionId: "session-id",
  syncType: "FULL",
  phase: "DISCOVERING",
  status: "PENDING",
  groupsSynced: 0,
  groupsDiscovered: 0,
  groupsScheduled: 0,
  groupsFailed: 0,
  groupsSkipped: 0,
  groupsPending: 0,
  groupsRunning: 0,
  groupsRetrying: 0,
  membersSynced: 0,
  nextAttemptAt: null,
  cooldownUntil: null,
  error: null,
  requestedAt: "2026-08-13T09:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("useSessionSync", () => {
  it("allows only one sync request before React can render the busy state", async () => {
    const request = deferred<RuntimeSyncRun>();
    const requestSessionSync = vi.fn().mockReturnValue(request.promise);
    const runtimeApi = { requestSessionSync } as unknown as RuntimeApi;
    const { result, unmount } = renderHook(() => useSessionSync({
      runtimeApi,
      runtimeOrigin: "https://runtime.example",
      sessionId: "session-id",
    }));
    let first!: ReturnType<typeof result.current.start>;
    let second!: ReturnType<typeof result.current.start>;

    act(() => {
      first = result.current.start();
      second = result.current.start();
    });

    await expect(second).resolves.toBeNull();
    expect(requestSessionSync).toHaveBeenCalledOnce();
    expect(requestSessionSync).toHaveBeenCalledWith(
      "session-id",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    unmount();
    request.resolve(pendingRun);
    await expect(first).resolves.toBeNull();
  });

  it("reuses the operation key after an unconfirmed sync response", async () => {
    const failedRun: RuntimeSyncRun = {
      ...pendingRun,
      status: "FAILED",
      error: "OpenWA unavailable",
      completedAt: "2026-08-13T09:00:01.000Z",
    };
    const requestSessionSync = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeTransportError(
        "response lost",
        { requestDispatched: true },
      ))
      .mockResolvedValueOnce(failedRun);
    const runtimeApi = { requestSessionSync } as unknown as RuntimeApi;
    const { result } = renderHook(() => useSessionSync({
      runtimeApi,
      runtimeOrigin: "https://runtime.example",
      sessionId: "session-id",
    }));

    let first!: Awaited<ReturnType<typeof result.current.start>>;
    await act(async () => { first = await result.current.start(); });
    expect(first?.status).toBe("unknown");

    let second!: Awaited<ReturnType<typeof result.current.start>>;
    await act(async () => { second = await result.current.start(); });
    expect(second?.status).toBe("failed");
    expect(requestSessionSync).toHaveBeenCalledTimes(2);
    expect(requestSessionSync.mock.calls[1]?.[1]).toBe(
      requestSessionSync.mock.calls[0]?.[1],
    );
  });
});
