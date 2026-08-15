import { describe, expect, it } from "vitest";

import type { components, paths } from "./generated/runtime";
import openapiSnapshot from "../../../contracts/wa-runtime/v1/openapi.json?raw";

type UpdateCampaignDto = components["schemas"]["UpdateCampaignDto"];
type CampaignListQuery = NonNullable<
  paths["/api/v1/campaigns"]["get"]["parameters"]["query"]
>;
type GroupListQuery = paths["/api/v1/groups"]["get"]["parameters"]["query"];
type SavedGroupListQuery = paths["/api/v1/group-lists"]["get"]["parameters"]["query"];
type CreateGroupListDto = components["schemas"]["CreateGroupListDto"];
type GroupListMembershipDto = components["schemas"]["GroupListMembershipDto"];
type SavedGroupListDto = components["schemas"]["SavedGroupListDto"];
type ReplaceGroupListGroupsDto = components["schemas"]["ReplaceGroupListGroupsDto"];
type CampaignTargetListDto = components["schemas"]["CampaignTargetListDto"];
type ApplyGroupListTargetsDto = components["schemas"]["ApplyGroupListTargetsDto"];
type CreateCampaignRunDto = components["schemas"]["CreateCampaignRunDto"];
type CampaignRunDto = components["schemas"]["CampaignRunDto"];

describe("authoritative WA Runtime contract", () => {
  it("keeps the canonical snapshot at the pinned SHA-256", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(openapiSnapshot),
    );
    const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(checksum)
      .toBe("d8de71d177c7e14a3b79a71bd1a9d8cdf4b829e742a3cf9663148a108a874d0b");
  });

  it("generates nullable scheduledAt for UpdateCampaignDto", () => {
    const immediate: UpdateCampaignDto = { scheduleType: "IMMEDIATE", scheduledAt: null };
    const contentOnly: UpdateCampaignDto = { text: "Changed without scheduling" };
    expect(immediate.scheduledAt).toBeNull();
    expect(contentOnly).not.toHaveProperty("scheduledAt");
  });

  it("generates the authoritative campaign search and multi-filter query", () => {
    const query: CampaignListQuery = {
      limit: 20,
      offset: 0,
      sessionId: "session-id",
      query: "release",
      status: ["DRAFT", "PAUSED"],
      scheduleType: ["IMMEDIATE", "ONCE"],
    };
    expect(query.status).toEqual(["DRAFT", "PAUSED"]);
    expect(query.scheduleType).toEqual(["IMMEDIATE", "ONCE"]);
  });

  it("generates participant bounds for the authoritative group-list query", () => {
    const query: GroupListQuery = {
      sessionId: "session-id",
      minParticipants: 50,
      maxParticipants: 500,
    };
    expect(query.minParticipants).toBe(50);
    expect(query.maxParticipants).toBe(500);
  });

  it("generates saved Group List browsing and atomic create membership types", () => {
    const query: SavedGroupListQuery = {
      sessionId: "session-id",
      query: "launch",
      limit: 20,
      offset: 0,
    };
    const create: CreateGroupListDto = {
      sessionId: "session-id",
      name: "Launch groups",
      description: null,
      groupIds: ["one@g.us", "two@g.us"],
    };
    const membership = {} as GroupListMembershipDto;
    expect(query.query).toBe("launch");
    expect(create.groupIds).toEqual(["one@g.us", "two@g.us"]);
    expect(membership).toEqual({});
  });

  it("generates revision-safe Group List and Campaign target provenance types", () => {
    const list = { membershipRevision: 4 } as SavedGroupListDto;
    const replacement: ReplaceGroupListGroupsDto = {
      groupIds: ["one@g.us"],
      expectedMembershipRevision: 4,
    };
    const apply: ApplyGroupListTargetsDto = {
      groupListId: "11111111-1111-4111-8111-111111111111",
      expectedMembershipRevision: 4,
      expectedTargetsRevision: 8,
    };
    const targets = { source: null } as CampaignTargetListDto;
    expect(list.membershipRevision).toBe(4);
    expect(replacement.expectedMembershipRevision).toBe(4);
    expect(apply.expectedTargetsRevision).toBe(8);
    expect(targets.source).toBeNull();
  });

  it("generates launch revision preconditions and immutable run target provenance", () => {
    const create: CreateCampaignRunDto = {
      executionMode: "LIVE",
      expectedCampaignRevision: 3,
      expectedTargetsRevision: 8,
    };
    const run = { targetSource: null } as CampaignRunDto;
    expect(create).toMatchObject({ expectedCampaignRevision: 3, expectedTargetsRevision: 8 });
    expect(run.targetSource).toBeNull();
  });
});
