import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { managedRuntimeFetch } from "./runtime-transport";

describe("managed Runtime native transport", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("sends only API path, JSON body, and allowlisted headers across the webview boundary", async () => {
    invoke.mockResolvedValue({
      status: 202,
      headers: { "content-type": "application/json" },
      body: "{\"accepted\":true}",
    });

    const response = await managedRuntimeFetch(
      "http://127.0.0.1:34100/api/v1/sessions/session-1/sync?mode=FULL",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "request-1",
          "x-runtime-key": "must-not-cross-the-webview-boundary",
        },
        body: "{\"mode\":\"FULL\"}",
      },
    );

    expect(invoke).toHaveBeenCalledWith("request_managed_runtime", {
      request: {
        method: "POST",
        path: "/api/v1/sessions/session-1/sync?mode=FULL",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "request-1",
        },
        body: "{\"mode\":\"FULL\"}",
      },
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("rejects paths and methods outside the reviewed Runtime API surface", async () => {
    await expect(managedRuntimeFetch("http://127.0.0.1:34100/admin"))
      .rejects.toThrow("outside API v1");
    await expect(managedRuntimeFetch("http://127.0.0.1:34100/api/v1/sessions", {
      method: "OPTIONS",
    })).rejects.toThrow("outside API v1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("enforces the native request-body limit before crossing IPC", async () => {
    await expect(managedRuntimeFetch("http://127.0.0.1:34100/api/v1/campaigns", {
      body: "x".repeat(2 * 1024 * 1024 + 1),
      method: "POST",
    })).rejects.toThrow("request body exceeds 2 MiB");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not trust an oversized response returned across IPC", async () => {
    invoke.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: "x".repeat(8 * 1024 * 1024 + 1),
    });

    await expect(managedRuntimeFetch("http://127.0.0.1:34100/api/v1/sessions"))
      .rejects.toThrow("response exceeds 8 MiB");
  });

  it("reconstructs binary Runtime responses returned as base64 across IPC", async () => {
    invoke.mockResolvedValue({
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: "/9j/",
      bodyEncoding: "base64",
    });

    const response = await managedRuntimeFetch(
      "http://127.0.0.1:34100/api/v1/media-assets/asset-1/content",
    );

    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("returns promptly when the webview caller aborts", async () => {
    invoke.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = managedRuntimeFetch(
      "http://127.0.0.1:34100/api/v1/sessions",
      { signal: controller.signal },
    );

    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(new DOMException("screen closed", "AbortError"));
    await assertion;
  });
});
