import { z } from 'zod';

export const OPENWA_CONNECTOR_PROTOCOL_VERSION = 1 as const;
export const OPENWA_CONNECTOR_JOURNAL_SCHEMA_VERSION = 1 as const;
export const OPENWA_CONNECTOR_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const instantSchema = z.iso.datetime({ offset: true });
const mediaUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.hash) {
    context.addIssue({
      code: 'custom',
      message: 'Connector media URLs must use HTTPS without credentials or fragments',
    });
  }
});

const connectorCommandIdentitySchema = z.object({
  protocolVersion: z.literal(OPENWA_CONNECTOR_PROTOCOL_VERSION),
  commandId: z.uuid(),
  attemptId: z.uuid(),
  sessionId: z.uuid(),
  recipientId: z.string().trim().min(1).max(256).regex(/@g\.us$/u),
  safetyPermitId: z.uuid(),
  bindingGeneration: z.number().int().positive().safe(),
  createdAt: instantSchema,
  expiresAt: instantSchema,
}).strict();

const textContentSchema = z.object({
  type: z.literal('TEXT'),
  text: z.string().min(1).max(65_536),
}).strict();

const imageContentSchema = z.object({
  type: z.literal('IMAGE'),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  byteSize: z.number().int().positive().max(OPENWA_CONNECTOR_MAX_IMAGE_BYTES),
  sha256: sha256Schema,
  mediaUrl: mediaUrlSchema,
  caption: z.string().max(1_024),
}).strict();

export const openWAConnectorCommandSchema = z.discriminatedUnion('operation', [
  connectorCommandIdentitySchema.extend({
    operation: z.literal('SEND_TEXT'),
    content: textContentSchema,
  }).strict(),
  connectorCommandIdentitySchema.extend({
    operation: z.literal('SEND_IMAGE'),
    content: imageContentSchema,
  }).strict(),
]).superRefine((command, context) => {
  const createdAt = new Date(command.createdAt).valueOf();
  const expiresAt = new Date(command.expiresAt).valueOf();
  if (expiresAt <= createdAt || expiresAt - createdAt > 3_600_000) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Connector commands must expire after creation and within one hour',
    });
  }
});

export const openWAConnectorEvidenceKindSchema = z.enum([
  'COMMAND_RECEIVED',
  'SEND_STARTED',
  'SEND_ACCEPTED',
  'SEND_REJECTED',
  'SEND_INDETERMINATE',
  'ACK_SENT',
  'ACK_DELIVERED',
  'ACK_READ',
  'ACK_FAILED',
]);

export const openWAConnectorDeliveryStatusSchema = z.enum([
  'PENDING',
  'ACCEPTED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'INDETERMINATE',
]);

export const openWAConnectorErrorClassSchema = z.enum([
  'SAFE_REJECTION',
  'RATE_LIMITED',
  'SESSION_RESTRICTED',
  'TRANSIENT_FAILURE',
  'AMBIGUOUS',
  'INVALID_COMMAND',
  'EXPIRED_COMMAND',
  'BINDING_MISMATCH',
]);

export const openWAConnectorEvidenceSchema = z.object({
  protocolVersion: z.literal(OPENWA_CONNECTOR_PROTOCOL_VERSION),
  eventId: z.uuid(),
  commandId: z.uuid(),
  attemptId: z.uuid(),
  sessionId: z.uuid(),
  sequence: z.number().int().positive().safe(),
  kind: openWAConnectorEvidenceKindSchema,
  openwaMessageId: z.string().trim().min(1).max(512).nullable(),
  deliveryStatus: openWAConnectorDeliveryStatusSchema,
  errorClass: openWAConnectorErrorClassSchema.nullable(),
  errorCode: z.string().trim().min(1).max(128).nullable(),
  bindingGeneration: z.number().int().positive().safe(),
  pluginVersion: z.string().trim().min(1).max(128),
  occurredAt: instantSchema,
  payloadSha256: sha256Schema,
}).strict();

export type OpenWAConnectorCommand = z.infer<typeof openWAConnectorCommandSchema>;
export type OpenWAConnectorEvidence = z.infer<typeof openWAConnectorEvidenceSchema>;
export type OpenWAConnectorEvidenceKind = z.infer<typeof openWAConnectorEvidenceKindSchema>;
