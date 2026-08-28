import createClient from "openapi-fetch";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type { components, paths } from "@wa/runtime-contract";
import { createRuntimeHttpFetch } from "@/shared/api/runtime-http";
import { managedRuntimeFetch } from "@/shared/native/runtime-transport";

export type RuntimeSession = components["schemas"]["SessionDto"];
export type RuntimeSyncRun = components["schemas"]["SyncRunDto"];
export type RuntimeGroup = components["schemas"]["GroupDto"];
export type RuntimeGroupDetail = components["schemas"]["GroupDetailDto"];
export type RuntimeGroupPage = components["schemas"]["GroupListDto"];
export type RuntimeGroupMember = components["schemas"]["GroupMemberDto"];
export type RuntimeGroupMemberPage = components["schemas"]["GroupMemberListDto"];
// Runtime retains legacy schema identifiers; Studio exposes Group List terminology.
export type RuntimeGroupList = components["schemas"]["SavedGroupListDto"];
export type RuntimeGroupListPage = components["schemas"]["SavedGroupListPageDto"];
export type RuntimeCreateGroupList = components["schemas"]["CreateGroupListDto"];
export type RuntimeUpdateGroupList = components["schemas"]["UpdateGroupListDto"];
export type RuntimeGroupListGroup = components["schemas"]["GroupListGroupDto"];
export type RuntimeGroupListMembership = components["schemas"]["GroupListMembershipDto"];
export type RuntimeCampaign = components["schemas"]["CampaignDto"];
export type RuntimeCampaignContent = RuntimeCampaign["content"];
export type RuntimeCampaignPage = components["schemas"]["CampaignListDto"];
export type RuntimeCreateCampaign = components["schemas"]["CreateCampaignDto"];
export type RuntimeUpdateCampaign = components["schemas"]["UpdateCampaignDto"];
export type RuntimeCampaignTarget = components["schemas"]["CampaignTargetDto"];
export type RuntimeCampaignTargetList = components["schemas"]["CampaignTargetListDto"];
export type RuntimeCampaignTargetSource = components["schemas"]["CampaignTargetSourceDto"];
export type RuntimeCampaignPreflight = components["schemas"]["CampaignPreflightDto"];
export type RuntimeCampaignRun = components["schemas"]["CampaignRunDto"];
export type RuntimeCampaignRunPage = components["schemas"]["CampaignRunListDto"];
export type RuntimeCampaignRunSummary = components["schemas"]["CampaignRunSummaryDto"];
export type RuntimeCampaignRunSummaryPage = components["schemas"]["CampaignRunSummaryListDto"];
export type RuntimeCampaignDelivery = components["schemas"]["CampaignDeliveryDto"];
export type RuntimeCampaignDeliveryPage = components["schemas"]["CampaignDeliveryListDto"];
export type RuntimeCreateCampaignRun = components["schemas"]["CreateCampaignRunDto"];
export type RuntimeMediaAsset = components["schemas"]["MediaAssetDto"];
export type RuntimeMediaAssetPolicy = components["schemas"]["MediaAssetPolicyDto"];
export type RuntimeMediaUpload = components["schemas"]["MediaUploadDto"];
export type RuntimeCreateMediaUpload = components["schemas"]["CreateMediaUploadDto"];
export type RuntimeCampaignExecutionMode =
  components["schemas"]["CampaignPreflightRequestDto"]["executionMode"];
export type RuntimeError = components["schemas"]["RuntimeErrorDto"];
export type RuntimeActivityEvent = components["schemas"]["ActivityEventDto"];
export type RuntimeActivityPage = components["schemas"]["ActivityPageDto"];

type RuntimeGroupDirectoryQuery = paths["/api/v1/groups"]["get"]["parameters"]["query"];
type RuntimeCampaignListQuery = NonNullable<
  paths["/api/v1/campaigns"]["get"]["parameters"]["query"]
