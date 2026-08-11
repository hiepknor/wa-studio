import createClient from "openapi-fetch";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type { paths } from "./generated/runtime";

export interface RuntimeConnectionInput {
  baseUrl: string;
  apiKey: string;
}

export interface RuntimeConnectionResult {
  sessionCount: number;
  readySessions: number;
}

export class RuntimeConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConnectionError";
  }
}

export function normalizeRuntimeBaseUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new RuntimeConnectionError("Runtime URL is required.");

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new RuntimeConnectionError("Runtime URL must be a valid http(s) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeConnectionError("Runtime URL must use http or https.");
  }

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/?api\/v1\/?$/, "").replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export async function probeRuntimeConnection(
  input: RuntimeConnectionInput,
  runtimeFetch: typeof globalThis.fetch = tauriFetch,
): Promise<RuntimeConnectionResult> {
  const baseUrl = normalizeRuntimeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new RuntimeConnectionError("Runtime API key is required.");

  const client = createClient<paths>({
    baseUrl,
    fetch: runtimeFetch,
    headers: { "X-Runtime-Key": apiKey },
  });

  const readiness = await client.GET("/api/v1/health/ready");
  if (!readiness.response.ok) {
    throw new RuntimeConnectionError(
      `Runtime is not ready (HTTP ${readiness.response.status}).`,
    );
  }

  const sessions = await client.GET("/api/v1/sessions");
  if (!sessions.response.ok || !sessions.data) {
    const message =
      sessions.response.status === 401
        ? "Runtime API key was rejected."
        : `Could not load sessions (HTTP ${sessions.response.status}).`;
    throw new RuntimeConnectionError(message);
  }

  return {
    sessionCount: sessions.data.data.length,
    readySessions: sessions.data.data.filter((session) => session.status === "ready").length,
  };
}
