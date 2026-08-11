import { describe, expect, it, vi } from "vitest";

import {
  normalizeRuntimeBaseUrl,
  probeRuntimeConnection,
  RuntimeApi,
  RuntimeConnectionError,
} from "./runtime-client";

describe("normalizeRuntimeBaseUrl", () => {
  it("normalizes an origin", () => {
    expect(normalizeRuntimeBaseUrl(" http://127.0.0.1:3100/ ")).toBe(
      "http://127.0.0.1:3100",
    );
  });

  it("accepts a copied API base URL without duplicating the version prefix", () => {
    expect(normalizeRuntimeBaseUrl("https://runtime.example.com/api/v1/")).toBe(
      "https://runtime.example.com",
    );
  });

  it("rejects non-http protocols", () => {
    expect(() => normalizeRuntimeBaseUrl("file:///tmp/runtime")).toThrow(
      RuntimeConnectionError,
    );
  });
});

describe("probeRuntimeConnection", () => {
  it("checks readiness, authenticates, and summarizes sessions", async () => {
    const runtimeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { id: "dev", status: "ready" },
            { id: "secondary", status: "disconnected" },
          ],
        }),
      );

    await expect(
      probeRuntimeConnection(
        { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
        runtimeFetch,
      ),
    ).resolves.toMatchObject({
      sessionCount: 2,
      readySessions: 1,
      sessions: [
        { id: "dev", status: "ready" },
        { id: "secondary", status: "disconnected" },
      ],
    });

    expect(runtimeFetch).toHaveBeenCalledTimes(2);
    const sessionRequest = runtimeFetch.mock.calls[1][0];
    expect(sessionRequest).toBeInstanceOf(Request);
    expect((sessionRequest as Request).headers.get("X-Runtime-Key")).toBe("test-key");
  });

  it("maps an unauthorized response to a useful error", async () => {
    const runtimeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(
      probeRuntimeConnection(
        { baseUrl: "http://127.0.0.1:3100", apiKey: "wrong-key" },
        runtimeFetch,
      ),
    ).rejects.toThrow("Runtime API key was rejected.");
  });
});

describe("RuntimeApi", () => {
  it("starts a full session sync through the versioned Runtime endpoint", async () => {
    const syncRun = {
      id: "sync-id",
      sessionId: "session id",
      syncType: "FULL",
      status: "PENDING",
      groupsSynced: 0,
      membersSynced: 0,
      error: null,
      requestedAt: "2026-08-11T09:00:00.000Z",
      startedAt: null,
      completedAt: null,
    };
    const runtimeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(syncRun, { status: 202 }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    await expect(api.requestSessionSync("session id")).resolves.toEqual(syncRun);

    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "http://127.0.0.1:3100/api/v1/sessions/session%20id/sync",
    );
    expect(request.headers.get("X-Runtime-Key")).toBe("test-key");
  });
});
