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
export type RuntimeSavedGroupList = components["schemas"]["SavedGroupListDto"];
export type RuntimeSavedGroupListPage = components["schemas"]["SavedGroupListPageDto"];
export type RuntimeCreateGroupList = components["schemas"]["CreateGroupListDto"];
export type RuntimeUpdateGroupList = components["schemas"]["UpdateGroupListDto"];
export type RuntimeGroupListGroup = components["schemas"]["GroupListGroupDto"];
export type RuntimeGroupListMembership = components["schemas"]["GroupListMembershipDto"];
export type RuntimeCampaign = components["schemas"]["CampaignDto"];
export type RuntimeCampaignPage = components["schemas"]["CampaignListDto"];
export type RuntimeCreateCampaign = components["schemas"]["CreateCampaignDto"];
export type RuntimeUpdateCampaign = components["schemas"]["UpdateCampaignDto"];
export type RuntimeCampaignTarget = components["schemas"]["CampaignTargetDto"];
export type RuntimeCampaignTargetList = components["schemas"]["CampaignTargetListDto"];
export type RuntimeCampaignPreflight = components["schemas"]["CampaignPreflightDto"];
export type RuntimeCampaignExecutionMode =
  components["schemas"]["CampaignPreflightRequestDto"]["executionMode"];
export type RuntimeError = components["schemas"]["RuntimeErrorDto"];

type RuntimeGroupListQuery = paths["/api/v1/groups"]["get"]["parameters"]["query"];
type RuntimeCampaignListQuery = NonNullable<
  paths["/api/v1/campaigns"]["get"]["parameters"]["query"]
>;
export type RuntimeGroupCapabilityStatus = NonNullable<
  RuntimeGroupListQuery["capabilityStatus"]
>[number];
export type RuntimeGroupCapabilityFreshness = NonNullable<
  RuntimeGroupListQuery["capabilityFreshness"]
>[number];
export type RuntimeCampaignStatus = NonNullable<
  RuntimeCampaignListQuery["status"]
>[number];
export type RuntimeCampaignScheduleType = NonNullable<
  RuntimeCampaignListQuery["scheduleType"]
>[number];

export interface RuntimeGroupListInput {
  sessionId: string;
  limit?: number;
  offset?: number;
  query?: string;
  capabilityStatus?: RuntimeGroupCapabilityStatus[];
  capabilityFreshness?: RuntimeGroupCapabilityFreshness[];
  isActive?: boolean;
  minParticipants?: number;
  maxParticipants?: number;
}

export interface RuntimeGroupMemberListInput {
  sessionId: string;
  groupId: string;
  limit?: number;
  offset?: number;
  query?: string;
}

export interface RuntimeSavedGroupListInput {
  sessionId: string;
  limit?: number;
  offset?: number;
  query?: string;
}

export interface RuntimeCampaignListInput {
  sessionId: string;
  limit?: number;
  offset?: number;
  query?: string;
  statuses?: RuntimeCampaignStatus[];
  scheduleTypes?: RuntimeCampaignScheduleType[];
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
  readonly code: string | null;
  readonly details: Record<string, unknown>;
  readonly fieldErrors: Record<string, string[]>;
  readonly status: number;

