import { z } from 'zod';
import { OPENWA_CONNECTOR_PROTOCOL_VERSION } from './openwa-connector';

export const EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION = OPENWA_CONNECTOR_PROTOCOL_VERSION;

// EVENT_INBOX_MAX_PAYLOAD_BYTES is bounded at 1 MiB. Base64 expands every three
// bytes into four characters, including padding for the final partial block.
const maximumEncodedEventBodyLength = Math.ceil(1_048_576 / 3) * 4;

export const eventInboxEventSchema = z.object({
  idempotencyKey: z.string().min(1).max(512),
  receiptHandle: z.string().min(1).max(2048),
  rawBody: z.base64().max(maximumEncodedEventBodyLength),
  signature: z.string().min(1).max(512),
});

export const eventInboxClaimResponseSchema = z.object({
  data: z.array(eventInboxEventSchema).max(100),
});

export const eventInboxClaimSchema = z.object({
  limit: z.number().int().min(1).max(100).default(100),
  waitSeconds: z.number().int().min(0).max(25).default(20),
});

export const eventInboxAckSchema = z.object({
  receiptHandles: z.array(z.string().min(1).max(2048)).min(1).max(100),
});

export const eventInboxNackSchema = z.object({
  items: z.array(z.object({
    receiptHandle: z.string().min(1).max(2048),
    disposition: z.enum(['retry', 'dead']),
    reason: z.string().trim().min(1).max(256).optional(),
  })).min(1).max(100),
});

export const eventInboxPairingRequestSchema = z.object({
  openwaBaseUrl: z.url().max(2048),
  openwaApiKey: z.string().min(1).max(4096),
  deviceId: z.uuid(),
});

export const eventInboxPairingResponseSchema = z.object({
  protocolVersion: z.literal(2),
  eventInboxBaseUrl: z.url(),
  callbackUrl: z.url(),
  deviceToken: z.string().min(32).max(4096),
  webhookSecret: z.string().min(32).max(4096),
  sessionIds: z.array(z.uuid()).min(1).max(1000),
});

export const openWAWebhookEnvelopeSchema = z.object({
  event: z.string().min(1).max(256),
  timestamp: z.string().min(1).max(128),
  sessionId: z.uuid(),
  idempotencyKey: z.string().min(1).max(512),
  deliveryId: z.string().min(1).max(512),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

export const eventInboxConnectorProvisionSchema = z.object({
  sessionIds: z.array(z.uuid()).length(1),
});

export const eventInboxPreparedConnectorCredentialSchema = z.object({
  sessionIds: z.array(z.uuid()).length(1),
  secretSha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

export const eventInboxConnectorGenerationSchema = z.coerce.number().int().positive().safe();

export const eventInboxConnectorIdentitySchema = z.object({
  connectorId: z.uuid(),
});

export const eventInboxConnectorBindingSchema = z.object({
  connectorId: z.uuid(),
  webhookId: z.string().trim().min(1).max(512),
  generation: z.number().int().positive().safe(),
});

const connectorSessionHeartbeatSchema = z.object({
  sessionId: z.uuid(),
  bindingGeneration: z.number().int().nonnegative().safe(),
  pendingCount: z.number().int().nonnegative().safe(),
  oldestPendingSeconds: z.number().int().nonnegative().safe().nullable(),
  storageUtilization: z.number().min(0).max(1),
  blockedReason: z.string().trim().min(1).max(256).nullable(),
});

export const eventInboxConnectorHeartbeatSchema = z.object({
  pluginVersion: z.string().trim().min(1).max(128),
  protocolVersion: z.literal(EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION),
  journalSchemaVersion: z.number().int().positive().max(1000),
  sessions: z.array(connectorSessionHeartbeatSchema).min(1).max(1000),
});

export const eventInboxConnectorEventSchema = z.object({
  bindingGeneration: z.number().int().positive().safe(),
  envelope: openWAWebhookEnvelopeSchema,
});

export const eventInboxConnectorStatusResponseSchema = z.object({
  protocolVersion: z.literal(EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION),
  generatedAt: z.iso.datetime({ offset: true }),
  sessions: z.array(z.object({
    sessionId: z.uuid(),
    binding: z.object({
      connectorId: z.uuid(),
      webhookId: z.string().min(1).max(512),
      generation: z.number().int().positive().safe(),
      updatedAt: z.iso.datetime({ offset: true }),
    }).nullable(),
    connector: z.object({
      connectorId: z.uuid(),
      tokenGeneration: z.number().int().positive().safe(),
      pluginVersion: z.string().min(1).max(128),
      protocolVersion: z.number().int().positive(),
      journalSchemaVersion: z.number().int().positive(),
      bindingGeneration: z.number().int().nonnegative().safe(),
      pendingCount: z.number().int().nonnegative().safe(),
      oldestPendingSeconds: z.number().int().nonnegative().safe().nullable(),
      storageUtilization: z.number().min(0).max(1),
      blockedReason: z.string().min(1).max(256).nullable(),
      observedAt: z.iso.datetime({ offset: true }),
    }).nullable(),
  })).max(1000),
});

export const eventInboxMediaLeaseResponseSchema = z.object({
  attemptId: z.uuid(),
  sessionId: z.uuid(),
  mediaUrl: z.url(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  byteSize: z.number().int().positive().max(8_388_608),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  expiresAt: z.iso.datetime({ offset: true }),
  duplicate: z.boolean(),
}).strict();

export type EventInboxEvent = z.infer<typeof eventInboxEventSchema>;
export type EventInboxNack = z.infer<typeof eventInboxNackSchema>['items'][number];
export type EventInboxConnectorHeartbeat = z.infer<typeof eventInboxConnectorHeartbeatSchema>;
export type EventInboxConnectorStatusResponse = z.infer<typeof eventInboxConnectorStatusResponseSchema>;
export type EventInboxMediaLeaseResponse = z.infer<typeof eventInboxMediaLeaseResponseSchema>;
export type OpenWAWebhookEnvelope = z.infer<typeof openWAWebhookEnvelopeSchema>;
