import type {
  OpenWAMessageOperationClass,
  OpenWAOperationClass,
  OpenWASafetyBucketPolicy,
  OpenWASafetyProfile,
} from './openwa-safety.types';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

interface MessageProfilePolicy {
  pacingMs: Record<OpenWAMessageOperationClass, number>;
  minuteLimit: number;
  hourLimit: number;
  dayLimit: number;
  recipientLimit: number;
  recipientWindowMs: number;
  imageCost: number;
}

const policies: Record<OpenWASafetyProfile, MessageProfilePolicy> = {
  CANARY: {
    pacingMs: { MESSAGE_SEND_TEXT: 15_000, MESSAGE_SEND_IMAGE: 20_000 },
    minuteLimit: 3,
    hourLimit: 20,
    dayLimit: 50,
    recipientLimit: 1,
    recipientWindowMs: 6 * hour,
    imageCost: 2,
  },
  STANDARD: {
    pacingMs: { MESSAGE_SEND_TEXT: 10_000, MESSAGE_SEND_IMAGE: 15_000 },
    minuteLimit: 5,
    hourLimit: 40,
    dayLimit: 100,
    recipientLimit: 2,
    recipientWindowMs: 6 * hour,
    imageCost: 2,
  },
};

export function messageSafetyPolicy(profile: OpenWASafetyProfile): MessageProfilePolicy {
  return policies[profile];
}

export function messageBucketPolicies(
  profile: OpenWASafetyProfile,
  operationClass: OpenWAMessageOperationClass,
): OpenWASafetyBucketPolicy[] {
  const policy = messageSafetyPolicy(profile);
  const cost = operationClass === 'MESSAGE_SEND_IMAGE' ? policy.imageCost : 1;
  return [
    {
      scopeType: 'UPSTREAM', operationClass: 'UPSTREAM_ALL', windowName: 'MINUTE',
      limit: 80, periodMs: minute, burst: 8, cost: 1,
    },
    {
      scopeType: 'UPSTREAM', operationClass: 'UPSTREAM_ALL', windowName: 'HOUR',
      limit: 800, periodMs: hour, burst: 20, cost: 1,
    },
    {
      scopeType: 'SESSION', operationClass: 'MESSAGE_SEND_ALL', windowName: 'PACING',
      limit: 1, periodMs: policy.pacingMs.MESSAGE_SEND_TEXT, burst: 1, cost: 1,
    },
    {
      scopeType: 'SESSION', operationClass, windowName: 'PACING',
      limit: 1, periodMs: policy.pacingMs[operationClass], burst: 1, cost: 1,
    },
    {
      scopeType: 'SESSION', operationClass: 'MESSAGE_SEND_ALL', windowName: 'MINUTE',
      limit: policy.minuteLimit, periodMs: minute, burst: 1, cost,
    },
    {
      scopeType: 'SESSION', operationClass: 'MESSAGE_SEND_ALL', windowName: 'HOUR',
      limit: policy.hourLimit, periodMs: hour, burst: 3, cost,
    },
    {
      scopeType: 'SESSION', operationClass: 'MESSAGE_SEND_ALL', windowName: 'DAY',
      limit: policy.dayLimit, periodMs: day, burst: 10, cost,
    },
  ];
}

const operationLimits: Record<Exclude<OpenWAOperationClass,
  OpenWAMessageOperationClass>, { limit: number; periodMs: number; burst: number }> = {
  RECOVERY_PROBE: { limit: 2, periodMs: minute, burst: 1 },
  GROUP_READ_TARGETED: { limit: 30, periodMs: minute, burst: 5 },
  SESSION_READ: { limit: 10, periodMs: minute, burst: 2 },
  GROUP_READ_BULK: { limit: 2, periodMs: minute, burst: 1 },
  WEBHOOK_CONTROL: { limit: 2, periodMs: minute, burst: 1 },
  CONTACT_READ: { limit: 2, periodMs: minute, burst: 1 },
  PAGINATED_READ_PAGE: { limit: 80, periodMs: minute, burst: 8 },
};

export function operationBucketPolicies(
  operationClass: Exclude<OpenWAOperationClass, OpenWAMessageOperationClass>,
  hasSessionScope: boolean,
  upstreamCost = 1,
): OpenWASafetyBucketPolicy[] {
  const operation = operationLimits[operationClass];
  return [
    {
      scopeType: 'UPSTREAM', operationClass: 'UPSTREAM_ALL', windowName: 'MINUTE',
      limit: 80, periodMs: minute, burst: 8, cost: upstreamCost,
    },
    {
      scopeType: 'UPSTREAM', operationClass: 'UPSTREAM_ALL', windowName: 'HOUR',
      limit: 800, periodMs: hour, burst: 20, cost: upstreamCost,
    },
    {
      scopeType: hasSessionScope ? 'SESSION' : 'UPSTREAM', operationClass, windowName: 'MINUTE',
      ...operation, cost: 1,
    },
  ];
}

export function emissionIntervalMs(policy: OpenWASafetyBucketPolicy): number {
  return Math.max(1, Math.ceil(policy.periodMs / policy.limit));
}
