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
import { openWAConnectorCommandSchema } from '../../src/contracts/openwa-connector';
import type { EventInboxMediaClient } from '../../src/core/event-inbox/event-inbox-media.client';
import type { OpenWAConnectorCommandDispatcherService } from '../../src/modules/messages/openwa-connector-command-dispatcher.service';

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
  it('commits and dispatches an immutable connector command without calling direct OpenWA send', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const messageJobId = '00000000-0000-4000-8000-000000000002';
    const job = {
      id: messageJobId, idempotencyKey: 'key', sessionId, recipientId: '120363000000000000@g.us',
      payload: { type: CampaignContentType.TEXT, text: 'connector hello' },
      scheduledAt: new Date(), status: 'PROCESSING' as const,
      dryRun: false, claimCount: 1, attemptCount: 0, currentUpstreamStartedAt: null,
      safetyPolicyVersion: null, cancellationRequestedAt: null,
      openwaMessageId: null, lastError: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const permit = {
      leaseToken: '11111111-1111-4111-8111-111111111111',
      permitToken: '11111111-1111-4111-8111-111111111111',
      upstreamId: 'a'.repeat(64),
      sessionId,
      messageJobId,
      recipientId: job.recipientId,
      operationClass: 'MESSAGE_SEND_TEXT' as const,
      policyProfile: 'CANARY' as const,
      policyVersion: 5,
      reservedAt: new Date(),
      expiresAt: new Date(Date.now() + 360_000),
    };
    const safety = {
      reserveMessage: vi.fn().mockResolvedValue({ outcome: 'GRANTED', permit }),
      requireHealthyConnectorBindingGeneration: vi.fn().mockResolvedValue(7),
      commitMessageStart: vi.fn(async (_permit: OpenWAMessagePermit, command) => ({
        ...permit,
        attemptId: command.attemptId,
        commandId: command.commandId,
        bindingGeneration: command.bindingGeneration,
        upstreamStartedAt: new Date(),
        upstreamAttemptNumber: 1,
      })),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const messages = {
      markProcessing: vi.fn().mockResolvedValue(job),
      updateResult: vi.fn(),
      deferProcessing: vi.fn(),
    };
    const openwa = { sendText: vi.fn(), sendImage: vi.fn() };
    const connectorCommands = { dispatchAttempt: vi.fn().mockResolvedValue(true) };
    const processor = new MessageJobProcessorService(
      { transaction: vi.fn() } as unknown as DatabaseService,
      messages as unknown as MessageJobRepository,
      { liveBlockReason: vi.fn().mockResolvedValue(null) } as unknown as MessageSendPolicyService,
      openwa as unknown as OpenWAClient,
      {} as GatewayRepository,
      {} as OutboundSessionLeaseService,
      parseRuntimeConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
        REDIS_URL: 'redis://redis.test:6379',
        RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
        OPENWA_BASE_URL: 'http://openwa.test:2785',
        OPENWA_API_KEY: 'openwa-key',
        OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
        OPENWA_ALLOWED_SESSION_IDS: sessionId,
        ALLOW_LIVE_SENDS: 'true',
        EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
        EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
        EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS: 'true',
        OPENWA_WEBHOOK_RECONCILIATION_ENABLED: 'true',
        OPENWA_WEBHOOK_CALLBACK_URL: 'http://127.0.0.1:34200/api/v1/webhooks/openwa',
        OPENWA_CONNECTOR_ID: '00000000-0000-4000-8000-000000000002',
        OPENWA_CONNECTOR_PLUGIN_VERSION: '1.0.0',
        OPENWA_CONNECTOR_INSTANCE_ID: 'runtime-test',
        OPENWA_CONNECTOR_INGRESS_SECRET: 'ingress-secret-with-at-least-32-characters',
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      safety as unknown as OpenWASafetyGovernorService,
      {} as EventInboxMediaClient,
      connectorCommands as unknown as OpenWAConnectorCommandDispatcherService,
    );

    const outcome = await processor.process({ messageJobId });

    expect(outcome).toEqual(expect.objectContaining({ queued: true, dispatched: true }));
    expect(openwa.sendText).not.toHaveBeenCalled();
    expect(openwa.sendImage).not.toHaveBeenCalled();
    expect(messages.updateResult).not.toHaveBeenCalled();
    expect(safety.commitMessageStart).toHaveBeenCalledOnce();
    const commandCommit = safety.commitMessageStart.mock.calls[0]![1];
    const command = openWAConnectorCommandSchema.parse(JSON.parse(commandCommit.commandBody.toString('utf8')));
    expect(command).toEqual(expect.objectContaining({
      commandId: commandCommit.commandId,
      attemptId: commandCommit.attemptId,
      sessionId,
      recipientId: job.recipientId,
      safetyPermitId: permit.permitToken,
      bindingGeneration: 7,
      operation: 'SEND_TEXT',
      content: { type: 'TEXT', text: 'connector hello' },
    }));
    expect(createHash('sha256').update(commandCommit.commandBody).digest('hex'))
      .toBe(commandCommit.payloadSha256);
    expect(connectorCommands.dispatchAttempt).toHaveBeenCalledWith(commandCommit.attemptId);
    expect(safety.recordOutcome).not.toHaveBeenCalled();
    expect(safety.release).not.toHaveBeenCalled();
  });

  it('relays verified image bytes and commits only the immutable media URL and digest', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000011';
    const messageJobId = '00000000-0000-4000-8000-000000000012';
    const mediaAssetId = '00000000-0000-4000-8000-000000000013';
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sha256 = createHash('sha256').update(imageBytes).digest('hex');
    const job = {
      id: messageJobId, idempotencyKey: 'image-key', sessionId,
      recipientId: '120363000000000011@g.us',
      payload: {
        type: CampaignContentType.IMAGE,
        mediaAssetId,
        caption: 'Immutable image',
        filename: 'release.png',
        mimeType: 'image/png',
        byteSize: imageBytes.length,
        sha256,
      },
      scheduledAt: new Date(), status: 'PROCESSING' as const,
      dryRun: false, claimCount: 1, attemptCount: 0, currentUpstreamStartedAt: null,
      safetyPolicyVersion: null, cancellationRequestedAt: null,
      openwaMessageId: null, lastError: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const permit = {
      leaseToken: '11111111-1111-4111-8111-111111111112',
      permitToken: '11111111-1111-4111-8111-111111111112',
      upstreamId: 'b'.repeat(64),
      sessionId,
      messageJobId,
      recipientId: job.recipientId,
      operationClass: 'MESSAGE_SEND_IMAGE' as const,
      policyProfile: 'CANARY' as const,
      policyVersion: 5,
      reservedAt: new Date(),
      expiresAt: new Date(Date.now() + 360_000),
    };
    const safety = {
      reserveMessage: vi.fn().mockResolvedValue({ outcome: 'GRANTED', permit }),
      requireHealthyConnectorBindingGeneration: vi.fn().mockResolvedValue(9),
      commitMessageStart: vi.fn(async (_permit: OpenWAMessagePermit, command) => ({
        ...permit,
        attemptId: command.attemptId,
        commandId: command.commandId,
        bindingGeneration: command.bindingGeneration,
        upstreamStartedAt: new Date(),
        upstreamAttemptNumber: 1,
      })),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const media = {
      readForSend: vi.fn().mockResolvedValue({
        id: mediaAssetId,
        sessionId,
        kind: 'IMAGE',
        filename: 'release.png',
        mimeType: 'image/png',
        byteSize: imageBytes.length,
        sha256,
        content: imageBytes,
        createdAt: new Date(),
      }),
    };
    const eventInboxMedia = {
      put: vi.fn(async (input: Parameters<EventInboxMediaClient['put']>[0]) => ({
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        mediaUrl: `http://127.0.0.1:34200/api/v1/event-inbox/media/${input.attemptId}`,
        filename: input.filename,
        mimeType: input.mimeType,
        byteSize: input.content.length,
        sha256: input.sha256,
        expiresAt: input.expiresAt.toISOString(),
        duplicate: false,
      })),
    };
    const messages = {
      markProcessing: vi.fn().mockResolvedValue(job),
      updateResult: vi.fn(),
      deferProcessing: vi.fn(),
    };
    const openwa = { sendText: vi.fn(), sendImage: vi.fn() };
    const connectorCommands = { dispatchAttempt: vi.fn().mockResolvedValue(true) };
    const processor = new MessageJobProcessorService(
      { transaction: vi.fn() } as unknown as DatabaseService,
      messages as unknown as MessageJobRepository,
      { liveBlockReason: vi.fn().mockResolvedValue(null) } as unknown as MessageSendPolicyService,
      openwa as unknown as OpenWAClient,
      {} as GatewayRepository,
      {} as OutboundSessionLeaseService,
      parseRuntimeConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
        REDIS_URL: 'redis://redis.test:6379',
        RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
        OPENWA_BASE_URL: 'http://openwa.test:2785',
        OPENWA_API_KEY: 'openwa-key',
        OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
        OPENWA_ALLOWED_SESSION_IDS: sessionId,
        ALLOW_LIVE_SENDS: 'true',
        EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
        EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
        EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS: 'true',
        OPENWA_WEBHOOK_RECONCILIATION_ENABLED: 'true',
        OPENWA_WEBHOOK_CALLBACK_URL: 'http://127.0.0.1:34200/api/v1/webhooks/openwa',
        OPENWA_CONNECTOR_ID: '00000000-0000-4000-8000-000000000002',
        OPENWA_CONNECTOR_PLUGIN_VERSION: '1.0.0',
        OPENWA_CONNECTOR_INSTANCE_ID: 'runtime-image-test',
        OPENWA_CONNECTOR_INGRESS_SECRET: 'ingress-secret-with-at-least-32-characters',
      }),
      media as unknown as MediaAssetService,
      undefined,
      undefined,
      undefined,
      safety as unknown as OpenWASafetyGovernorService,
      eventInboxMedia as unknown as EventInboxMediaClient,
      connectorCommands as unknown as OpenWAConnectorCommandDispatcherService,
    );

    await expect(processor.process({ messageJobId }))
      .resolves.toEqual(expect.objectContaining({ queued: true, dispatched: true }));

    expect(media.readForSend).toHaveBeenCalledWith(mediaAssetId, sessionId);
    expect(eventInboxMedia.put).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      filename: 'release.png',
      mimeType: 'image/png',
      sha256,
      content: imageBytes,
    }));
    const commandCommit = safety.commitMessageStart.mock.calls[0]![1];
    const commandBody = commandCommit.commandBody.toString('utf8');
    const command = openWAConnectorCommandSchema.parse(JSON.parse(commandBody));
    expect(command).toEqual(expect.objectContaining({
      operation: 'SEND_IMAGE',
      content: {
        type: 'IMAGE',
        filename: 'release.png',
        mimeType: 'image/png',
        byteSize: imageBytes.length,
        sha256,
        mediaUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:34200\//u),
        caption: 'Immutable image',
      },
    }));
    expect(commandBody).not.toContain(imageBytes.toString('base64'));
    expect(commandBody).not.toContain('base64');
    expect(createHash('sha256').update(commandCommit.commandBody).digest('hex'))
      .toBe(commandCommit.payloadSha256);
    expect(openwa.sendText).not.toHaveBeenCalled();
    expect(openwa.sendImage).not.toHaveBeenCalled();
  });

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
