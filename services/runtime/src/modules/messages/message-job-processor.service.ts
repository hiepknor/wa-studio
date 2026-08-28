import { Inject, Injectable, Optional } from '@nestjs/common';
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

const randomDelay = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

const isDefinitiveUpstreamRejection = (error: unknown): boolean =>
  error instanceof OpenWAHttpError
  && error.status >= 400
  && error.status < 500
  && error.status !== 408;

const isSafeRetryableUpstreamRejection = (error: unknown): error is OpenWAHttpError =>
  error instanceof OpenWAHttpError && [409, 429].includes(error.status);

@Injectable()
export class MessageJobProcessorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly messages: MessageJobRepository,
    private readonly policy: MessageSendPolicyService,
    private readonly openwa: OpenWAClient,
    private readonly gateway: GatewayRepository,
    private readonly outboundSessions: OutboundSessionLeaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
    @Optional() private readonly media?: MediaAssetService,
    @Optional() private readonly mediaBudget?: MediaSendBudgetService,
  ) {}

  async process(payload: MessageSendQueuePayload): Promise<unknown> {
    const job = await this.messages.markProcessing(payload.messageJobId);
    if (!job) return { skipped: true };

    let upstreamStarted = false;
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
      return await this.outboundSessions.withLease(
        job.sessionId,
        job.id,
        async verifyForSend => {
          await new Promise(resolve =>
            setTimeout(resolve, randomDelay(this.config.OUTBOUND_MIN_DELAY_MS, this.config.OUTBOUND_MAX_DELAY_MS)),
          );
          const blockReason = await this.policy.liveBlockReason(job.sessionId, job.recipientId);
          if (blockReason) throw new Error(`Live send blocked: ${blockReason}`);
          const result = job.payload.type === CampaignContentType.TEXT
            ? await this.sendTextAfterVerify(
                job.sessionId,
                job.recipientId,
                job.payload.text,
                verifyForSend,
                () => {
                upstreamStarted = true;
                },
              )
            : await this.sendImage(job.sessionId, job.recipientId, job.payload, verifyForSend, () => {
                upstreamStarted = true;
              });
          await this.update(job.id, 'ACCEPTED', { openwaMessageId: result.messageId, response: result });
          return result;
        },
      );
    } catch (error) {
      if (error instanceof MessageJobNoLongerProcessingError) return { skipped: true };
      if (upstreamStarted && isSafeRetryableUpstreamRejection(error)
        && job.attemptCount < this.config.MESSAGE_SAFE_RETRY_MAX_ATTEMPTS) {
        const description = `OpenWA HTTP ${error.status} rejected before acceptance; retry scheduled`;
        const delayMs = error.retryAfterMs ?? 5_000;
        await this.database.transaction((client: PoolClient) =>
          this.messages.rescheduleProcessing(client, job.id, description, delayMs));
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
      if (error instanceof OpenWAHttpError && job.recipientId.endsWith('@g.us')) {
        if (error.status === 403) {
          await this.gateway.invalidateGroupCapability(job.sessionId, job.recipientId, 'GATEWAY_PERMISSION_DENIED');
        } else if (error.status === 404) {
          await this.gateway.invalidateGroupCapability(job.sessionId, job.recipientId, 'GROUP_CHANGED');
        }
      }
      throw error;
    }
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

  private async sendTextAfterVerify(
    sessionId: string,
    recipientId: string,
    text: string,
    verifyForSend: () => Promise<void>,
    onUpstreamStart: () => void,
  ) {
    await verifyForSend();
    onUpstreamStart();
    return this.openwa.sendText(sessionId, recipientId, text);
  }

  private async sendImage(
    sessionId: string,
    recipientId: string,
    content: Exclude<import('../../contracts/campaigns/campaign-content.dto').CampaignContentDto, { type: 'TEXT' }>,
    verifyForSend: () => Promise<void>,
    onUpstreamStart: () => void,
  ) {
    const operation = async () => {
      const asset = await this.resolveMedia(sessionId, content);
      await verifyForSend();
      onUpstreamStart();
      return this.openwa.sendImage({
        sessionId,
        chatId: recipientId,
        base64: asset.content.toString('base64'),
        mimetype: asset.mimeType,
        caption: content.caption ?? '',
      });
    };
    return this.mediaBudget
      ? this.mediaBudget.withBytes(campaignImageSendMemoryWeight(content.byteSize), operation, {
          onWait: verifyForSend,
        })
      : operation();
  }

  private update(
    id: string,
    status: MessageJobStatus,
    options: { openwaMessageId?: string; error?: string; response?: unknown },
  ): Promise<void> {
    return this.database.transaction((client: PoolClient) => this.messages.updateResult(client, id, status, options));
  }
}
