import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeApi, RuntimeSyncRun } from "@/shared/api/runtime-client";
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
    unmount();
    request.resolve(pendingRun);
    await expect(first).resolves.toBeNull();
  });
});
