import { describe, expect, it, vi } from "vitest";

import { createRuntimeHttpFetch, RuntimeTransportError } from "./runtime-http";
import { isUnknownMutationOutcome } from "./runtime-mutation";

describe("Runtime HTTP policy", () => {
  it("binds requests to API v1 on the configured origin and disables redirects", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ data: [] }),
    );
    const runtimeFetch = createRuntimeHttpFetch(
      "https://runtime.example",
      upstream,
    );

    const response = await runtimeFetch(new Request(
      "https://runtime.example/api/v1/sessions",
      { headers: { "X-Runtime-Key": "sensitive-key" } },
    ));

    expect(await response.json()).toEqual({ data: [] });
    const request = upstream.mock.calls[0][0] as Request;
    expect(request.redirect).toBe("error");
    expect(request.headers.get("X-Runtime-Key")).toBe("sensitive-key");
  });

  it("rejects cross-origin, non-API, and encoded traversal targets before fetch", async () => {
    const upstream = vi.fn<typeof fetch>();
    const runtimeFetch = createRuntimeHttpFetch(
      "https://runtime.example",
      upstream,
    );

    await expect(runtimeFetch("https://other.example/api/v1/sessions"))
      .rejects.toThrow("escaped the configured API origin");
    await expect(runtimeFetch("https://runtime.example/admin"))
      .rejects.toThrow("escaped the configured API origin");
    await expect(runtimeFetch("https://runtime.example/api/v1/%252e%252e/admin"))
      .rejects.toThrow("escaped the configured API origin");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("fails closed if an upstream adapter reports that it followed a redirect", async () => {
    const redirected = Response.json({ data: [] });
    Object.defineProperty(redirected, "redirected", { value: true });
    const runtimeFetch = createRuntimeHttpFetch(
      "https://runtime.example",
      vi.fn<typeof fetch>().mockResolvedValue(redirected),
    );

    await expect(runtimeFetch("https://runtime.example/api/v1/sessions"))
      .rejects.toThrow("redirects are not allowed");
  });

  it("bounds both declared and streamed response bodies", async () => {
    const declared = createRuntimeHttpFetch(
      "https://runtime.example",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("small", {
        headers: { "content-length": "100" },
      })),
      { successResponseMaxBytes: 8 },
    );
    await expect(declared("https://runtime.example/api/v1/sessions"))
      .rejects.toThrow("8 byte safety limit");

    const streamed = createRuntimeHttpFetch(
      "https://runtime.example",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("123456789")),
      { successResponseMaxBytes: 8 },
    );
    await expect(streamed("https://runtime.example/api/v1/sessions"))
      .rejects.toBeInstanceOf(RuntimeTransportError);
  });

  it("bounds request bodies before credentials cross the transport adapter", async () => {
    const upstream = vi.fn<typeof fetch>();
    const runtimeFetch = createRuntimeHttpFetch(
      "https://runtime.example",
      upstream,
      { requestMaxBytes: 4 },
    );

    const error = await runtimeFetch("https://runtime.example/api/v1/campaigns", {
      body: "12345",
      method: "POST",
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: "WA Runtime request exceeded the 4 byte safety limit.",
      requestDispatched: false,
    });
    expect(isUnknownMutationOutcome(error)).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("marks a mutation transport failure after dispatch as an unknown outcome", async () => {
    const runtimeFetch = createRuntimeHttpFetch(
      "https://runtime.example",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("response lost")),
    );

    const error = await runtimeFetch("https://runtime.example/api/v1/campaigns", {
      body: "{}",
      method: "POST",
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      message: "WA Runtime connection ended before a complete response was received.",
      requestDispatched: true,
    });
    expect(isUnknownMutationOutcome(error)).toBe(true);
  });

  it("uses the smaller error-body bound", async () => {
    const runtimeFetch = createRuntimeHttpFetch(
      "https://runtime.example",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("12345", { status: 500 })),
      { successResponseMaxBytes: 10, errorResponseMaxBytes: 4 },
    );

    await expect(runtimeFetch("https://runtime.example/api/v1/sessions"))
      .rejects.toThrow("4 byte safety limit");
  });

  it("applies a deadline even when an upstream adapter ignores abort", async () => {
    const runtimeFetch = createRuntimeHttpFetch(
      "https://runtime.example",
      vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => undefined)),
      { requestTimeoutMs: 5 },
    );

    const pending = runtimeFetch("https://runtime.example/api/v1/sessions");
    await expect(pending).rejects.toMatchObject({ requestDispatched: true });
    await expect(pending).rejects.toThrow("within 1 seconds");
  });

  it("keeps the deadline active while reading the response body", async () => {
    const runtimeFetch = createRuntimeHttpFetch(
      "https://runtime.example",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
        pull: () => new Promise<void>(() => undefined),
      }))),
      { requestTimeoutMs: 5 },
    );

    await expect(runtimeFetch("https://runtime.example/api/v1/sessions"))
      .rejects.toThrow("within 1 seconds");
  });

  it("preserves caller cancellation instead of reporting it as a timeout", async () => {
    const controller = new AbortController();
    const runtimeFetch = createRuntimeHttpFetch(
      "https://runtime.example",
      vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => undefined)),
    );
    const pending = runtimeFetch("https://runtime.example/api/v1/sessions", {
      signal: controller.signal,
    });

    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(new DOMException("left screen", "AbortError"));
    await assertion;
  });
});
