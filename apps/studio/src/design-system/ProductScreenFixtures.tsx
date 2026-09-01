import { useEffect, useRef, useState } from "react";

import {
  RuntimeConnectionProvider,
  useRuntimeConnection,
} from "@/app/RuntimeConnectionContext";
import { WorkspaceShell } from "@/app/WorkspaceShell";
import { ConnectionScreen } from "@/features/connection/ConnectionScreen";
import type {
  RuntimeActivityEvent,
  RuntimeApi,
  RuntimeCampaign,
  RuntimeCampaignRun,
  RuntimeCampaignRunSummary,
  RuntimeCampaignTarget,
  RuntimeGroup,
  RuntimeGroupList,
  RuntimeGroupMember,
  RuntimeSession,
} from "@/shared/api/runtime-client";
import type { ManagedRuntimeSnapshot } from "@/shared/native/managed-runtime";
import { ToastProvider } from "@/shared/ui/Toast";

type ProductFixtureView = "activity" | "campaigns" | "connection" | "groups" | "runs";

const SESSION: RuntimeSession = {
  connectedAt: "2026-08-30T09:00:00.000Z",
  engineLoaded: true,
  gatewayCreatedAt: "2026-08-01T00:00:00.000Z",
  gatewayUpdatedAt: "2026-08-30T09:00:00.000Z",
  id: "fixture-session",
  lastActiveAt: "2026-08-30T17:30:00.000Z",
  lastError: null,
  name: "North America operations",
  phone: "+15550000000",
  pushName: "WA Studio fixture",
  restriction: null,
  status: "ready",
  syncedAt: "2026-08-30T17:30:00.000Z",
};

const GROUP_NAMES = [
  "North America operations",
  "Product research with a deliberately long synchronized title",
  "Retail partners",
  "Launch coordinators",
  "Customer success leads",
  "Wholesale announcements",
  "Regional inventory",
  "After-sales support",
];

const GROUPS: RuntimeGroup[] = GROUP_NAMES.map((name, index) => ({
  description: index === 1 ? "Long content verifies truncation without changing row geometry." : null,
  detailsSyncedAt: "2026-08-30T17:30:00.000Z",
  id: `12036300000000000${index}@g.us`,
  isActive: index !== 6,
  isAdmin: index % 3 !== 1,
  isAnnounce: index === 5,
  isReadOnly: index % 3 === 1,
  linkedParentId: null,
  name,
  ownerId: null,
  participantsCount: [404, 1_001, 87, 219, 42, 575, 18, 133][index] ?? null,
  sendCapability: {
    checkedAt: "2026-08-30T17:30:00.000Z",
    invalidatedAt: null,
    reason: index % 3 === 1 ? "ADMIN_REQUIRED" : "SEND_ALLOWED",
    revision: 3,
    status: index % 3 === 1 ? "DENIED" : "ALLOWED",
  },
  sessionId: SESSION.id,
  settingsLocked: false,
  syncedAt: "2026-08-30T17:30:00.000Z",
}));

const GROUP_MEMBERS: RuntimeGroupMember[] = Array.from({ length: 8 }, (_, index) => {
  const phone = `8490000000${index}`;
  return {
    displayName: index < 2 ? ["Mai Nguyen", "Release operator"][index] : null,
    displayNameSource: index < 2 ? "OPENWA_CONTACT_NAME" : null,
    identityType: "PHONE_JID",
    isAdmin: index < 4,
    isSuperAdmin: index === 0,
    participantId: `${phone}@c.us`,
    phoneNumber: phone,
    projectionRevision: 10,
    resolvedPhoneNumber: phone,
  };
});

const SAVED_LIST: RuntimeGroupList = {
  archivedAt: null,
  createdAt: "2026-08-20T08:00:00.000Z",
  description: "Groups approved for the next product release",
  groupCount: 3,
  id: "11111111-1111-4111-8111-111111111111",
  membershipRevision: 2,
  name: "Release cohort",
  revision: 4,
  sessionId: SESSION.id,
  updatedAt: "2026-08-30T17:30:00.000Z",
};

