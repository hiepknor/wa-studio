import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../../core/config/runtime-config.module';
import { RuntimeDispatchReadinessService } from '../../../core/dispatch-readiness/runtime-dispatch-readiness.service';
import { OpenWASafetyRepository } from './openwa-safety.repository';
import type {
  CommittedOpenWAMessagePermit,
  OpenWAMessageOperationClass,
  OpenWAMessageSafetyForecast,
  OpenWAMessagePermit,
  OpenWAConnectorCommandCommit,
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
    @Optional() private readonly dispatchReadiness?: RuntimeDispatchReadinessService,
  ) {
    this.upstreamId = openWAUpstreamId(config.OPENWA_BASE_URL);
  }

  async reserveMessage(input: {
    sessionId: string;
    messageJobId: string;
    recipientId: string;
    operationClass: OpenWAMessageOperationClass;
  }): Promise<OpenWAPermitDecision> {
    const readiness = this.dispatchReadiness
      ? await this.dispatchReadiness.snapshot()
      : this.config.EVENT_INBOX_BASE_URL
        ? { ready: false, reason: 'event_inbox_dispatch_readiness_unavailable' }
        : null;
    if (readiness && !readiness.ready) {
      return {
        outcome: 'DEFERRED',
        notBefore: new Date(Date.now() + this.config.EVENT_INBOX_POLL_INTERVAL_MS),
        reason: readiness.reason ?? 'EVENT_INBOX_RECOVERY_PENDING',
      };
    }
    const connectorLeaseMs = this.config.OPENWA_CONNECTOR_EVIDENCE_TIMEOUT_SECONDS * 1_000;
    return this.repository.reserveMessage({
      ...input,
      upstreamId: this.upstreamId,
      leaseTtlMs: Math.max(
        this.config.OPENWA_REQUEST_DEADLINE_MS,
        this.config.EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS ? connectorLeaseMs : 0,
      ) + 30_000,
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

  forecastMessages(input: {
    sessionId: string;
    recipientIds: string[];
    operationClass: OpenWAMessageOperationClass;
  }): Promise<OpenWAMessageSafetyForecast> {
    return this.repository.forecastMessages({ ...input, upstreamId: this.upstreamId });
  }

  commitMessageStart(
    permit: OpenWAMessagePermit,
    connectorCommand?: OpenWAConnectorCommandCommit,
  ): Promise<CommittedOpenWAMessagePermit | null> {
    return this.repository.commitMessageStart(
      permit,
      this.config.EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS,
      connectorCommand,
      {
        required: this.dispatchReadiness?.required() ?? Boolean(this.config.EVENT_INBOX_BASE_URL),
        maximumHeartbeatAgeMs: this.dispatchReadiness?.maximumHeartbeatAgeMs() ?? 0,
      },
    );
  }

  async requireHealthyConnectorBindingGeneration(sessionId: string): Promise<number> {
    const generation = await this.repository.healthyConnectorBindingGeneration(sessionId);
    if (generation === null) throw new Error('OpenWA connector binding is not healthy');
    return generation;
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

  sessionQuiescence(sessionId: string) {
    return this.repository.sessionQuiescence(this.upstreamId, sessionId);
  }

  workspaceQuiescence() {
    return this.repository.workspaceQuiescence();
  }

  mutateWorkspace(input: Omit<Parameters<OpenWASafetyRepository['mutateWorkspace']>[0], 'upstreamId'>) {
    return this.repository.mutateWorkspace({ ...input, upstreamId: this.upstreamId });
  }

  mutateSession(input: Omit<Parameters<OpenWASafetyRepository['mutateSession']>[0], 'upstreamId'>) {
    return this.repository.mutateSession({ ...input, upstreamId: this.upstreamId });
  }
}
