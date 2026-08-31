import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import { OpenWAClient, OpenWAHttpError } from '../../integrations/openwa/openwa.client';
import { GatewayRepository } from '../gateway/gateway.repository';
import { MessageJobRepository } from './message-job.repository';
import { MessageSendPolicyService } from './message-send-policy.service';
import type { MessageJobStatus, MessageSendQueuePayload } from './message-job.types';
import { MessageJobNoLongerProcessingError, OutboundSessionLeaseService } from './outbound-session-lease.service';
import { CampaignContentType } from '../../contracts/campaigns/campaign-content.dto';
import { MediaAssetService } from '../media-assets/media-asset.service';
import { MediaAssetKind } from '../../contracts/media-assets/media-asset.dto';
import {
  campaignImageSendMemoryWeight,
  MediaSendBudgetService,
} from '../media-assets/media-send-budget.service';
import { MessageStatusProjectionService } from './message-status-projection.service';
import { OpenWACompatibilityService } from '../../integrations/openwa/openwa-compatibility.service';
import { OpenWASafetyGovernorService } from '../../integrations/openwa/safety/openwa-safety-governor.service';
import type {
  CommittedOpenWAMessagePermit,
  OpenWAMessagePermit,
  OpenWAOperationOutcome,
} from '../../integrations/openwa/safety/openwa-safety.types';
import {
  EventInboxMediaClient,
  EventInboxMediaHttpError,
} from '../../core/event-inbox/event-inbox-media.client';
import { encodeOpenWAConnectorCommand } from './openwa-connector-command';
import type { MessageJob } from './message-job.types';
import { OpenWAConnectorCommandDispatcherService } from './openwa-connector-command-dispatcher.service';

const isDefinitiveUpstreamRejection = (error: unknown): boolean =>
  error instanceof OpenWAHttpError
  && error.status >= 400
  && error.status < 500
  && error.status !== 408;

const isSafeRetryableUpstreamRejection = (error: unknown): error is OpenWAHttpError =>
  error instanceof OpenWAHttpError && [409, 429].includes(error.status);

@Injectable()
export class MessageJobProcessorService {
  private readonly logger = new Logger(MessageJobProcessorService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly messages: MessageJobRepository,
    private readonly policy: MessageSendPolicyService,
    private readonly openwa: OpenWAClient,
    private readonly gateway: GatewayRepository,
    _outboundSessions: OutboundSessionLeaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
    @Optional() private readonly media?: MediaAssetService,
    @Optional() private readonly mediaBudget?: MediaSendBudgetService,
    @Optional() private readonly statusProjections?: MessageStatusProjectionService,
    @Optional() private readonly openwaCompatibility?: OpenWACompatibilityService,
    @Optional() private readonly safety?: OpenWASafetyGovernorService,
    @Optional() private readonly eventInboxMedia?: EventInboxMediaClient,
    @Optional() private readonly connectorCommands?: OpenWAConnectorCommandDispatcherService,
  ) {}

