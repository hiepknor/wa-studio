import type { GatewaySyncFailurePolicy } from './gateway-sync-item.types';

export interface GatewayGroupIntentDispatch {
  sessionId: string;
  groupId: string;
  requestedRevision: number;
  availableAt: Date;
  priority: number;
}

export interface ClaimedGatewayGroupIntent {
  sessionId: string;
  groupId: string;
  requestedRevision: number;
  leaseToken: string;
  attemptNumber: number;
  coalescedCount: number;
  requestedAt: Date;
  source: 'MANUAL' | 'SYSTEM';
}

export type GatewayGroupIntentFailurePolicy = GatewaySyncFailurePolicy;
