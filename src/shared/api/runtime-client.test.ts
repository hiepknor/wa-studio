import { describe, expect, it, vi } from "vitest";

import {
  normalizeRuntimeBaseUrl,
  probeRuntimeConnection,
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
    ).resolves.toEqual({ sessionCount: 2, readySessions: 1 });

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
