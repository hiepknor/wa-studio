import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CampaignContentType } from '../../src/contracts/campaigns/campaign-content.dto';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import type { DatabaseService } from '../../src/core/database/database.service';
import { OpenWAHttpError, type OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import {
  OpenWAIncompatibleReleaseError,
  type OpenWACompatibilityService,
} from '../../src/integrations/openwa/openwa-compatibility.service';
import type { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import type { MediaAssetService } from '../../src/modules/media-assets/media-asset.service';
import type { MediaSendBudgetService } from '../../src/modules/media-assets/media-send-budget.service';
import { MessageJobProcessorService } from '../../src/modules/messages/message-job-processor.service';
import type { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import type { MessageSendPolicyService } from '../../src/modules/messages/message-send-policy.service';
import type { OutboundSessionLeaseService } from '../../src/modules/messages/outbound-session-lease.service';
import type { MessageStatusProjectionService } from '../../src/modules/messages/message-status-projection.service';
import type { OpenWASafetyGovernorService } from '../../src/integrations/openwa/safety/openwa-safety-governor.service';
import type {
  CommittedOpenWAMessagePermit,
  OpenWAMessagePermit,
} from '../../src/integrations/openwa/safety/openwa-safety.types';

const governedSafety = () => ({
  reserveMessage: vi.fn(async (input: {
    sessionId: string;
    messageJobId: string;
    recipientId: string;
    operationClass: 'MESSAGE_SEND_TEXT' | 'MESSAGE_SEND_IMAGE';
  }) => ({
    outcome: 'GRANTED' as const,
    permit: {
      ...input,
      leaseToken: '11111111-1111-4111-8111-111111111111',
      permitToken: '11111111-1111-4111-8111-111111111111',
      upstreamId: 'a'.repeat(64),
      policyProfile: 'CANARY',
      policyVersion: 4,
      reservedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    } as OpenWAMessagePermit,
  })),
  commitMessageStart: vi.fn(async (permit: OpenWAMessagePermit) => ({
    ...permit,
    upstreamStartedAt: new Date(),
    upstreamAttemptNumber: 1,
  }) as CommittedOpenWAMessagePermit),
  recordOutcome: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
}) as unknown as OpenWASafetyGovernorService;

describe('MessageJobProcessorService Campaign media', () => {
  it('loads verified bytes inside the weighted budget and calls the matching OpenWA media adapter', async () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const content = {
      type: CampaignContentType.IMAGE,
      mediaAssetId: '22222222-2222-4222-8222-222222222222',
      caption: 'Release notes',
      filename: 'release.png',
      mimeType: 'image/png',
      byteSize: 8,
      sha256: createHash('sha256').update(imageBytes).digest('hex'),
    } as const;
    const job = {
      id: 'job-id', idempotencyKey: 'key', sessionId: 'session-id', recipientId: 'group@g.us',
      payload: content, scheduledAt: new Date(), status: 'PROCESSING' as const,
      dryRun: false, attemptCount: 1, openwaMessageId: null, lastError: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const client = {} as never;
    const messages = {
      markProcessing: vi.fn().mockResolvedValue(job),
      updateResult: vi.fn().mockResolvedValue(undefined),
    };
    const database = {
      transaction: vi.fn(async (operation: (transactionClient: never) => Promise<unknown>) => operation(client)),
    };
    const openwa = {
      sendImage: vi.fn().mockResolvedValue({ messageId: 'openwa-id', timestamp: 1 }),
      sendText: vi.fn(),
    };
    const media = {
      readForSend: vi.fn().mockResolvedValue({
        id: content.mediaAssetId,
        sessionId: job.sessionId,
        kind: 'IMAGE',
        filename: content.filename,
        mimeType: content.mimeType,
        byteSize: content.byteSize,
        sha256: content.sha256,
        content: imageBytes,
        createdAt: new Date(),
      }),
    };
    const budget = {
      withBytes: vi.fn(async (_bytes: number, operation: () => Promise<unknown>) => operation()),
    };
    const statusProjections = {
      reconcilePendingForJobInTransaction: vi.fn().mockResolvedValue(1),
    };
    const processor = new MessageJobProcessorService(
      database as unknown as DatabaseService,
      messages as unknown as MessageJobRepository,
      { liveBlockReason: vi.fn().mockResolvedValue(null) } as unknown as MessageSendPolicyService,
      openwa as unknown as OpenWAClient,
      {} as GatewayRepository,
      {
        withLease: vi.fn(async (_sessionId, _jobId, operation) => operation(vi.fn().mockResolvedValue(undefined))),
      } as unknown as OutboundSessionLeaseService,
      {
        ...parseRuntimeConfig({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
          REDIS_URL: 'redis://redis.test:6379',
          RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
          OPENWA_BASE_URL: 'http://openwa.test:2785',
          OPENWA_API_KEY: 'openwa-key',
          OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
          OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
        }),
        ALLOW_LIVE_SENDS: true,
        OUTBOUND_MIN_DELAY_MS: 0,
        OUTBOUND_MAX_DELAY_MS: 0,
      },
      media as unknown as MediaAssetService,
      budget as unknown as MediaSendBudgetService,
      statusProjections as unknown as MessageStatusProjectionService,
      undefined,
      governedSafety(),
    );

    await expect(processor.process({ messageJobId: job.id }))
      .resolves.toEqual({ messageId: 'openwa-id', timestamp: 1 });

    expect(budget.withBytes).toHaveBeenCalledWith(
      content.byteSize * 4,
      expect.any(Function),
      { onWait: expect.any(Function) },
    );
    expect(media.readForSend).toHaveBeenCalledWith(content.mediaAssetId, job.sessionId);
    expect(openwa.sendImage).toHaveBeenCalledWith(
      expect.objectContaining({ operationClass: 'MESSAGE_SEND_IMAGE', upstreamAttemptNumber: 1 }),
      {
        sessionId: job.sessionId,
        chatId: job.recipientId,
        base64: imageBytes.toString('base64'),
        mimetype: content.mimeType,
        caption: content.caption,
      },
    );
    expect(messages.updateResult).toHaveBeenCalledWith(
      client,
      job.id,
      'ACCEPTED',
      expect.objectContaining({ openwaMessageId: 'openwa-id' }),
    );
    expect(statusProjections.reconcilePendingForJobInTransaction).toHaveBeenCalledWith(client, job.id);
  });

  it('durably reschedules an explicit rate-limit rejection without treating the send outcome as unknown', async () => {
    const client = {} as never;
    const job = {
      id: 'job-id', idempotencyKey: 'key', sessionId: 'session-id', recipientId: 'group@g.us',
      payload: { type: CampaignContentType.TEXT, text: 'hello' },
      scheduledAt: new Date(), status: 'PROCESSING' as const,
      dryRun: false, attemptCount: 1, openwaMessageId: null, lastError: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const messages = {
      markProcessing: vi.fn().mockResolvedValue(job),
      rescheduleProcessing: vi.fn().mockResolvedValue(true),
      updateResult: vi.fn(),
    };
    const processor = new MessageJobProcessorService(
      {
        transaction: vi.fn(async (operation: (transactionClient: never) => Promise<unknown>) => operation(client)),
      } as unknown as DatabaseService,
      messages as unknown as MessageJobRepository,
      { liveBlockReason: vi.fn().mockResolvedValue(null) } as unknown as MessageSendPolicyService,
      {
        sendText: vi.fn().mockRejectedValue(new OpenWAHttpError(429, 'limited', 1_250)),
      } as unknown as OpenWAClient,
      {} as GatewayRepository,
      {
        withLease: vi.fn(async (_sessionId, _jobId, operation) => operation(vi.fn().mockResolvedValue(undefined))),
      } as unknown as OutboundSessionLeaseService,
      {
        ...parseRuntimeConfig({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
          REDIS_URL: 'redis://redis.test:6379',
          RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
          OPENWA_BASE_URL: 'http://openwa.test:2785',
          OPENWA_API_KEY: 'openwa-key',
          OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
          OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
        }),
        ALLOW_LIVE_SENDS: true,
        OUTBOUND_MIN_DELAY_MS: 0,
        OUTBOUND_MAX_DELAY_MS: 0,
      },
      undefined, undefined, undefined, undefined, governedSafety(),
    );

    await expect(processor.process({ messageJobId: job.id }))
      .resolves.toEqual({ retryScheduled: true, delayMs: 1_250 });
    expect(messages.rescheduleProcessing).toHaveBeenCalledWith(
      client, job.id, 'OpenWA HTTP 429 rejected before acceptance; retry scheduled', 1_250,
    );
    expect(messages.updateResult).not.toHaveBeenCalled();
  });

  it('fails safely before the send starts when the reviewed OpenWA release no longer matches', async () => {
    const client = {} as never;
    const job = {
      id: 'job-id', idempotencyKey: 'key', sessionId: 'session-id', recipientId: 'group@g.us',
      payload: { type: CampaignContentType.TEXT, text: 'hello' },
      scheduledAt: new Date(), status: 'PROCESSING' as const,
      dryRun: false, attemptCount: 1, openwaMessageId: null, lastError: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const messages = {
      markProcessing: vi.fn().mockResolvedValue(job),
      updateResult: vi.fn().mockResolvedValue(undefined),
    };
    const sendText = vi.fn();
    const compatibilityFailure = new OpenWAIncompatibleReleaseError({
      status: 'INCOMPATIBLE',
      expectedRelease: '0.22.0',
      observedRelease: '0.23.0',
      checkedAt: '2026-08-29T00:00:00.000Z',
      lastSuccessfulAt: null,
      reason: 'release_mismatch',
    });
    const compatibility = {
      requireCompatible: vi.fn().mockRejectedValue(compatibilityFailure),
    };
    const processor = new MessageJobProcessorService(
      {
        transaction: vi.fn(async (operation: (transactionClient: never) => Promise<unknown>) => operation(client)),
      } as unknown as DatabaseService,
      messages as unknown as MessageJobRepository,
      { liveBlockReason: vi.fn().mockResolvedValue(null) } as unknown as MessageSendPolicyService,
      { sendText } as unknown as OpenWAClient,
      {} as GatewayRepository,
      {
        withLease: vi.fn(async (_sessionId, _jobId, operation) => operation(vi.fn().mockResolvedValue(undefined))),
      } as unknown as OutboundSessionLeaseService,
      {
        ...parseRuntimeConfig({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
          REDIS_URL: 'redis://redis.test:6379',
          RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
          OPENWA_BASE_URL: 'http://openwa.test:2785',
          OPENWA_API_KEY: 'openwa-key',
          OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
          OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
        }),
        ALLOW_LIVE_SENDS: true,
        OUTBOUND_MIN_DELAY_MS: 0,
        OUTBOUND_MAX_DELAY_MS: 0,
      },
      undefined,
      undefined,
      undefined,
      compatibility as unknown as OpenWACompatibilityService,
      governedSafety(),
    );

    await expect(processor.process({ messageJobId: job.id })).rejects.toBe(compatibilityFailure);
    expect(sendText).not.toHaveBeenCalled();
    expect(messages.updateResult).toHaveBeenCalledWith(
      client,
      job.id,
      'FAILED',
      { error: 'OpenWA release mismatch: expected 0.22.0, received 0.23.0' },
    );
  });
});
