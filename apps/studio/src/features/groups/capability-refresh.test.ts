import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeGroupCapabilityRefresh } from "@/shared/api/runtime-client";
import {
  CAPABILITY_REFRESH_POLL_DELAYS_MS,
  capabilityRefreshIsActive,
  pollCapabilityRefresh,
} from "./capability-refresh";

const pendingOperation: RuntimeGroupCapabilityRefresh = {
  sessionId: "session-id",
  groupId: "group@g.us",
  requestRevision: 4,
  status: "PENDING",
  source: "MANUAL",
  attemptCount: 0,
  requestedAt: "2026-08-29T00:00:00.000Z",
  startedAt: null,
  nextAttemptAt: "2026-08-29T00:00:00.000Z",
  completedAt: null,
  errorCode: null,
};

const completedOperation: RuntimeGroupCapabilityRefresh = {
  ...pendingOperation,
  status: "COMPLETED",
  attemptCount: 1,
  startedAt: "2026-08-29T00:00:01.000Z",
  nextAttemptAt: null,
  completedAt: "2026-08-29T00:00:02.000Z",
};

describe("capability refresh operation polling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("classifies only non-terminal Runtime operations as active", () => {
    expect(capabilityRefreshIsActive(pendingOperation)).toBe(true);
    expect(capabilityRefreshIsActive({ ...pendingOperation, status: "RUNNING" })).toBe(true);
    expect(capabilityRefreshIsActive({ ...pendingOperation, status: "RETRYING" })).toBe(true);
    expect(capabilityRefreshIsActive(completedOperation)).toBe(false);
    expect(capabilityRefreshIsActive(null)).toBe(false);
  });

  it("polls the operation until Runtime marks the requested revision complete", async () => {
    vi.useFakeTimers();
    const running = { ...pendingOperation, status: "RUNNING" as const, attemptCount: 1 };
    const read = vi.fn()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completedOperation);
    const onObservation = vi.fn();
    const resultPromise = pollCapabilityRefresh({
      initialOperation: pendingOperation,
      signal: new AbortController().signal,
      read,
      onObservation,
    });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_DELAYS_MS[0]);
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_DELAYS_MS[1]);

    await expect(resultPromise).resolves.toEqual({
      status: "completed",
      operation: completedOperation,
    });
    expect(onObservation).toHaveBeenNthCalledWith(1, running);
    expect(onObservation).toHaveBeenNthCalledWith(2, completedOperation);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries transient reads and completes on a later observation", async () => {
    vi.useFakeTimers();
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValueOnce(completedOperation);
    const resultPromise = pollCapabilityRefresh({
      initialOperation: pendingOperation,
      signal: new AbortController().signal,
      read,
      onObservation: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(
      CAPABILITY_REFRESH_POLL_DELAYS_MS[0] + CAPABILITY_REFRESH_POLL_DELAYS_MS[1],
    );

    await expect(resultPromise).resolves.toMatchObject({ status: "completed" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("hands an active operation back to the background after bounded observation", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(pendingOperation);
    const resultPromise = pollCapabilityRefresh({
      initialOperation: pendingOperation,
      signal: new AbortController().signal,
      read,
      onObservation: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(
      CAPABILITY_REFRESH_POLL_DELAYS_MS.reduce((total, delay) => total + delay, 0),
    );

    await expect(resultPromise).resolves.toEqual({
      status: "background",
      operation: pendingOperation,
      error: null,
    });
    expect(read).toHaveBeenCalledTimes(CAPABILITY_REFRESH_POLL_DELAYS_MS.length);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns terminal failed operations with their Runtime error code", async () => {
    vi.useFakeTimers();
    const failed = {
      ...pendingOperation,
      status: "FAILED" as const,
      nextAttemptAt: null,
      completedAt: "2026-08-29T00:00:02.000Z",
      errorCode: "UPSTREAM_HTTP_403",
    };
    const resultPromise = pollCapabilityRefresh({
      initialOperation: pendingOperation,
      signal: new AbortController().signal,
      read: vi.fn().mockResolvedValue(failed),
      onObservation: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_DELAYS_MS[0]);

    await expect(resultPromise).resolves.toEqual({ status: "failed", operation: failed });
  });

  it("returns an already terminal operation without scheduling a read", async () => {
    const read = vi.fn();
    await expect(pollCapabilityRefresh({
      initialOperation: completedOperation,
      signal: new AbortController().signal,
      read,
      onObservation: vi.fn(),
    })).resolves.toEqual({ status: "completed", operation: completedOperation });
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels a pending timer without reading or leaking timers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn();
    const resultPromise = pollCapabilityRefresh({
      initialOperation: pendingOperation,
      signal: controller.signal,
      read,
      onObservation: vi.fn(),
    });

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an in-flight read that resolves after cancellation", async () => {
    vi.useFakeTimers();
    let resolveRead: ((operation: RuntimeGroupCapabilityRefresh) => void) | undefined;
    const read = vi.fn(() => new Promise<RuntimeGroupCapabilityRefresh>((resolve) => {
      resolveRead = resolve;
    }));
    const onObservation = vi.fn();
    const controller = new AbortController();
    const resultPromise = pollCapabilityRefresh({
      initialOperation: pendingOperation,
      signal: controller.signal,
      read,
      onObservation,
    });
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_DELAYS_MS[0]);
    controller.abort();
    resolveRead?.(completedOperation);

    await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
    expect(onObservation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
