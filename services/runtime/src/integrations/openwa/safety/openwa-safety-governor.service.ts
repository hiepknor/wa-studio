import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../../core/config/runtime-config.module';
import { OpenWASafetyRepository } from './openwa-safety.repository';
import type {
  CommittedOpenWAMessagePermit,
  OpenWAMessageOperationClass,
  OpenWAMessagePermit,
  OpenWAOperationClass,
  OpenWAOperationPermit,
  OpenWAOperationPermitDecision,
  OpenWAOperationOutcome,
  OpenWAPermitDecision,
} from './openwa-safety.types';

export function openWAUpstreamId(origin: string): string {
  return createHash('sha256').update(new URL(origin).origin).digest('hex');
}

@Injectable()
export class OpenWASafetyGovernorService {
  private readonly upstreamId: string;

  constructor(
    private readonly repository: OpenWASafetyRepository,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {
    this.upstreamId = openWAUpstreamId(config.OPENWA_BASE_URL);
  }

  reserveMessage(input: {
    sessionId: string;
    messageJobId: string;
    recipientId: string;
    operationClass: OpenWAMessageOperationClass;
  }): Promise<OpenWAPermitDecision> {
    return this.repository.reserveMessage({
      ...input,
      upstreamId: this.upstreamId,
      leaseTtlMs: this.config.OPENWA_REQUEST_DEADLINE_MS + 30_000,
    });
  }

  reserveOperation(input: {
    sessionId?: string;
    operationClass: Exclude<OpenWAOperationClass, OpenWAMessageOperationClass>;
    holderType: 'GATEWAY_SYNC' | 'GROUP_REFRESH' | 'CONTACT_SYNC' | 'WEBHOOK_RECONCILIATION' | 'PROBE';
    holderId: string;
    upstreamCost?: number;
  }): Promise<OpenWAOperationPermitDecision> {
    return this.repository.reserveOperation({
      ...input,
      upstreamId: this.upstreamId,
      leaseTtlMs: this.config.OPENWA_REQUEST_DEADLINE_MS + 30_000,
    });
  }

  commitMessageStart(permit: OpenWAMessagePermit): Promise<CommittedOpenWAMessagePermit | null> {
    return this.repository.commitMessageStart(permit);
  }

  recordOutcome(permit: OpenWAOperationPermit, outcome: OpenWAOperationOutcome): Promise<void> {
    return this.repository.recordOutcome(permit, outcome);
  }

  release(permit: OpenWAOperationPermit): Promise<void> {
    return this.repository.release(permit);
  }

  sessionSnapshot(sessionId: string) {
    return this.repository.sessionSnapshot(this.upstreamId, sessionId);
  }

  mutateSession(input: Omit<Parameters<OpenWASafetyRepository['mutateSession']>[0], 'upstreamId'>) {
    return this.repository.mutateSession({ ...input, upstreamId: this.upstreamId });
  }
}
