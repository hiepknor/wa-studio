import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { GatewaySyncMode } from '../../contracts/sessions/sync-request.dto';

type GatewayMutationKind = 'SESSION_SYNC' | 'GROUP_CAPABILITY_REFRESH';

const errorPrefix: Record<GatewayMutationKind, string> = {
  SESSION_SYNC: 'SESSION_SYNC',
  GROUP_CAPABILITY_REFRESH: 'GROUP_CAPABILITY_REFRESH',
};

export function requireGatewayMutationKey(
  kind: GatewayMutationKind,
  rawKey: string | undefined,
): string {
  const key = rawKey?.trim();
  if (!key) {
    throw new BadRequestException({
      code: `${errorPrefix[kind]}_IDEMPOTENCY_KEY_REQUIRED`,
      message: 'Idempotency-Key header is required',
      details: {},
    });
  }
  if (!isUUID(key)) {
    throw new BadRequestException({
      code: `${errorPrefix[kind]}_IDEMPOTENCY_KEY_INVALID`,
      message: 'Idempotency-Key must be a UUID',
      details: {},
    });
  }
  return key;
}

export function sessionSyncRequestHash(sessionId: string, mode: GatewaySyncMode): string {
  return digest({ version: 1, operation: 'SESSION_SYNC', sessionId, mode });
}

export function capabilityRefreshRequestHash(sessionId: string, groupId: string): string {
  return digest({ version: 1, operation: 'GROUP_CAPABILITY_REFRESH', sessionId, groupId });
}

function digest(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export class GroupCapabilityRefreshIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different capability refresh request');
    this.name = 'GroupCapabilityRefreshIdempotencyConflictError';
  }
}