const CAMPAIGN: RuntimeCampaign = {
  content: { text: "The August release is ready for review.", type: "TEXT" },
  createdAt: "2026-08-30T16:00:00.000Z",
  id: "70cf89e8-0dd0-4a59-9587-861c200e3595",
  name: "August product release",
  revision: 3,
  scheduledAt: null,
  scheduleType: "IMMEDIATE",
  sessionId: SESSION.id,
  status: "DRAFT",
  targetCount: 3,
  targetsRevision: 2,
  text: "The August release is ready for review.",
  updatedAt: "2026-08-30T17:20:00.000Z",
};

const CAMPAIGN_TARGETS: RuntimeCampaignTarget[] = GROUPS.slice(0, 3).map((group) => ({
  enabled: group.sendCapability.status === "ALLOWED",
  groupId: group.id,
  groupName: group.name,
  participantsCount: group.participantsCount,
  sendCapability: group.sendCapability,
}));

const RUN_PROGRESS = {
  accepted: 2,
  blocked: 1,
  cancelled: 0,
  delivered: 18,
  dryRunCompleted: 0,
  failed: 1,
  materialized: 0,
  pending: 4,
  processing: 3,
  read: 24,
  sent: 18,
  total: 71,
  unknown: 0,
};

const RUN_SUMMARY: RuntimeCampaignRunSummary = {
  campaignId: CAMPAIGN.id,
  campaignNameSnapshot: CAMPAIGN.name,
  completedAt: null,
  createdAt: "2026-08-30T17:21:00.000Z",
  executionMode: "LIVE",
  id: "22222222-2222-4222-8222-222222222222",
  progress: RUN_PROGRESS,
  scheduledAt: "2026-08-30T17:21:00.000Z",
  sessionId: SESSION.id,
  startedAt: "2026-08-30T17:21:01.000Z",
  status: "RUNNING",
  statusReason: null,
  totalTargets: 71,
  updatedAt: "2026-08-30T17:30:00.000Z",
};

const RUN: RuntimeCampaignRun = {
  ...RUN_SUMMARY,
  campaignRevision: CAMPAIGN.revision,
  content: { text: "The August release is ready for review.", type: "TEXT" },
  preflight: null,
  targetSource: null,
  targetsRevision: CAMPAIGN.targetsRevision,
  text: "The August release is ready for review.",
};

const ACTIVITY_EVENT: RuntimeActivityEvent = {
  category: "RUN",
  correlationId: "request-fixture-42",
  eventType: "campaign_run.completed",
  eventVersion: 1,
  id: "33333333-3333-4333-8333-333333333333",
  metadata: { executionMode: "LIVE", status: "COMPLETED" },
  occurredAt: "2026-08-30T17:30:00.000Z",
  origin: "RUNTIME",
  related: {
    campaignId: CAMPAIGN.id,
    groupId: null,
    runId: RUN.id,
    syncRunId: null,
  },
  sessionId: SESSION.id,
  severity: "SUCCESS",
  subject: {
    id: RUN.id,
    labelSnapshot: CAMPAIGN.name,
    type: "CAMPAIGN_RUN",
  },
};

const UNAVAILABLE_RUNTIME: ManagedRuntimeSnapshot = {
  availability: "offline",
  capabilities: {
    canEditDrafts: false,
    canLaunchCampaign: false,
    canRead: false,
    canSend: false,
    canSync: false,
  },
  connection: null,
  error: null,
  maintenance: null,
  manifest: null,
  phase: "unavailable",
};

