import createClient from "openapi-fetch";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type { components, paths } from "./generated/runtime";

export type RuntimeSession = components["schemas"]["SessionDto"];
export type RuntimeSyncRun = components["schemas"]["SyncRunDto"];

export interface RuntimeConnectionInput {
  baseUrl: string;
  apiKey: string;
}

export interface RuntimeConnectionResult {
  sessionCount: number;
  readySessions: number;
  sessions: RuntimeSession[];
}

export class RuntimeConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConnectionError";
  }
}

export class RuntimeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeRequestError";
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

export function normalizeRuntimeConnection(
  input: RuntimeConnectionInput,
): RuntimeConnectionInput {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new RuntimeConnectionError("Runtime API key is required.");
  return { baseUrl: normalizeRuntimeBaseUrl(input.baseUrl), apiKey };
}

export class RuntimeApi {
  private readonly client;

  constructor(
    connection: RuntimeConnectionInput,
    runtimeFetch: typeof globalThis.fetch = tauriFetch,
  ) {
    const normalized = normalizeRuntimeConnection(connection);
    this.client = createClient<paths>({
      baseUrl: normalized.baseUrl,
      fetch: runtimeFetch,
      headers: { "X-Runtime-Key": normalized.apiKey },
    });
  }

  async assertReady(): Promise<void> {
    const result = await this.client.GET("/api/v1/health/ready");
    if (!result.response.ok) {
      throw new RuntimeConnectionError(
        `Runtime is not ready (HTTP ${result.response.status}).`,
      );
    }
  }

  async listSessions(): Promise<RuntimeSession[]> {
    const result = await this.client.GET("/api/v1/sessions");
    if (!result.response.ok || !result.data) {
      const message =
        result.response.status === 401
          ? "Runtime API key was rejected."
          : `Could not load sessions (HTTP ${result.response.status}).`;
      throw new RuntimeRequestError(message);
    }
    return result.data.data;
  }

  async requestSessionSync(sessionId: string): Promise<RuntimeSyncRun> {
    const result = await this.client.POST("/api/v1/sessions/{id}/sync", {
      params: { path: { id: sessionId } },
    });
    if (!result.response.ok || !result.data) {
      throw new RuntimeRequestError(
        `Could not start session sync (HTTP ${result.response.status}).`,
      );
    }
    return result.data;
  }

  async getSessionSyncRun(sessionId: string, runId: string): Promise<RuntimeSyncRun> {
    const result = await this.client.GET("/api/v1/sessions/{id}/sync-runs/{runId}", {
      params: { path: { id: sessionId, runId } },
    });
    if (!result.response.ok || !result.data) {
      throw new RuntimeRequestError(
        `Could not read session sync (HTTP ${result.response.status}).`,
      );
    }
    return result.data;
  }
}

export async function probeRuntimeConnection(
  input: RuntimeConnectionInput,
  runtimeFetch: typeof globalThis.fetch = tauriFetch,
): Promise<RuntimeConnectionResult> {
  const api = new RuntimeApi(input, runtimeFetch);
  await api.assertReady();
  const sessions = await api.listSessions();

  return {
    sessionCount: sessions.length,
    readySessions: sessions.filter((session) => session.status === "ready").length,
    sessions,
  };
}