>;
type RuntimeRunListQuery = paths["/api/v1/campaign-runs"]["get"]["parameters"]["query"];
type RuntimeDeliveryListQuery = NonNullable<
  paths["/api/v1/campaign-runs/{id}/deliveries"]["get"]["parameters"]["query"]
>;
type RuntimeActivityListQuery = paths["/api/v1/activity"]["get"]["parameters"]["query"];
export type RuntimeGroupCapabilityStatus = NonNullable<
  RuntimeGroupDirectoryQuery["capabilityStatus"]
>[number];
export type RuntimeGroupCapabilityFreshness = NonNullable<
  RuntimeGroupDirectoryQuery["capabilityFreshness"]
>[number];
export type RuntimeCampaignStatus = NonNullable<
  RuntimeCampaignListQuery["status"]
>[number];
export type RuntimeCampaignScheduleType = NonNullable<
  RuntimeCampaignListQuery["scheduleType"]
>[number];
export type RuntimeCampaignRunStatus = NonNullable<RuntimeRunListQuery["status"]>[number];
export type RuntimeCampaignDeliveryStatus = NonNullable<RuntimeDeliveryListQuery["status"]>[number];
export type RuntimeActivityCategory = NonNullable<RuntimeActivityListQuery["category"]>[number];
export type RuntimeActivitySeverity = NonNullable<RuntimeActivityListQuery["severity"]>[number];