function createFixtureApi(): RuntimeApi {
  return {
    getCampaign: async () => CAMPAIGN,
    getCampaignRun: async () => RUN,
    getCurrentGroupCapabilityRefresh: async () => null,
    getGroup: async (_sessionId: string, groupId: string) => (
      GROUPS.find((group) => group.id === groupId) ?? GROUPS[0]
    ),
    getGroupListMembership: async () => ({
      data: GROUPS.slice(0, 3).map((group) => ({
        groupId: group.id,
        groupName: group.name,
        isActive: group.isActive,
        participantsCount: group.participantsCount,
        sendCapability: group.sendCapability,
        syncedAt: group.syncedAt,
      })),
      list: SAVED_LIST,
    }),
    getOperationalHealth: async () => ({
      components: {},
      reason: null,
      status: "operational",
    }),
    listCampaignRuns: async () => ({ data: [], meta: { limit: 20, offset: 0, total: 0 } }),
    listCampaignDeliveries: async () => ({
      data: GROUPS.slice(0, 6).map((group, index) => ({
        createdAt: RUN.createdAt,
        failureReason: index === 3 ? "GROUP_UNAVAILABLE" : null,
        groupId: group.id,
        groupName: group.name,
        id: `44444444-4444-4444-8444-44444444444${index}`,
        messageJobId: index === 3 ? null : `55555555-5555-4555-8555-55555555555${index}`,
        runId: RUN.id,
        status: index === 0 ? "BLOCKED_CAPABILITY_CHANGED" : index === 3 ? "FAILED" : index === 1 ? "READ" : "SENT",
        updatedAt: RUN.updatedAt,
      })),
      meta: { limit: 20, offset: 0, total: 6 },
    }),
    listCampaignTargets: async () => ({
      data: CAMPAIGN_TARGETS,
      source: null,
      targetsRevision: CAMPAIGN.targetsRevision,
    }),
    listCampaigns: async () => ({
      data: [CAMPAIGN],
      meta: { limit: 50, offset: 0, total: 1 },
    }),
    listGroupLists: async () => ({
      data: [SAVED_LIST],
      meta: { limit: 50, offset: 0, total: 1 },
    }),
    listGroups: async () => ({
      data: GROUPS,
      meta: { limit: 20, offset: 0, total: GROUPS.length },
    }),
    listGroupMembers: async () => ({
      data: GROUP_MEMBERS,
      meta: {
        datasetRevision: 10,
        limit: 25,
        offset: 0,
        total: GROUP_MEMBERS.length,
      },
    }),
    listActivity: async () => ({
      data: [ACTIVITY_EVENT],
      meta: { limit: 50, nextCursor: null, retentionDays: 90 },
    }),
    listRuns: async () => ({
      data: [RUN_SUMMARY],
      meta: { limit: 50, offset: 0, total: 1 },
    }),
    listSessions: async () => [SESSION],
  } as unknown as RuntimeApi;
}

function ConnectedFixture({ view }: { view: Exclude<ProductFixtureView, "connection"> }) {
  const { connect, connected } = useRuntimeConnection();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current || connected) return;
    started.current = true;
    window.localStorage.setItem("wa-studio-view", view);
    void connect({
      apiKey: "0123456789abcdef0123456789abcdef",
      baseUrl: "https://runtime.fixture.invalid",
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Fixture connection failed");
    });
  }, [connect, connected, view]);

  if (error) return <p role="alert">{error}</p>;
  if (!connected) return <p aria-live="polite" role="status">Loading product fixture…</p>;
  return <WorkspaceShell getProvisioningProfile={async () => null} />;
}

function requestedView(): ProductFixtureView {
  const view = new URLSearchParams(window.location.search).get("view");
  return ["activity", "campaigns", "groups", "runs"].includes(view ?? "")
    ? view as Exclude<ProductFixtureView, "connection">
    : "connection";
}

export function ProductScreenFixtures() {
  const view = requestedView();
  if (view === "connection") {
    return (
      <ToastProvider>
        <ConnectionScreen probeConnection={async () => ({
          readySessions: 1,
          sessionCount: 1,
          sessions: [SESSION],
        })} />
      </ToastProvider>
    );
  }

  const api = createFixtureApi();
  return (
    <ToastProvider>
      <RuntimeConnectionProvider
        createApi={() => api}
        discoverManagedRuntime={async () => UNAVAILABLE_RUNTIME}
        probeConnection={async () => ({
          readySessions: 1,
          sessionCount: 1,
          sessions: [SESSION],
        })}
        subscribeToManagedRuntime={async () => () => undefined}
      >
        <ConnectedFixture view={view} />
      </RuntimeConnectionProvider>
    </ToastProvider>
  );
}
