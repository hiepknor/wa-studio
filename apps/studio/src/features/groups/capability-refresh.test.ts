import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeGroupDetail } from "@/shared/api/runtime-client";
import {
  CAPABILITY_REFRESH_POLL_DELAYS_MS,
  capabilityRefreshCompleted,
  pollCapabilityRefresh,
} from "./capability-refresh";

const baselineDetail: RuntimeGroupDetail = {
  sessionId: "session-id",
  id: "group@g.us",
  name: "Group",
  description: null,
  ownerId: null,
  linkedParentId: null,
  participantsCount: 1,
  isAdmin: true,
  isReadOnly: false,
  isAnnounce: false,
  settingsLocked: false,
  isActive: true,
  detailsSyncedAt: "2026-08-13T01:00:00.000Z",
  syncedAt: "2026-08-13T01:00:00.000Z",
  sendCapability: {
    status: "DENIED",
    reason: "session_is_member",
    checkedAt: "2026-08-13T01:00:00.000Z",
    invalidatedAt: null,
    revision: 4,
  },
};

const pendingDetail: RuntimeGroupDetail = {
  ...baselineDetail,
  sendCapability: {
    status: "UNKNOWN",
    reason: "MANUAL_REFRESH",
    checkedAt: baselineDetail.sendCapability.checkedAt,
    invalidatedAt: "2026-08-13T01:01:00.000Z",
    revision: 5,
  },
};

const completedDetail: RuntimeGroupDetail = {
  ...baselineDetail,
  detailsSyncedAt: "2026-08-13T01:01:02.000Z",
  sendCapability: {
    ...baselineDetail.sendCapability,
    checkedAt: "2026-08-13T01:01:02.000Z",
    revision: 5,
  },
};

describe("capability refresh polling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requires a new completed check rather than a revision-only invalidation", () => {
    expect(capabilityRefreshCompleted(
      baselineDetail.sendCapability,
      pendingDetail.sendCapability,
    )).toBe(false);
    expect(capabilityRefreshCompleted(
      baselineDetail.sendCapability,
      {
        ...completedDetail.sendCapability,
        revision: baselineDetail.sendCapability.revision,
      },
    )).toBe(true);
  });

  it("polls with bounded backoff until checkedAt changes even when status and reason do not", async () => {
    vi.useFakeTimers();
    const read = vi.fn()
      .mockResolvedValueOnce(pendingDetail)
      .mockResolvedValueOnce({
        ...completedDetail,
        sendCapability: {
          ...completedDetail.sendCapability,
          revision: baselineDetail.sendCapability.revision,
        },
      });
    const onObservation = vi.fn();
    const controller = new AbortController();
    const resultPromise = pollCapabilityRefresh({
      baseline: baselineDetail.sendCapability,
      signal: controller.signal,
      read,
      onObservation,
    });

    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_DELAYS_MS[0]);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_DELAYS_MS[1]);

    await expect(resultPromise).resolves.toMatchObject({ status: "completed" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(onObservation).toHaveBeenLastCalledWith(expect.objectContaining({
      sendCapability: expect.objectContaining({
        status: baselineDetail.sendCapability.status,
        reason: baselineDetail.sendCapability.reason,
      }),
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries read failures and completes on a later observation", async () => {
    vi.useFakeTimers();
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("Could not load group details (HTTP 503)."))
      .mockResolvedValueOnce(completedDetail);
    const resultPromise = pollCapabilityRefresh({
      baseline: baselineDetail.sendCapability,
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

  it("stops after the bounded timeout and returns the latest observation", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(pendingDetail);
    const resultPromise = pollCapabilityRefresh({
      baseline: baselineDetail.sendCapability,
      signal: new AbortController().signal,
      read,
      onObservation: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(
      CAPABILITY_REFRESH_POLL_DELAYS_MS.reduce((total, delay) => total + delay, 0),
    );

    await expect(resultPromise).resolves.toMatchObject({
      status: "timed-out",
      detail: pendingDetail,
      error: null,
    });
    expect(read).toHaveBeenCalledTimes(CAPABILITY_REFRESH_POLL_DELAYS_MS.length);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a terminal Runtime refresh failure as failed", async () => {
    vi.useFakeTimers();
    const failedDetail = {
      ...completedDetail,
      sendCapability: {
        ...completedDetail.sendCapability,
        status: "UNKNOWN" as const,
        reason: "REFRESH_FAILED",
      },
    };
    const resultPromise = pollCapabilityRefresh({
      baseline: baselineDetail.sendCapability,
      signal: new AbortController().signal,
      read: vi.fn().mockResolvedValue(failedDetail),
      onObservation: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_DELAYS_MS[0]);

    await expect(resultPromise).resolves.toMatchObject({ status: "failed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending timer without reading or leaking timers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn();
    const resultPromise = pollCapabilityRefresh({
      baseline: baselineDetail.sendCapability,
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
    let resolveRead: ((detail: RuntimeGroupDetail) => void) | undefined;
    const read = vi.fn(() => new Promise<RuntimeGroupDetail>((resolve) => {
      resolveRead = resolve;
    }));
    const onObservation = vi.fn();
    const controller = new AbortController();
    const resultPromise = pollCapabilityRefresh({
      baseline: baselineDetail.sendCapability,
      signal: controller.signal,
      read,
      onObservation,
    });
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_POLL_DELAYS_MS[0]);
    expect(read).toHaveBeenCalledTimes(1);

    controller.abort();
    resolveRead?.(completedDetail);

    await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
    expect(onObservation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