export interface RuntimeGroupDirectoryInput {
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

export interface RuntimeGroupListsInput {
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

export interface RuntimeCampaignRunListInput {
  sessionId: string;
  limit?: number;
  offset?: number;
  query?: string;
  statuses?: RuntimeCampaignRunStatus[];
  executionModes?: RuntimeCampaignExecutionMode[];
  from?: string;
  to?: string;
}

export interface RuntimeCampaignDeliveryListInput {
  runId: string;
  limit?: number;
  offset?: number;
  query?: string;
  statuses?: RuntimeCampaignDeliveryStatus[];
}

export interface RuntimeActivityListInput {
  sessionId: string;
  limit?: number;
  query?: string;
  categories?: RuntimeActivityCategory[];
  severities?: RuntimeActivitySeverity[];
  from?: string;
  to?: string;
  cursor?: string;
}

export interface RuntimeConnectionInput {
  baseUrl: string;
  apiKey: string;
}

export interface RuntimeReadOptions {
  signal?: AbortSignal;
}

export interface NativeRuntimeConnection {
  baseUrl: string;
  transport: "native";
}

export type RuntimeConnectionProfile = RuntimeConnectionInput | NativeRuntimeConnection;

function isNativeRuntimeConnection(
  input: RuntimeConnectionProfile,
): input is NativeRuntimeConnection {
  return "transport" in input && input.transport === "native";
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
  if (url.username || url.password) {
    throw new RuntimeConnectionError("WA Runtime URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new RuntimeConnectionError("WA Runtime URL must not contain a query or fragment.");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (path && path !== "/api/v1") {
    throw new RuntimeConnectionError("WA Runtime URL must be an origin or end with /api/v1.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new RuntimeConnectionError("WA Runtime URL must use HTTPS outside localhost.");
  }
  return url.origin;
}

export function normalizeRuntimeConnection(
  input: RuntimeConnectionInput,
): RuntimeConnectionInput {
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 32 || apiKey.length > 4096) {
    throw new RuntimeConnectionError(
      "WA Runtime API key must contain between 32 and 4096 characters.",
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(apiKey)) {
    throw new RuntimeConnectionError("WA Runtime API key must not contain control characters.");
  }
  return { baseUrl: normalizeRuntimeBaseUrl(input.baseUrl), apiKey };
}

export function normalizeRuntimeProfile(
  input: RuntimeConnectionProfile,
): RuntimeConnectionProfile {
  if (isNativeRuntimeConnection(input)) {
    const baseUrl = normalizeRuntimeBaseUrl(input.baseUrl);
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:"
      || !["127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      throw new RuntimeConnectionError(
        "Managed WA Runtime native transport must target loopback HTTP.",
      );
    }
    return { baseUrl, transport: "native" };
  }
  return normalizeRuntimeConnection(input);
}

export class RuntimeApi {
  private readonly client;

  constructor(
    connection: RuntimeConnectionProfile,
    runtimeFetch?: typeof globalThis.fetch,
  ) {
    const normalized = normalizeRuntimeProfile(connection);
    const native = isNativeRuntimeConnection(normalized);
    const transport = runtimeFetch ?? (native ? managedRuntimeFetch : tauriFetch);
    this.client = createClient<paths>({
      baseUrl: normalized.baseUrl,
      fetch: createRuntimeHttpFetch(normalized.baseUrl, transport),
      ...(!isNativeRuntimeConnection(normalized)
        ? { headers: { "X-Runtime-Key": normalized.apiKey } }
        : {}),
    });
  }

  async assertReady(options: RuntimeReadOptions = {}): Promise<void> {
    const result = await this.client.GET("/api/v1/health/ready", { ...options });
    if (!result.response.ok) {
      throw new RuntimeConnectionError(
        `WA Runtime is not ready (HTTP ${result.response.status}).`,
      );
    }
  }

  async listSessions(options: RuntimeReadOptions = {}): Promise<RuntimeSession[]> {
    const result = await this.client.GET("/api/v1/sessions", { ...options });
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

  async getSessionSyncRun(
    sessionId: string,
    runId: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeSyncRun> {
    const result = await this.client.GET("/api/v1/sessions/{id}/sync-runs/{runId}", {
      ...options,
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
  }: RuntimeGroupDirectoryInput, options: RuntimeReadOptions = {}): Promise<RuntimeGroupPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/groups", {
      ...options,
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

  async getGroup(
    sessionId: string,
    groupId: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeGroupDetail> {
    const result = await this.client.GET("/api/v1/groups/{id}", {
      ...options,
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
  }: RuntimeGroupMemberListInput, options: RuntimeReadOptions = {}): Promise<RuntimeGroupMemberPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/groups/{id}/members", {
      ...options,
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

  async listGroupLists({
    sessionId,
    limit = 20,
    offset = 0,
    query,
  }: RuntimeGroupListsInput, options: RuntimeReadOptions = {}): Promise<RuntimeGroupListPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/group-lists", {
      ...options,
      params: { query: {
        sessionId,
        limit,
        offset,
        ...(normalizedQuery ? { query: normalizedQuery } : {}),
      } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load group lists",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async createGroupList(
    input: RuntimeCreateGroupList,
    idempotencyKey: string,
  ): Promise<RuntimeGroupList> {
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

  async getGroupList(
    listId: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeGroupList> {
    const result = await this.client.GET("/api/v1/group-lists/{id}", {
      ...options,
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

  async getGroupListMembership(
    listId: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeGroupListMembership> {
    const result = await this.client.GET("/api/v1/group-lists/{id}/groups", {
      ...options,
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
  ): Promise<RuntimeGroupList> {
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
    expectedMembershipRevision?: number,
  ): Promise<RuntimeGroupListMembership> {
    const result = await this.client.PUT("/api/v1/group-lists/{id}/groups", {
      body: {
        groupIds,
        ...(expectedMembershipRevision === undefined ? {} : { expectedMembershipRevision }),
      },
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

  async archiveGroupList(listId: string, expectedRevision: number): Promise<void> {
    const result = await this.client.DELETE("/api/v1/group-lists/{id}", {
      params: {
        path: { id: listId },
        query: { expectedRevision },
      },
    });
    if (!result.response.ok) {
      throw runtimeRequestError(
        "Could not archive group list",
        result.response.status,
        result.error,
      );
    }
  }

  async getCampaignMediaPolicy(
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeMediaAssetPolicy> {
    const result = await this.client.GET("/api/v1/media-assets/policy", { ...options });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load campaign media policy",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async createCampaignMediaUpload(
    input: RuntimeCreateMediaUpload,
    idempotencyKey: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeMediaUpload> {
    const result = await this.client.POST("/api/v1/media-assets/uploads", {
      ...options,
      body: input,
      params: { header: { "Idempotency-Key": idempotencyKey } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not create campaign media upload",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async getCampaignMediaUpload(
    uploadId: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeMediaUpload> {
    const result = await this.client.GET("/api/v1/media-assets/uploads/{id}", {
      ...options,
      params: { path: { id: uploadId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load campaign media upload",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async putCampaignMediaChunk(
    uploadId: string,
    index: number,
    data: string,
    options: RuntimeReadOptions = {},
  ): Promise<void> {
    const result = await this.client.PUT("/api/v1/media-assets/uploads/{id}/chunks/{index}", {
      ...options,
      body: { data },
      params: { path: { id: uploadId, index } },
    });
    if (!result.response.ok) {
      throw runtimeRequestError(
        `Could not upload campaign media chunk ${index + 1}`,
        result.response.status,
        result.error,
      );
    }
  }

  async completeCampaignMediaUpload(
    uploadId: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeMediaAsset> {
    const result = await this.client.POST("/api/v1/media-assets/uploads/{id}/complete", {
      ...options,
      params: { path: { id: uploadId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not complete campaign media upload",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async cancelCampaignMediaUpload(
    uploadId: string,
    options: RuntimeReadOptions = {},
  ): Promise<void> {
    const result = await this.client.DELETE("/api/v1/media-assets/uploads/{id}", {
      ...options,
      params: { path: { id: uploadId } },
    });
    if (!result.response.ok) {
      throw runtimeRequestError(
        "Could not cancel campaign media upload",
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
  }: RuntimeCampaignListInput, options: RuntimeReadOptions = {}): Promise<RuntimeCampaignPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/campaigns", {
      ...options,
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

  async getCampaign(
    campaignId: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeCampaign> {
    const result = await this.client.GET("/api/v1/campaigns/{id}", {
      ...options,
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

  async deleteCampaign(
    campaignId: string,
    expectedRevision: number,
    expectedTargetsRevision: number,
  ): Promise<void> {
    const result = await this.client.DELETE("/api/v1/campaigns/{id}", {
      params: {
        path: { id: campaignId },
        query: { expectedRevision, expectedTargetsRevision },
      },
    });
    if (!result.response.ok) {
      throw runtimeRequestError(
        "Could not delete campaign",
        result.response.status,
        result.error,
      );
    }
  }

  async listCampaignTargets(
    campaignId: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeCampaignTargetList> {
    const result = await this.client.GET("/api/v1/campaigns/{id}/targets", {
      ...options,
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
    expectedTargetsRevision?: number,
  ): Promise<RuntimeCampaignTargetList> {
    const result = await this.client.PUT("/api/v1/campaigns/{id}/targets", {
      body: {
        groupIds,
        ...(expectedTargetsRevision === undefined ? {} : { expectedTargetsRevision }),
      },
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

  async applyGroupListToCampaignTargets(
    campaignId: string,
    input: components["schemas"]["ApplyGroupListTargetsDto"],
  ): Promise<RuntimeCampaignTargetList> {
    const result = await this.client.POST(
      "/api/v1/campaigns/{id}/targets/apply-group-list",
      { body: input, params: { path: { id: campaignId } } },
    );
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not apply group list to campaign targets",
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

  async listCampaignRuns(
    campaignId: string,
    limit = 20,
    offset = 0,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeCampaignRunPage> {
    const result = await this.client.GET("/api/v1/campaigns/{id}/runs", {
      ...options,
      params: { path: { id: campaignId }, query: { limit, offset } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load campaign runs",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async listRuns({
    sessionId,
    limit = 50,
    offset = 0,
    query,
    statuses,
    executionModes,
    from,
    to,
  }: RuntimeCampaignRunListInput, options: RuntimeReadOptions = {}): Promise<RuntimeCampaignRunSummaryPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/campaign-runs", {
      ...options,
      params: { query: {
        sessionId,
        limit,
        offset,
        ...(normalizedQuery ? { query: normalizedQuery } : {}),
        ...(statuses?.length ? { status: statuses } : {}),
        ...(executionModes?.length ? { executionMode: executionModes } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      } },
      querySerializer: { array: { style: "form", explode: false } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load campaign runs",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async listCampaignDeliveries({
    runId,
    limit = 50,
    offset = 0,
    query,
    statuses,
  }: RuntimeCampaignDeliveryListInput, options: RuntimeReadOptions = {}): Promise<RuntimeCampaignDeliveryPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/campaign-runs/{id}/deliveries", {
      ...options,
      params: {
        path: { id: runId },
        query: {
          limit,
          offset,
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
          ...(statuses?.length ? { status: statuses } : {}),
        },
      },
      querySerializer: { array: { style: "form", explode: false } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load run deliveries",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async listActivity({
    sessionId,
    limit = 50,
    query,
    categories,
    severities,
    from,
    to,
    cursor,
  }: RuntimeActivityListInput, options: RuntimeReadOptions = {}): Promise<RuntimeActivityPage> {
    const normalizedQuery = query?.trim();
    const result = await this.client.GET("/api/v1/activity", {
      ...options,
      params: { query: {
        sessionId,
        limit,
        ...(normalizedQuery ? { query: normalizedQuery } : {}),
        ...(categories?.length ? { category: categories } : {}),
        ...(severities?.length ? { severity: severities } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(cursor ? { cursor } : {}),
      } },
      querySerializer: { array: { style: "form", explode: false } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load operational activity",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async createCampaignRun(
    campaignId: string,
    input: RuntimeCreateCampaignRun,
    idempotencyKey: string,
  ): Promise<RuntimeCampaignRun> {
    const result = await this.client.POST("/api/v1/campaigns/{id}/runs", {
      body: input,
      params: {
        header: { "Idempotency-Key": idempotencyKey },
        path: { id: campaignId },
      },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not create campaign run",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  async getCampaignRun(
    runId: string,
    options: RuntimeReadOptions = {},
  ): Promise<RuntimeCampaignRun> {
    const result = await this.client.GET("/api/v1/campaign-runs/{id}", {
      ...options,
      params: { path: { id: runId } },
    });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        "Could not load campaign run",
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  private async changeCampaignRunState(
    runId: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<RuntimeCampaignRun> {
    const path = action === "pause"
      ? "/api/v1/campaign-runs/{id}/pause" as const
      : action === "resume"
        ? "/api/v1/campaign-runs/{id}/resume" as const
        : "/api/v1/campaign-runs/{id}/cancel" as const;
    const result = await this.client.POST(path, { params: { path: { id: runId } } });
    if (!result.response.ok || !result.data) {
      throw runtimeRequestError(
        `Could not ${action} campaign run`,
        result.response.status,
        result.error,
      );
    }
    return result.data;
  }

  pauseCampaignRun(runId: string): Promise<RuntimeCampaignRun> {
    return this.changeCampaignRunState(runId, "pause");
  }

  resumeCampaignRun(runId: string): Promise<RuntimeCampaignRun> {
    return this.changeCampaignRunState(runId, "resume");
  }

  cancelCampaignRun(runId: string): Promise<RuntimeCampaignRun> {
    return this.changeCampaignRunState(runId, "cancel");
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname.toLowerCase());
}

export async function probeRuntimeConnection(
  input: RuntimeConnectionProfile,
  runtimeFetch?: typeof globalThis.fetch,
  options: RuntimeReadOptions = {},
): Promise<RuntimeConnectionResult> {
  const api = new RuntimeApi(input, runtimeFetch);
  await api.assertReady(options);
  const sessions = await api.listSessions(options);

  return {
    sessionCount: sessions.length,
    readySessions: sessions.filter((session) => session.status === "ready").length,
    sessions,
  };
}