  async process(payload: MessageSendQueuePayload): Promise<unknown> {
    const job = await this.messages.markProcessing(payload.messageJobId);
    if (!job) return { skipped: true };

    let upstreamStarted = false;
    let safetyPermit: OpenWAMessagePermit | undefined;
    let committedPermit: CommittedOpenWAMessagePermit | undefined;
    try {
      if (job.dryRun) {
        if (job.payload.type !== CampaignContentType.TEXT
          && (!this.media || !await this.media.matchesSnapshot(job.payload, job.sessionId))) {
          throw new Error('Campaign media asset no longer matches its immutable snapshot');
        }
        await this.update(job.id, 'DRY_RUN_COMPLETED', {
          response: {
            dryRun: true,
            contentType: job.payload.type,
            ...(job.payload.type === CampaignContentType.TEXT ? {} : {
              mediaSha256: job.payload.sha256,
              mediaBytes: job.payload.byteSize,
            }),
          },
        });
        return { dryRun: true };
      }

      if (!this.config.ALLOW_LIVE_SENDS) {
        throw new Error('Live send blocked: ALLOW_LIVE_SENDS=false');
      }
      if (!this.safety) {
        throw new Error('Live send blocked: OpenWA Safety Governor is unavailable');
      }
      return await this.processGoverned(job, state => {
        safetyPermit = state.permit;
        committedPermit = state.committed;
        upstreamStarted = Boolean(state.committed);
      });
    } catch (error) {
      if (error instanceof MessageJobNoLongerProcessingError) return { skipped: true };
      if (upstreamStarted && isSafeRetryableUpstreamRejection(error)
        && (committedPermit?.upstreamAttemptNumber ?? job.attemptCount)
          < this.config.MESSAGE_SAFE_RETRY_MAX_ATTEMPTS) {
        const description = `OpenWA HTTP ${error.status} rejected before acceptance; retry scheduled`;
        const delayMs = error.retryAfterMs ?? 5_000;
        await this.database.transaction((client: PoolClient) =>
          this.messages.rescheduleProcessing(client, job.id, description, delayMs));
        if (safetyPermit) {
          await this.recordSafetyOutcome(safetyPermit, error.status === 429
            ? { kind: 'RATE_LIMITED', retryAfterMs: error.retryAfterMs }
            : { kind: 'SAFE_REJECTION' });
        }
        return { retryScheduled: true, delayMs };
      }
      // Once the POST starts, only an explicit client-error response proves that OpenWA rejected
      // the request. A timeout, malformed success response or 5xx may have happened after WhatsApp
      // accepted the message, so retrying it would risk a duplicate send.
      const status: MessageJobStatus = !upstreamStarted || isDefinitiveUpstreamRejection(error)
        ? 'FAILED'
        : 'UNKNOWN';
      const description = error instanceof Error ? error.message : String(error);
      await this.update(job.id, status, { error: description });
      if (safetyPermit) {
        await this.recordSafetyOutcome(safetyPermit, this.safetyOutcome(error, upstreamStarted));
      }
      if (error instanceof OpenWAHttpError && job.recipientId.endsWith('@g.us')) {
        if (error.status === 403) {
          await this.gateway.requestGroupCapabilityRefresh(
            job.sessionId,
            job.recipientId,
            'GATEWAY_PERMISSION_DENIED',
            'send.permission_denied',
            1,
          );
        } else if (error.status === 404) {
          await this.gateway.requestGroupCapabilityRefresh(
            job.sessionId,
            job.recipientId,
            'GROUP_CHANGED',
            'send.group_not_found',
            1,
          );
        }
      }
      throw error;
    }
  }

  private async processGoverned(
    job: MessageJob,
    onState: (state: {
      permit?: OpenWAMessagePermit;
      committed?: CommittedOpenWAMessagePermit;
    }) => void,
  ): Promise<unknown> {
    const operation = async () => {
      const blockReason = await this.policy.liveBlockReason(job.sessionId, job.recipientId);
      if (blockReason) {
        const notBefore = new Date(Date.now() + 60_000);
        await this.messages.deferProcessing(job.id, `Live send blocked: ${blockReason}`, notBefore);
        return { safetyDeferred: true, notBefore, reason: blockReason };
      }
      await this.openwaCompatibility?.requireCompatible();
      const decision = await this.safety!.reserveMessage({
        sessionId: job.sessionId,
        messageJobId: job.id,
        recipientId: job.recipientId,
        operationClass: job.payload.type === CampaignContentType.TEXT
          ? 'MESSAGE_SEND_TEXT'
          : 'MESSAGE_SEND_IMAGE',
      });
      if (decision.outcome === 'DEFERRED') {
        await this.messages.deferProcessing(job.id, `Safety deferred: ${decision.reason}`, decision.notBefore);
        return { safetyDeferred: true, notBefore: decision.notBefore, reason: decision.reason };
      }
      if (decision.outcome === 'BLOCKED') {
        const notBefore = new Date(Date.now() + 60_000);
        await this.messages.deferProcessing(job.id, `Safety blocked: ${decision.reason}`, notBefore);
        return { safetyDeferred: true, notBefore, reason: decision.reason };
      }
      onState({ permit: decision.permit });
      if (this.config.EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS) {
        return this.processWithConnector(job, decision.permit, onState);
      }
      const imageRequest = job.payload.type === CampaignContentType.TEXT
        ? null
        : await this.prepareImageRequest(job, job.payload);
      const committed = await this.safety!.commitMessageStart(decision.permit);
      if (!committed) {
        await this.safety!.release(decision.permit);
        const notBefore = new Date(Date.now() + 60_000);
        await this.messages.deferProcessing(
          job.id,
          'Final send fence rejected current session, recipient, campaign, or cancellation state',
          notBefore,
        );
        return { safetyDeferred: true, notBefore, reason: 'FINAL_SEND_FENCE_REJECTED' };
      }
      onState({ permit: decision.permit, committed });
      const result = job.payload.type === CampaignContentType.TEXT
        ? await this.openwa.sendText(committed, job.sessionId, job.recipientId, job.payload.text)
        : await this.openwa.sendImage(committed, imageRequest!);
      await this.update(job.id, 'ACCEPTED', { openwaMessageId: result.messageId, response: result });
      await this.recordSafetyOutcome(decision.permit, { kind: 'SUCCESS' });
      return result;
    };

    if (job.payload.type === CampaignContentType.TEXT || !this.mediaBudget) return operation();
    return this.mediaBudget.withBytes(campaignImageSendMemoryWeight(job.payload.byteSize), operation, {
      onWait: async () => {
        if (!await this.messages.refreshProcessingLease(job.id)) {
          throw new MessageJobNoLongerProcessingError('Message job is no longer processing');
        }
      },
    });
  }