  constructor(
    message: string,
    options: {
      code?: string;
      details?: Record<string, unknown>;
      fieldErrors?: Record<string, string[]>;
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = "RuntimeRequestError";
    this.code = options.code ?? null;
    this.details = options.details ?? {};
    this.fieldErrors = options.fieldErrors ?? {};
    this.status = options.status ?? 0;
  }
}

function isRuntimeError(value: unknown): value is RuntimeError {
  return Boolean(
    value
    && typeof value === "object"
    && "code" in value
    && typeof value.code === "string"
    && "message" in value
    && typeof value.message === "string",
  );
}

function runtimeRequestError(
  fallback: string,
  status: number,
  value: unknown,
): RuntimeRequestError {
  if (!isRuntimeError(value)) {
    return new RuntimeRequestError(`${fallback} (HTTP ${status}).`, { status });
  }
  return new RuntimeRequestError(value.message, {
    code: value.code,
    details: value.details,
    fieldErrors: value.fieldErrors,
    status,
  });
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
    minParticipants,
    maxParticipants,
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
          ...(minParticipants === undefined ? {} : { minParticipants }),
          ...(maxParticipants === undefined ? {} : { maxParticipants }),
        },
      },
      querySerializer: { array: { style: "form", explode: false } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load groups",
        result.response.status,
        result.error,
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

  async listSavedGroupLists({
    sessionId,
    limit = 20,
    offset = 0,
    query,
  }: RuntimeSavedGroupListInput): Promise<RuntimeSavedGroupListPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/group-lists", {
      params: { query: {
        sessionId,
        limit,
        offset,
        ...(normalizedQuery ? { query: normalizedQuery } : {}),
      } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load saved group lists",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async createGroupList(
    input: RuntimeCreateGroupList,
    idempotencyKey: string,
  ): Promise<RuntimeSavedGroupList> {
    const result = await this.client.POST("/api/v1/group-lists", {
      body: input,
      params: { header: { "Idempotency-Key": idempotencyKey } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not create group list",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async getGroupList(listId: string): Promise<RuntimeSavedGroupList> {
    const result = await this.client.GET("/api/v1/group-lists/{id}", {
      params: { path: { id: listId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load group list",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async getGroupListMembership(listId: string): Promise<RuntimeGroupListMembership> {
    const result = await this.client.GET("/api/v1/group-lists/{id}/groups", {
      params: { path: { id: listId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load group list membership",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async updateGroupList(
    listId: string,
    input: RuntimeUpdateGroupList,
  ): Promise<RuntimeSavedGroupList> {
    const result = await this.client.PATCH("/api/v1/group-lists/{id}", {
      body: input,
      params: { path: { id: listId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not update group list",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async replaceGroupListGroups(
    listId: string,
    groupIds: string[],
  ): Promise<RuntimeGroupListMembership> {
    const result = await this.client.PUT("/api/v1/group-lists/{id}/groups", {
      body: { groupIds },
      params: { path: { id: listId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not replace group list membership",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async archiveGroupList(listId: string): Promise<void> {
    const result = await this.client.DELETE("/api/v1/group-lists/{id}", {
      params: { path: { id: listId } },
    });
    if (!result.response.ok) {
      throw runtimeRequestError(
        "Could not archive group list",
        result.response.status,
        result.error,
      );
    }
  }

  async listCampaigns({
    sessionId,
    limit = 50,
    offset = 0,
    query,
    statuses,
    scheduleTypes,
  }: RuntimeCampaignListInput): Promise<RuntimeCampaignPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/campaigns", {
      params: { query: {
        sessionId,
        limit,
        offset,
        ...(normalizedQuery ? { query: normalizedQuery } : {}),
        ...(statuses?.length ? { status: statuses } : {}),
        ...(scheduleTypes?.length ? { scheduleType: scheduleTypes } : {}),
      } },
      querySerializer: { array: { style: "form", explode: false } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load campaigns",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async getCampaign(campaignId: string): Promise<RuntimeCampaign> {
    const result = await this.client.GET("/api/v1/campaigns/{id}", {
      params: { path: { id: campaignId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load campaign",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async createCampaign(
    input: RuntimeCreateCampaign,
    idempotencyKey: string,
  ): Promise<RuntimeCampaign> {
    // The v0.2.0 scheduling semantics require the canonical IMMEDIATE value on
    // the wire even though CreateCampaignDto models scheduledAt as optional.
    const body = input.scheduleType === "IMMEDIATE"
      ? { ...input, scheduledAt: null }
      : input;
    const result = await this.client.POST("/api/v1/campaigns", {
      body: body as RuntimeCreateCampaign,
      params: { header: { "Idempotency-Key": idempotencyKey } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not create campaign",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async updateCampaign(
    campaignId: string,
    input: RuntimeUpdateCampaign,
  ): Promise<RuntimeCampaign> {
    const result = await this.client.PATCH("/api/v1/campaigns/{id}", {
      body: input,
      params: { path: { id: campaignId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not update campaign",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async listCampaignTargets(campaignId: string): Promise<RuntimeCampaignTargetList> {
    const result = await this.client.GET("/api/v1/campaigns/{id}/targets", {
      params: { path: { id: campaignId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load campaign targets",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async replaceCampaignTargets(
    campaignId: string,
    groupIds: string[],
  ): Promise<RuntimeCampaignTargetList> {
    const result = await this.client.PUT("/api/v1/campaigns/{id}/targets", {
      body: { groupIds },
      params: { path: { id: campaignId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not replace campaign targets",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async preflightCampaign(
    campaignId: string,
    executionMode: RuntimeCampaignExecutionMode,
  ): Promise<RuntimeCampaignPreflight> {
    const result = await this.client.POST("/api/v1/campaigns/{id}/preflight", {
      body: { executionMode },
      params: { path: { id: campaignId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not run campaign preflight",
        result.response.status,
        result.error,
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
