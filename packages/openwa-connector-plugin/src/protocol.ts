import { createHash, randomUUID } from 'node:crypto';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import commandSchema from '@wa/runtime-contract/openwa-connector/v1/command.schema.json' with { type: 'json' };

export const PROTOCOL_VERSION = 1 as const;
export const JOURNAL_SCHEMA_VERSION = 1 as const;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface CommandIdentity {
  protocolVersion: 1;
  commandId: string;
  attemptId: string;
  sessionId: string;
  recipientId: string;
  safetyPermitId: string;
  bindingGeneration: number;
  createdAt: string;
  expiresAt: string;
}

export interface SendTextCommand extends CommandIdentity {
  operation: 'SEND_TEXT';
  content: { type: 'TEXT'; text: string };
}

export interface SendImageCommand extends CommandIdentity {
  operation: 'SEND_IMAGE';
  content: {
    type: 'IMAGE';
    filename: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    byteSize: number;
    sha256: string;
    mediaUrl: string;
    caption: string;
  };
}

export type ConnectorCommand = SendTextCommand | SendImageCommand;

export type EvidenceKind =
  | 'COMMAND_RECEIVED'
  | 'SEND_STARTED'
  | 'SEND_ACCEPTED'
  | 'SEND_REJECTED'
  | 'SEND_INDETERMINATE'
  | 'ACK_SENT'
  | 'ACK_DELIVERED'
  | 'ACK_READ'
  | 'ACK_FAILED';

export type DeliveryStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'INDETERMINATE';

export type EvidenceErrorClass =
  | 'SAFE_REJECTION'
  | 'RATE_LIMITED'
  | 'SESSION_RESTRICTED'
  | 'TRANSIENT_FAILURE'
  | 'AMBIGUOUS'
  | 'INVALID_COMMAND'
  | 'EXPIRED_COMMAND'
  | 'BINDING_MISMATCH';

export interface ConnectorEvidence {
  protocolVersion: 1;
  eventId: string;
  commandId: string;
  attemptId: string;
  sessionId: string;
  sequence: number;
  kind: EvidenceKind;
  openwaMessageId: string | null;
  deliveryStatus: DeliveryStatus;
  errorClass: EvidenceErrorClass | null;
  errorCode: string | null;
  bindingGeneration: number;
  pluginVersion: string;
  occurredAt: string;
  payloadSha256: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateCommand = ajv.compile<ConnectorCommand>(commandSchema);

export class InvalidConnectorCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConnectorCommandError';
  }
}

export function parseCommand(rawBody: string): ConnectorCommand {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new InvalidConnectorCommandError('command body is not valid JSON');
  }
  if (!validateCommand(value)) {
    throw new InvalidConnectorCommandError(`command schema mismatch: ${formatErrors(validateCommand.errors)}`);
  }
  const createdAt = new Date(value.createdAt).valueOf();
  const expiresAt = new Date(value.expiresAt).valueOf();
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
    || expiresAt <= createdAt || expiresAt - createdAt > 3_600_000) {
    throw new InvalidConnectorCommandError('command expiry window is invalid');
  }
  if (value.operation === 'SEND_IMAGE') validateMediaUrl(value.content.mediaUrl);
  return value;
}

export function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createEvidence(input: {
  command: ConnectorCommand;
  payloadSha256: string;
  pluginVersion: string;
  sequence: number;
  kind: EvidenceKind;
  deliveryStatus: DeliveryStatus;
  openwaMessageId?: string | null;
  errorClass?: EvidenceErrorClass | null;
  errorCode?: string | null;
  now?: Date;
}): ConnectorEvidence {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: randomUUID(),
    commandId: input.command.commandId,
    attemptId: input.command.attemptId,
    sessionId: input.command.sessionId,
    sequence: input.sequence,
    kind: input.kind,
    openwaMessageId: input.openwaMessageId ?? null,
    deliveryStatus: input.deliveryStatus,
    errorClass: input.errorClass ?? null,
    errorCode: input.errorCode ?? null,
    bindingGeneration: input.command.bindingGeneration,
    pluginVersion: input.pluginVersion,
    occurredAt: (input.now ?? new Date()).toISOString(),
    payloadSha256: input.payloadSha256,
  };
}

export function extractOpenWAMessageId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const messageId = (result as Record<string, unknown>).messageId;
  return typeof messageId === 'string' && messageId.trim().length > 0 && messageId.length <= 512
    ? messageId
    : null;
}

function validateMediaUrl(value: string): void {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.hash) {
    throw new InvalidConnectorCommandError('media URL must use HTTPS without credentials or fragments');
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).slice(0, 3).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
    .join('; ') || 'invalid';
}