  private async processWithConnector(
    job: MessageJob,
    permit: OpenWAMessagePermit,
    onState: (state: {
      permit?: OpenWAMessagePermit;
      committed?: CommittedOpenWAMessagePermit;
    }) => void,
  ): Promise<unknown> {
    if (!this.eventInboxMedia || !this.connectorCommands) {
      throw new Error('Live send blocked: OpenWA connector command path is unavailable');
    }
    let bindingGeneration: number;
    try {
      bindingGeneration = await this.safety!.requireHealthyConnectorBindingGeneration(job.sessionId);
    } catch {
      await this.safety!.release(permit);
      const notBefore = new Date(Date.now() + this.config.EVENT_INBOX_CONNECTOR_POLL_INTERVAL_MS);
      await this.messages.deferProcessing(
        job.id,
        'OpenWA connector binding is not healthy',
        notBefore,
      );
      return { connectorDeferred: true, notBefore, reason: 'CONNECTOR_UNHEALTHY' };
    }
    const attemptId = randomUUID();
    const commandId = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.valueOf() + this.config.OPENWA_CONNECTOR_COMMAND_TTL_SECONDS * 1_000,
    );
    let content: Record<string, unknown>;
    if (job.payload.type === CampaignContentType.TEXT) {
      content = { type: 'TEXT', text: job.payload.text };
    } else {
      const asset = await this.resolveMedia(job.sessionId, job.payload);
      const mimeType = connectorImageMimeType(asset.mimeType);
      let lease;
      try {
        lease = await this.eventInboxMedia.put({
          attemptId,
          sessionId: job.sessionId,
          filename: asset.filename,
          mimeType,
          sha256: asset.sha256,
          expiresAt,
          content: asset.content,
        });
      } catch (error) {
        if (!isRetryableMediaRelayFailure(error)) throw error;
        await this.safety!.release(permit);
        const notBefore = new Date(Date.now() + mediaRelayRetryDelayMs(error));
        await this.messages.deferProcessing(
          job.id,
          'Event Inbox media relay is temporarily unavailable',
          notBefore,
        );
        return { connectorDeferred: true, notBefore, reason: 'MEDIA_RELAY_UNAVAILABLE' };
      }
      content = {
        type: 'IMAGE',
        filename: asset.filename,
        mimeType,
        byteSize: asset.byteSize,
        sha256: asset.sha256,
        mediaUrl: lease.mediaUrl,
        caption: job.payload.caption ?? '',
      };
    }
    const encoded = encodeOpenWAConnectorCommand({
      protocolVersion: 1,
      commandId,
      attemptId,
      sessionId: job.sessionId,
      recipientId: job.recipientId,
      safetyPermitId: permit.permitToken,
      bindingGeneration,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      operation: job.payload.type === CampaignContentType.TEXT ? 'SEND_TEXT' : 'SEND_IMAGE',
      content,
    });
    const committed = await this.safety!.commitMessageStart(permit, {
      attemptId,
      commandId,
      bindingGeneration,
      payloadSha256: encoded.sha256,
      commandBody: encoded.body,
      expiresAt,
    });
    if (!committed) {
      await this.safety!.release(permit);
      const notBefore = new Date(Date.now() + 60_000);
      await this.messages.deferProcessing(
        job.id,
        'Final send fence rejected current connector, session, recipient, campaign, or cancellation state',
        notBefore,
      );
      return { safetyDeferred: true, notBefore, reason: 'FINAL_SEND_FENCE_REJECTED' };
    }
    onState({ permit, committed });
    let dispatched = false;
    try {
      dispatched = await this.connectorCommands.dispatchAttempt(attemptId);
    } catch (error) {
      this.logger.error({
        event: 'openwa_connector.command.fast_dispatch_failed',
        messageJobId: job.id,
        attemptId,
        commandId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { queued: true, attemptId, commandId, dispatched };
  }

  private async prepareImageRequest(
    job: MessageJob,
    content: Exclude<import('../../contracts/campaigns/campaign-content.dto').CampaignContentDto, { type: 'TEXT' }>,
  ) {
    const asset = await this.resolveMedia(job.sessionId, content);
    return {
      sessionId: job.sessionId,
      chatId: job.recipientId,
      base64: asset.content.toString('base64'),
      mimetype: asset.mimeType,
      caption: content.caption ?? '',
    };
  }

  private async recordSafetyOutcome(
    permit: OpenWAMessagePermit,
    outcome: OpenWAOperationOutcome,
  ): Promise<void> {
    if (!this.safety) return;
    try {
      await this.safety.recordOutcome(permit, outcome);
    } catch (error) {
      this.logger.error({
        event: 'openwa.safety.outcome_record_failed',
        messageJobId: permit.messageJobId,
        operationClass: permit.operationClass,
        outcome: outcome.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private safetyOutcome(error: unknown, upstreamStarted: boolean): OpenWAOperationOutcome {
    if (!upstreamStarted) return { kind: 'SAFE_REJECTION' };
    if (error instanceof OpenWAHttpError) {
      if (error.status === 429) return { kind: 'RATE_LIMITED', retryAfterMs: error.retryAfterMs };
      if (error.status === 401) return { kind: 'TRANSIENT_FAILURE' };
      if (isDefinitiveUpstreamRejection(error)) return { kind: 'SAFE_REJECTION' };
    }
    return { kind: 'AMBIGUOUS' };
  }

  private async resolveMedia(
    sessionId: string,
    content: Exclude<import('../../contracts/campaigns/campaign-content.dto').CampaignContentDto, { type: 'TEXT' }>,
  ) {
    if (!this.media) throw new Error('Campaign media service is unavailable');
    const asset = await this.media.readForSend(content.mediaAssetId, sessionId);
    if (asset.kind !== MediaAssetKind.IMAGE
      || asset.filename !== content.filename
      || asset.mimeType !== content.mimeType
      || asset.byteSize !== content.byteSize
      || asset.sha256 !== content.sha256) {
      throw new Error('Campaign media asset no longer matches its immutable snapshot');
    }
    return asset;
  }

  private update(
    id: string,
    status: MessageJobStatus,
    options: { openwaMessageId?: string; error?: string; response?: unknown },
  ): Promise<void> {
    return this.database.transaction(async (client: PoolClient) => {
      await this.messages.updateResult(client, id, status, options);
      if (options.openwaMessageId && this.statusProjections) {
        await this.statusProjections.reconcilePendingForJobInTransaction(client, id);
      }
    });
  }
}

type ConnectorImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

function connectorImageMimeType(value: string): ConnectorImageMimeType {
  if (value === 'image/jpeg' || value === 'image/png' || value === 'image/webp') return value;
  throw new Error(`Campaign image MIME type is not supported by the connector: ${value}`);
}

function isRetryableMediaRelayFailure(error: unknown): boolean {
  if (error instanceof EventInboxMediaHttpError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError
    || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
}

function mediaRelayRetryDelayMs(error: unknown): number {
  return error instanceof EventInboxMediaHttpError && error.status === 429 ? 30_000 : 5_000;
}
