import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSyncRun } from "@/shared/api/runtime-client";
import { pollSessionSync, SESSION_SYNC_POLL_DELAYS_MS } from "./session-sync";

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

const runningRun: RuntimeSyncRun = {
  ...pendingRun,
  phase: "RECONCILING",
  status: "RUNNING",
  groupsSynced: 4,
  membersSynced: 80,
  startedAt: "2026-08-13T09:00:01.000Z",
};

const completedRun: RuntimeSyncRun = {
  ...runningRun,
  phase: "COMPLETED",
  status: "COMPLETED",
  completedAt: "2026-08-13T09:00:09.000Z",
};

const immediateWait = vi.fn().mockResolvedValue(undefined);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pollSessionSync", () => {
  it("uses a terminal status explicitly returned by Runtime without extra polling", async () => {
    const read = vi.fn();
    await expect(pollSessionSync({
      initialRun: completedRun,
      onObservation: vi.fn(),
      read,
      signal: new AbortController().signal,
      wait: immediateWait,
    })).resolves.toEqual({ status: "completed", run: completedRun });
    expect(read).not.toHaveBeenCalled();
  });

  it("polls pending/running runs with the bounded backoff until completion", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(runningRun)
      .mockResolvedValueOnce(completedRun);
    const onObservation = vi.fn();

    await expect(pollSessionSync({
      initialRun: pendingRun,
      onObservation,
      read,
      signal: new AbortController().signal,
      wait: immediateWait,
    })).resolves.toEqual({ status: "completed", run: completedRun });

    expect(read).toHaveBeenCalledTimes(2);
    expect(onObservation).toHaveBeenNthCalledWith(1, runningRun);
    expect(onObservation).toHaveBeenNthCalledWith(2, completedRun);
    expect(immediateWait).toHaveBeenNthCalledWith(1, 1_000, expect.any(AbortSignal));
    expect(immediateWait).toHaveBeenNthCalledWith(2, 2_000, expect.any(AbortSignal));
  });

  it("stops on FAILED", async () => {
    const failedRun = { ...runningRun, status: "FAILED", error: "OpenWA unavailable" } as const;
    const read = vi.fn().mockResolvedValue(failedRun);

    await expect(pollSessionSync({
      initialRun: pendingRun,
      onObservation: vi.fn(),
      read,
      signal: new AbortController().signal,
      wait: immediateWait,
    })).resolves.toEqual({ status: "failed", run: failedRun });
    expect(read).toHaveBeenCalledOnce();
  });

  it("retries transient reads and returns background after its finite budget", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(runningRun);

    await expect(pollSessionSync({
      initialRun: pendingRun,
      onObservation: vi.fn(),
      read,
      signal: new AbortController().signal,
      wait: immediateWait,
    })).resolves.toMatchObject({ status: "background", run: runningRun });
    expect(read).toHaveBeenCalledTimes(SESSION_SYNC_POLL_DELAYS_MS.length);
  });

  it("returns background with the latest error when every read fails", async () => {
    const error = new Error("temporary");
    const read = vi.fn().mockRejectedValue(error);
    await expect(pollSessionSync({
      initialRun: pendingRun,
      onObservation: vi.fn(),
      read,
      signal: new AbortController().signal,
      wait: immediateWait,
    })).resolves.toEqual({ status: "background", run: pendingRun, error });
  });

  it("does not observe a response after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn();
    await expect(pollSessionSync({
      initialRun: pendingRun,
      onObservation: vi.fn(),
      read,
      signal: controller.signal,
      wait: vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
    })).resolves.toEqual({ status: "cancelled", run: pendingRun });
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels immediately when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn();

    await expect(pollSessionSync({
      initialRun: pendingRun,
      onObservation: vi.fn(),
      read,
      signal: controller.signal,
    })).resolves.toEqual({ status: "cancelled", run: pendingRun });
    expect(read).not.toHaveBeenCalled();
  });

  it("removes the abort listener after a polling delay completes", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const poll = pollSessionSync({
      initialRun: pendingRun,
      onObservation: vi.fn(),
      read: vi.fn().mockResolvedValue(completedRun),
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(poll).resolves.toEqual({ status: "completed", run: completedRun });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
