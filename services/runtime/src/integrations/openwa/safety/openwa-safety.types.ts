export const OPENWA_SAFETY_POLICY_VERSION = 5;

export const OPENWA_SAFETY_PROFILES = ['CANARY', 'STANDARD'] as const;
export type OpenWASafetyProfile = (typeof OPENWA_SAFETY_PROFILES)[number];

export const OPENWA_OPERATION_CLASSES = [
  'RECOVERY_PROBE',
  'GROUP_READ_TARGETED',
  'MESSAGE_SEND_TEXT',
  'MESSAGE_SEND_IMAGE',
  'SESSION_READ',
  'GROUP_READ_BULK',
  'WEBHOOK_CONTROL',
  'CONTACT_READ',
  'PAGINATED_READ_PAGE',
] as const;
export type OpenWAOperationClass = (typeof OPENWA_OPERATION_CLASSES)[number];

export type OpenWASafetyStatus = 'READY' | 'THROTTLED' | 'COOLDOWN' | 'RECOVERY' | 'BLOCKED';
export type OpenWACircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'MANUAL_BLOCKED';
export type OpenWARateMode = 'NORMAL' | 'THROTTLED';

export interface OpenWASafetyScopeSnapshot {
  scopeType: 'WORKSPACE' | 'UPSTREAM' | 'SESSION';
  effectiveScopeType: 'WORKSPACE' | 'UPSTREAM' | 'SESSION';
  circuitState: OpenWACircuitState;
  rateMode: OpenWARateMode;
  status: OpenWASafetyStatus;
  reason: string | null;
  cooldownUntil: Date | null;
  profile: OpenWASafetyProfile;
  outboundState: 'RUNNING' | 'PAUSED';
  outboundPausedAt: Date | null;
  outboundPauseReason: string | null;
  policyVersion: number;
  revision: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  updatedAt: Date;
}

export interface OpenWASafetyQuiescenceSnapshot {
  drained: boolean;
  processingMessageJobs: number;
  unsettledConnectorCommands: number;
  activeSafetyLeases: number;
  checkedAt: Date;
}

export type OpenWAMessageSafetyForecastStatus = 'READY' | 'WAITING' | 'BLOCKED';

export interface OpenWAMessageSafetyForecast {
  status: OpenWAMessageSafetyForecastStatus;
  reason: string | null;
  targetCount: number;
  messageUnits: number;
  queuedMessagesAhead: number;
  recipientDeferredTargets: number;
  estimatedFirstAdmissionAt: Date | null;
  estimatedLastAdmissionAt: Date | null;
  estimatedSpanSeconds: number | null;
  calculatedAt: Date;
}

export interface OpenWASafetyBucketPolicy {
  scopeType: 'UPSTREAM' | 'SESSION';
  operationClass: OpenWAOperationClass | 'UPSTREAM_ALL' | 'MESSAGE_SEND_ALL';
  windowName: 'PACING' | 'MINUTE' | 'HOUR' | 'DAY';
  limit: number;
  periodMs: number;
  burst: number;
  cost: number;
}

export interface OpenWAOperationPermit {
  permitToken: string;
  upstreamId: string;
  sessionId: string;
  operationClass: OpenWAOperationClass;
  policyProfile: OpenWASafetyProfile;
  policyVersion: number;
  reservedAt: Date;
}

export type OpenWAMessageOperationClass = 'MESSAGE_SEND_TEXT' | 'MESSAGE_SEND_IMAGE';

export interface OpenWAMessagePermit extends OpenWAOperationPermit {
  leaseToken: string;
  messageJobId: string;
  recipientId: string;
  operationClass: OpenWAMessageOperationClass;
  expiresAt: Date;
}

export interface OpenWAConnectorCommandCommit {
  attemptId: string;
  commandId: string;
  bindingGeneration: number;
  payloadSha256: string;
  commandBody: Buffer;
  expiresAt: Date;
}

declare const committedPermitBrand: unique symbol;
export type CommittedOpenWAMessagePermit = OpenWAMessagePermit & {
  attemptId: string;
  commandId: string;
  bindingGeneration: number | null;
  upstreamStartedAt: Date;
  upstreamAttemptNumber: number;
  readonly [committedPermitBrand]: true;
};

export type OpenWAPermitDecision =
  | { outcome: 'GRANTED'; permit: OpenWAMessagePermit }
  | { outcome: 'DEFERRED'; notBefore: Date; reason: string }
  | { outcome: 'BLOCKED'; reason: string };

export type OpenWAOperationPermitDecision =
  | { outcome: 'GRANTED'; permit: OpenWAOperationPermit }
  | { outcome: 'DEFERRED'; notBefore: Date; reason: string }
  | { outcome: 'BLOCKED'; reason: string };

export type OpenWAOperationOutcome =
  | { kind: 'SUCCESS' }
  | { kind: 'SAFE_REJECTION' }
  | { kind: 'RATE_LIMITED'; retryAfterMs?: number }
  | { kind: 'TRANSIENT_FAILURE' }
  | { kind: 'AMBIGUOUS' }
  | { kind: 'SESSION_RESTRICTED' };

export class OpenWASafetyBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`OpenWA operation blocked by Runtime safety policy: ${reason}`);
    this.name = 'OpenWASafetyBlockedError';
  }
}

export class OpenWASafetyDeferredError extends Error {
  constructor(readonly notBefore: Date, readonly reason: string) {
    super(`OpenWA operation deferred until ${notBefore.toISOString()}: ${reason}`);
    this.name = 'OpenWASafetyDeferredError';
  }
}

export function openWASafetyDeferralAt(
  error: unknown,
  now = Date.now(),
): Date | null {
  if (error instanceof OpenWASafetyDeferredError) return error.notBefore;
  if (error instanceof OpenWASafetyBlockedError) return new Date(now + 60_000);
  return null;
}
