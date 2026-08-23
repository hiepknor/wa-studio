import { describe, expect, it, vi } from "vitest";

import {
  normalizeRuntimeBaseUrl,
  probeRuntimeConnection,
  RuntimeApi,
  RuntimeConnectionError,
  RuntimeRequestError,
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
    ).rejects.toThrow("WA Runtime API key was rejected.");
  });
});

describe("RuntimeApi", () => {
  it("omits new campaign search/filter parameters by default", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [], meta: { total: 0, limit: 50, offset: 0 },
    }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );
    await api.listCampaigns({ sessionId: "session id" });
    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe("http://127.0.0.1:3100/api/v1/campaigns?sessionId=session%20id&limit=50&offset=0");
  });

  it("trims campaign search and serializes multi-value filters comma-separated", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [], meta: { total: 0, limit: 20, offset: 40 },
    }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );
    await api.listCampaigns({
      sessionId: "session-id",
      limit: 20,
      offset: 40,
      query: "  release_%\\  ",
      statuses: ["DRAFT", "PAUSED"],
      scheduleTypes: ["IMMEDIATE", "ONCE"],
    });
    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe("http://127.0.0.1:3100/api/v1/campaigns?sessionId=session-id&limit=20&offset=40&query=release_%25%5C&status=DRAFT,PAUSED&scheduleType=IMMEDIATE,ONCE");
  });

  it("omits whitespace campaign search and empty filters", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [], meta: { total: 0, limit: 50, offset: 0 },
    }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );
    await api.listCampaigns({
      sessionId: "session-id",
      query: "   ",
      statuses: [],
      scheduleTypes: [],
    });
    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.url).not.toContain("query=");
    expect(request.url).not.toContain("status=");
    expect(request.url).not.toContain("scheduleType=");
  });

  it("keeps the caller-owned Idempotency-Key stable across create retries and accepts HTTP 200 replay", async () => {
    const created = {
      id: "campaign-id",
      sessionId: "session-id",
      name: "Release",
      text: "Ship it",
      scheduleType: "IMMEDIATE",
      scheduledAt: null,
      status: "DRAFT",
      targetCount: 0,
      revision: 1,
      targetsRevision: 0,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    } as const;
    const runtimeFetch = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(Response.json(created, { status: 200 }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );
    const key = "37ce30a8-07e3-43b7-a499-1be2d40090a9";
    const payload = {
      sessionId: "session-id",
      name: "Release",
      text: "Ship it",
      scheduleType: "IMMEDIATE",
    } as const;

    await expect(api.createCampaign(payload, key)).rejects.toThrow("response lost");
    await expect(api.createCampaign(payload, key)).resolves.toEqual(created);
    expect(runtimeFetch).toHaveBeenCalledTimes(2);
    for (const call of runtimeFetch.mock.calls) {
      const request = call[0] as Request;
      expect(request.headers.get("Idempotency-Key")).toBe(key);
      expect(request.method).toBe("POST");
      await expect(request.clone().json()).resolves.toMatchObject({
        scheduleType: "IMMEDIATE",
        scheduledAt: null,
      });
    }
  });

  it("preserves typed campaign conflicts", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code: "CAMPAIGN_IDEMPOTENCY_CONFLICT",
      message: "same key, different payload",
      fieldErrors: { name: ["different"] },
      details: { campaignId: "existing" },
    }, { status: 409 }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    const error = await api.createCampaign({
      sessionId: "session-id",
      name: "Release",
      text: "Ship it",
      scheduleType: "IMMEDIATE",
    }, "same-key").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RuntimeRequestError);
    expect(error).toMatchObject({
      code: "CAMPAIGN_IDEMPOTENCY_CONFLICT",
      status: 409,
      fieldErrors: { name: ["different"] },
      details: { campaignId: "existing" },
    });
  });

  it("deletes a campaign with both displayed revisions", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    await expect(api.deleteCampaign("campaign id", 7, 11)).resolves.toBeUndefined();

    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe(
      "http://127.0.0.1:3100/api/v1/campaigns/campaign%20id?expectedRevision=7&expectedTargetsRevision=11",
    );
  });

  it("uses revision-safe target apply and campaign run lifecycle endpoints", async () => {
    const campaign = {
      id: "campaign-id", sessionId: "session-id", name: "Release", text: "Ship it",
      scheduleType: "IMMEDIATE", scheduledAt: null, status: "DRAFT", targetCount: 1,
      revision: 1, targetsRevision: 2, createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    } as const;
    const target = {
      groupId: "group@g.us", groupName: "Group", enabled: false,
      sendCapability: { status: "UNKNOWN", reason: "not_checked", checkedAt: null, invalidatedAt: null, revision: 0 },
    } as const;
    const report = {
      status: "WARN", policyVersion: 2, campaignRevision: 1, targetsRevision: 2,
      executionMode: "LIVE", checkedAt: "2026-08-14T00:00:00.000Z", totalTargets: 1,
      liveLaunchToken: "clp1.test-payload.test-signature-with-sufficient-length",
      liveLaunchTokenExpiresAt: "2026-08-14T00:02:00.000Z",
      allowedTargets: 0, deniedTargets: 0, unknownTargets: 1, checks: [], targetIssues: [],
    } as const;
    const source = {
      type: "GROUP_LIST", groupListId: "11111111-1111-4111-8111-111111111111",
      groupListNameSnapshot: "Launch groups",
      membershipRevision: 5, appliedAt: "2026-08-14T00:00:00.000Z",
    } as const;
    const run = {
      id: "run-id", campaignId: campaign.id, sessionId: campaign.sessionId,
      executionMode: "LIVE", status: "RUNNING", statusReason: null, text: campaign.text,
      targetSource: source, preflight: report, totalTargets: 1,
      progress: { total: 1, pending: 0, materialized: 0, processing: 1, dryRunCompleted: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, unknown: 0, blocked: 0, cancelled: 0 },
      scheduledAt: "2026-08-14T00:00:00.000Z", startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: null, createdAt: "2026-08-14T00:00:00.000Z",
    } as const;
    const runtimeFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [target], targetsRevision: 2, source }))
      .mockResolvedValueOnce(Response.json({ data: [target], targetsRevision: 3, source: null }))
      .mockResolvedValueOnce(Response.json({ data: [target], targetsRevision: 4, source }))
      .mockResolvedValueOnce(Response.json(report))
      .mockResolvedValueOnce(Response.json({ data: [run], meta: { total: 1, limit: 20, offset: 0 } }))
      .mockResolvedValueOnce(Response.json(run, { status: 201 }))
      .mockResolvedValueOnce(Response.json(run))
      .mockResolvedValueOnce(Response.json({ ...run, status: "PAUSED" }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    await api.listCampaignTargets(campaign.id);
    await api.replaceCampaignTargets(campaign.id, [target.groupId], 2);
    await api.applyGroupListToCampaignTargets(campaign.id, {
      groupListId: source.groupListId,
      expectedMembershipRevision: 5,
      expectedTargetsRevision: 3,
    });
    await api.preflightCampaign(campaign.id, "LIVE");
    await api.listCampaignRuns(campaign.id);
    await api.createCampaignRun(campaign.id, {
      executionMode: "LIVE",
      expectedCampaignRevision: 1,
      expectedTargetsRevision: 4,
      preflightToken: report.liveLaunchToken,
    }, "launch-key");
    await api.getCampaignRun(run.id);
    await api.pauseCampaignRun(run.id);

    const requests = runtimeFetch.mock.calls.map((call) => call[0] as Request);
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/api/v1/campaigns/campaign-id/targets"],
      ["PUT", "/api/v1/campaigns/campaign-id/targets"],
      ["POST", "/api/v1/campaigns/campaign-id/targets/apply-group-list"],
      ["POST", "/api/v1/campaigns/campaign-id/preflight"],
      ["GET", "/api/v1/campaigns/campaign-id/runs"],
      ["POST", "/api/v1/campaigns/campaign-id/runs"],
      ["GET", "/api/v1/campaign-runs/run-id"],
      ["POST", "/api/v1/campaign-runs/run-id/pause"],
    ]);
    await expect(requests[1].clone().json()).resolves.toEqual({
      groupIds: [target.groupId], expectedTargetsRevision: 2,
    });
    await expect(requests[2].clone().json()).resolves.toEqual({
      groupListId: source.groupListId,
      expectedMembershipRevision: 5,
      expectedTargetsRevision: 3,
    });
    expect(requests[5].headers.get("Idempotency-Key")).toBe("launch-key");
    await expect(requests[5].clone().json()).resolves.toEqual({
      executionMode: "LIVE", expectedCampaignRevision: 1, expectedTargetsRevision: 4,
      preflightToken: report.liveLaunchToken,
    });
    expect(requests.some((request) => request.url.includes("message"))).toBe(false);
  });

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

  it("reads paginated groups and group details for a session", async () => {
    const group = {
      sessionId: "session id",
      id: "120363@g.us",
      name: "Release room",
      description: null,
      ownerId: null,
      linkedParentId: null,
      participantsCount: 3,
      isAdmin: true,
      isReadOnly: false,
      isAnnounce: false,
      settingsLocked: false,
      isActive: true,
      detailsSyncedAt: null,
      syncedAt: "2026-08-11T09:00:00.000Z",
      sendCapability: {
        status: "ALLOWED",
        reason: "session_is_admin",
        checkedAt: "2026-08-11T09:00:00.000Z",
        invalidatedAt: null,
        revision: 1,
      },
    } as const;
    const runtimeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [group], meta: { total: 1, limit: 20, offset: 20 } }))
      .mockResolvedValueOnce(Response.json(group))
      .mockResolvedValueOnce(Response.json({
        data: [],
        meta: { total: 0, limit: 25, offset: 50, datasetRevision: 0 },
      }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    await expect(api.listGroups({ sessionId: "session id", limit: 20, offset: 20 }))
      .resolves.toMatchObject({ meta: { total: 1, limit: 20, offset: 20 } });
    await expect(api.getGroup("session id", "120363@g.us"))
      .resolves.toMatchObject({ name: "Release room" });
    await expect(api.listGroupMembers({
      sessionId: "session id",
      groupId: "120363@g.us",
      limit: 25,
      offset: 50,
      query: "  Hiep Mai  ",
    })).resolves.toMatchObject({ meta: { total: 0, limit: 25, offset: 50 } });

    const listRequest = runtimeFetch.mock.calls[0][0] as Request;
    expect(listRequest.url).toBe(
      "http://127.0.0.1:3100/api/v1/groups?sessionId=session%20id&limit=20&offset=20",
    );
    expect(listRequest.headers.get("X-Runtime-Key")).toBe("test-key");
    const detailRequest = runtimeFetch.mock.calls[1][0] as Request;
    expect(detailRequest.url).toBe(
      "http://127.0.0.1:3100/api/v1/groups/120363%40g.us?sessionId=session%20id",
    );
    const membersRequest = runtimeFetch.mock.calls[2][0] as Request;
    expect(membersRequest.url).toBe(
      "http://127.0.0.1:3100/api/v1/groups/120363%40g.us/members?sessionId=session%20id&limit=25&offset=50&query=Hiep%20Mai",
    );
  });

  it("omits an empty member search query", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [],
      meta: { total: 0, limit: 50, offset: 0, datasetRevision: 0 },
    }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    await api.listGroupMembers({
      sessionId: "session id",
      groupId: "120363@g.us",
      query: "   ",
    });

    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe(
      "http://127.0.0.1:3100/api/v1/groups/120363%40g.us/members?sessionId=session%20id&limit=50&offset=0",
    );
  });

  it("serializes global group search and filters using the Runtime contract", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [],
      meta: { total: 0, limit: 20, offset: 0 },
    }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    await api.listGroups({
      sessionId: "session id",
      limit: 20,
      offset: 0,
      query: "  release room  ",
      capabilityStatus: ["DENIED", "UNKNOWN"],
      capabilityFreshness: ["CURRENT", "STALE"],
      isActive: false,
      minParticipants: 50,
      maxParticipants: 500,
    });

    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe(
      "http://127.0.0.1:3100/api/v1/groups?sessionId=session%20id&limit=20&offset=0&query=release%20room&capabilityStatus=DENIED,UNKNOWN&capabilityFreshness=CURRENT,STALE&isActive=false&minParticipants=50&maxParticipants=500",
    );
  });

  it("omits empty group search and filter values", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [],
      meta: { total: 0, limit: 25, offset: 0 },
    }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    await api.listGroups({
      sessionId: "session id",
      query: "   ",
      capabilityStatus: [],
      capabilityFreshness: [],
      minParticipants: undefined,
      maxParticipants: undefined,
    });

    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe(
      "http://127.0.0.1:3100/api/v1/groups?sessionId=session%20id&limit=25&offset=0",
    );
  });

  it.each([400, 401, 404])(
    "preserves HTTP %s when group-list validation or access fails",
    async (status) => {
      const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, { status }),
      );
      const api = new RuntimeApi(
        { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
        runtimeFetch,
      );

      await expect(api.listGroups({ sessionId: "session id" }))
        .rejects.toThrow(`Could not load groups (HTTP ${status}).`);
    },
  );

  it("preserves typed participant-filter validation errors", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code: "GROUP_FILTER_PARTICIPANTS_RANGE_INVALID",
      message: "Invalid participant range.",
      fieldErrors: {
        minParticipants: ["Must not exceed maxParticipants."],
        maxParticipants: ["Must be at least minParticipants."],
      },
      details: {},
    }, { status: 400 }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    const error = await api.listGroups({
      sessionId: "session id",
      minParticipants: 500,
      maxParticipants: 50,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "GROUP_FILTER_PARTICIPANTS_RANGE_INVALID",
      status: 400,
      fieldErrors: {
        minParticipants: ["Must not exceed maxParticipants."],
        maxParticipants: ["Must be at least minParticipants."],
      },
    });
  });

  it.each([401, 404, 500])(
    "preserves member endpoint HTTP %s behavior in request errors",
    async (status) => {
      const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, { status }),
      );
      const api = new RuntimeApi(
        { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
        runtimeFetch,
      );

      await expect(api.listGroupMembers({
        sessionId: "out-of-scope-session",
        groupId: "missing@g.us",
      })).rejects.toThrow(`Could not load group members (HTTP ${status}).`);
    },
  );

  it("queues a group capability refresh", async () => {
    const runtimeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    await expect(api.requestGroupCapabilityRefresh("session id", "120363@g.us"))
      .resolves.toBeUndefined();

    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "http://127.0.0.1:3100/api/v1/groups/120363%40g.us/refresh-capability?sessionId=session%20id",
    );
  });

  it("trims Group List search and uses Runtime pagination", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [], meta: { total: 0, limit: 20, offset: 40 },
    }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );
    await api.listGroupLists({
      sessionId: "session id",
      limit: 20,
      offset: 40,
      query: "  launch list  ",
    });
    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe("http://127.0.0.1:3100/api/v1/group-lists?sessionId=session%20id&limit=20&offset=40&query=launch%20list");
  });

  it("keeps the caller-owned Group List Idempotency-Key stable across replay", async () => {
    const saved = {
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-id",
      name: "Launch",
      description: null,
      groupCount: 0,
      revision: 1,
      membershipRevision: 0,
      archivedAt: null,
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const runtimeFetch = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(Response.json(saved, { status: 200 }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );
    const key = "22222222-2222-4222-8222-222222222222";
    const payload = { sessionId: "session-id", name: "Launch", groupIds: [] };
    await expect(api.createGroupList(payload, key)).rejects.toThrow("response lost");
    await expect(api.createGroupList(payload, key)).resolves.toEqual(saved);
    for (const call of runtimeFetch.mock.calls) {
      const request = call[0] as Request;
      expect(request.method).toBe("POST");
      expect(request.headers.get("Idempotency-Key")).toBe(key);
      await expect(request.clone().json()).resolves.toEqual(payload);
    }
  });

  it("uses complete group-list membership replacement and preserves typed errors", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code: "GROUP_LIST_GROUP_LIMIT_EXCEEDED",
      message: "Too many groups.",
      fieldErrors: { groupIds: ["At most 1000 groups."] },
      details: {},
    }, { status: 422 }));
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );
    const error = await api.replaceGroupListGroups("list-id", ["one@g.us"], 7)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "GROUP_LIST_GROUP_LIMIT_EXCEEDED",
      status: 422,
      fieldErrors: { groupIds: ["At most 1000 groups."] },
    });
    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.method).toBe("PUT");
    await expect(request.json()).resolves.toEqual({
      groupIds: ["one@g.us"], expectedMembershipRevision: 7,
    });
  });

  it("archives a Group List with the displayed aggregate revision", async () => {
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const api = new RuntimeApi(
      { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
      runtimeFetch,
    );

    await expect(api.archiveGroupList("list id", 9)).resolves.toBeUndefined();

    const request = runtimeFetch.mock.calls[0][0] as Request;
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe(
      "http://127.0.0.1:3100/api/v1/group-lists/list%20id?expectedRevision=9",
    );
  });

  it.each([401, 404, 409, 422])(
    "preserves typed Group List HTTP %s responses",
    async (status) => {
      const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
        code: `GROUP_LIST_${status}`,
        message: "Typed Runtime failure.",
        fieldErrors: { name: ["Invalid value."] },
        details: { status },
      }, { status }));
      const api = new RuntimeApi(
        { baseUrl: "http://127.0.0.1:3100", apiKey: "test-key" },
        runtimeFetch,
      );
      const error = await api.getGroupList("list-id").catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: `GROUP_LIST_${status}`,
        status,
        fieldErrors: { name: ["Invalid value."] },
        details: { status },
      });
    },
  );
});
