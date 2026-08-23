import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { managedRuntimeFetch } from "./runtime-transport";

describe("managed Runtime native transport", () => {
  beforeEach(() => invoke.mockReset());

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
});
