import createClient from "openapi-fetch";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type { components, paths } from "./generated/runtime";

export type RuntimeSession = components["schemas"]["SessionDto"];
export type RuntimeSyncRun = components["schemas"]["SyncRunDto"];
export type RuntimeGroup = components["schemas"]["GroupDto"];
export type RuntimeGroupDetail = components["schemas"]["GroupDetailDto"];
export type RuntimeGroupPage = components["schemas"]["GroupListDto"];
export type RuntimeGroupMember = components["schemas"]["GroupMemberDto"];
export type RuntimeGroupMemberPage = components["schemas"]["GroupMemberListDto"];

type RuntimeGroupListQuery = paths["/api/v1/groups"]["get"]["parameters"]["query"];
export type RuntimeGroupCapabilityStatus = NonNullable<
  RuntimeGroupListQuery["capabilityStatus"]
>[number];
export type RuntimeGroupCapabilityFreshness = NonNullable<
  RuntimeGroupListQuery["capabilityFreshness"]
>[number];

export interface RuntimeGroupListInput {
  sessionId: string;
  limit?: number;
  offset?: number;
  query?: string;
  capabilityStatus?: RuntimeGroupCapabilityStatus[];
  capabilityFreshness?: RuntimeGroupCapabilityFreshness[];
  isActive?: boolean;
}

export interface RuntimeGroupMemberListInput {
  sessionId: string;
  groupId: string;
  limit?: number;
  offset?: number;
  query?: string;
}

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
  if (!candidate) throw new RuntimeConnectionError("WA Runtime URL is required.");

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new RuntimeConnectionError("WA Runtime URL must be a valid http(s) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeConnectionError("WA Runtime URL must use http or https.");
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
  if (!apiKey) throw new RuntimeConnectionError("WA Runtime API key is required.");
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
        `WA Runtime is not ready (HTTP ${result.response.status}).`,
      );
    }
  }

  async listSessions(): Promise<RuntimeSession[]> {
    const result = await this.client.GET("/api/v1/sessions");
    if (!result.response.ok || !result.data) {
      const message =
        result.response.status === 401
          ? "WA Runtime API key was rejected."
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

  async listGroups({
    sessionId,
    limit = 25,
    offset = 0,
    query,
    capabilityStatus,
    capabilityFreshness,
    isActive,
  }: RuntimeGroupListInput): Promise<RuntimeGroupPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/groups", {
      params: {
        query: {
          sessionId,
          limit,
          offset,
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
          ...(capabilityStatus?.length ? { capabilityStatus } : {}),
          ...(capabilityFreshness?.length ? { capabilityFreshness } : {}),
          ...(isActive === undefined ? {} : { isActive }),
        },
      },
      querySerializer: { array: { style: "form", explode: false } },
    });
    if (!result.response.ok || !result.data) {
      throw new RuntimeRequestError(
        `Could not load groups (HTTP ${result.response.status}).`,
      );
    }
    return result.data;
  }

  async getGroup(sessionId: string, groupId: string): Promise<RuntimeGroupDetail> {
    const result = await this.client.GET("/api/v1/groups/{id}", {
      params: { path: { id: groupId }, query: { sessionId } },
    });
    if (!result.response.ok || !result.data) {
      throw new RuntimeRequestError(
        `Could not load group details (HTTP ${result.response.status}).`,
      );
    }
    return result.data;
  }

  async listGroupMembers({
    sessionId,
    groupId,
    limit = 50,
    offset = 0,
    query,
  }: RuntimeGroupMemberListInput): Promise<RuntimeGroupMemberPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/groups/{id}/members", {
      params: {
        path: { id: groupId },
        query: {
          sessionId,
          limit,
          offset,
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
        },
      },
    });
    if (!result.response.ok || !result.data) {
      throw new RuntimeRequestError(
        `Could not load group members (HTTP ${result.response.status}).`,
      );
    }
    return result.data;
  }

  async requestGroupCapabilityRefresh(
    sessionId: string,
    groupId: string,
  ): Promise<void> {
    const result = await this.client.POST("/api/v1/groups/{id}/refresh-capability", {
      params: { path: { id: groupId }, query: { sessionId } },
    });
    if (!result.response.ok) {
      throw new RuntimeRequestError(
        `Could not refresh send capability (HTTP ${result.response.status}).`,
      );
    }
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
