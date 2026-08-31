import type { ConnectorConfig } from './config';
import type { ConnectorBinding } from './bindings';
import type { CommandRecord, JournalStats } from './journal';
import type { PluginNetCapability, PluginNetResponse } from './openwa';
import { JOURNAL_SCHEMA_VERSION, PROTOCOL_VERSION, type SendImageCommand } from './protocol';

const requestTimeoutMs = 5_000;

export class EventInboxRequestError extends Error {
  constructor(
    readonly operation: 'heartbeat' | 'evidence' | 'media',
    readonly status: number | null,
    readonly persistent: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'EventInboxRequestError';
  }
}

export class EventInboxClient {
  constructor(
    private readonly net: PluginNetCapability,
    private readonly config: () => ConnectorConfig,
    private readonly pluginVersion: string,
  ) {}

  async heartbeat(
    stats: JournalStats,
    bindingGeneration: number,
    blockedReason: string | null,
  ): Promise<ConnectorBinding[]> {
    const config = this.config();
    const response = await this.request('heartbeat', '/api/v1/event-inbox/connectors/heartbeat', {
      method: 'POST',
      headers: this.jsonHeaders(config.connectorToken),
      body: JSON.stringify({
        pluginVersion: this.pluginVersion,
        protocolVersion: PROTOCOL_VERSION,
        journalSchemaVersion: JOURNAL_SCHEMA_VERSION,
        sessions: [{
          sessionId: config.sessionId,
          bindingGeneration,
          pendingCount: stats.pendingCount,
          oldestPendingSeconds: stats.oldestPendingSeconds,
          storageUtilization: stats.storageUtilization,
          blockedReason,
        }],
      }),
    });
    const body = parseJsonObject(response.body, 'heartbeat');
    if (body.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(body.bindings)) {
      throw new EventInboxRequestError('heartbeat', response.status, true, 'invalid heartbeat response');
    }
    return body.bindings.map(value => parseBinding(
      value,
      config.connectorId,
      config.sessionId,
    ));
  }

  async postEvidence(record: CommandRecord, eventIndex: number): Promise<void> {
    const entry = record.evidence[eventIndex];
    if (!entry) throw new Error('connector evidence index is missing');
    const evidence = entry.evidence;
    const config = this.config();
    const response = await this.request('evidence', '/api/v1/event-inbox/connectors/events', {
      method: 'POST',
      headers: this.jsonHeaders(config.connectorToken),
      body: JSON.stringify({
        bindingGeneration: evidence.bindingGeneration,
        envelope: {
          event: 'wa-studio.connector.evidence',
          timestamp: evidence.occurredAt,
          sessionId: evidence.sessionId,
          idempotencyKey: `${evidence.eventId}_${record.webhookId}`,
          deliveryId: evidence.eventId,
          data: evidence,
        },
      }),
    });
    const body = parseJsonObject(response.body, 'evidence');
    if (body.accepted !== true || (body.duplicate !== true && body.duplicate !== false)) {
      throw new EventInboxRequestError('evidence', response.status, true, 'invalid evidence response');
    }
  }

  async verifyMedia(command: SendImageCommand): Promise<void> {
    const config = this.config();
    const mediaUrl = new URL(command.content.mediaUrl);
    if (mediaUrl.origin !== new URL(config.eventInboxBaseUrl).origin) {
      throw new EventInboxRequestError('media', null, true, 'media origin does not match Event Inbox');
    }
    const response = await this.requestAbsolute('media', mediaUrl.toString(), {
      method: 'HEAD',
      headers: { accept: command.content.mimeType },
    });
    const byteSize = Number(header(response, 'content-length'));
    const mimeType = header(response, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    const sha256 = header(response, 'x-wa-content-sha256');
    if (!Number.isSafeInteger(byteSize) || byteSize !== command.content.byteSize
      || mimeType !== command.content.mimeType || sha256 !== command.content.sha256) {
      throw new EventInboxRequestError('media', response.status, true, 'media metadata does not match command');
    }
  }

  private jsonHeaders(token: string): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
  }

  private request(
    operation: 'heartbeat' | 'evidence',
    path: string,
    init: Parameters<PluginNetCapability['fetch']>[1],
  ): Promise<PluginNetResponse> {
    return this.requestAbsolute(operation, new URL(path, this.config().eventInboxBaseUrl).toString(), init);
  }

  private async requestAbsolute(
    operation: 'heartbeat' | 'evidence' | 'media',
    url: string,
    init: Parameters<PluginNetCapability['fetch']>[1],
  ): Promise<PluginNetResponse> {
    let response: PluginNetResponse;
    try {
      response = await this.net.fetch(url, { ...init, timeoutMs: requestTimeoutMs });
    } catch (error) {
      throw new EventInboxRequestError(
        operation,
        null,
        false,
        `${operation} request failed: ${safeErrorCode(error)}`,
      );
    }
    if (!response.ok) {
      const persistent = [400, 401, 403, 409, 422].includes(response.status);
      throw new EventInboxRequestError(
        operation,
        response.status,
        persistent,
        `${operation} request returned HTTP ${response.status}`,
      );
    }
    return response;
  }
}

function parseBinding(value: unknown, connectorId: string, sessionId: string): ConnectorBinding {
  if (!value || typeof value !== 'object') throw invalidBinding();
  const binding = value as Record<string, unknown>;
  if (binding.sessionId !== sessionId || binding.connectorId !== connectorId
    || typeof binding.webhookId !== 'string' || binding.webhookId.length < 1 || binding.webhookId.length > 512
    || !Number.isSafeInteger(binding.generation) || Number(binding.generation) < 1
    || typeof binding.updatedAt !== 'string' || !Number.isFinite(new Date(binding.updatedAt).valueOf())) {
    throw invalidBinding();
  }
  return {
    sessionId,
    connectorId,
    webhookId: binding.webhookId,
    generation: Number(binding.generation),
    updatedAt: binding.updatedAt,
  };
}

function invalidBinding(): EventInboxRequestError {
  return new EventInboxRequestError('heartbeat', 200, true, 'heartbeat returned an invalid binding');
}

function parseJsonObject(body: string, operation: 'heartbeat' | 'evidence'): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new EventInboxRequestError(operation, 200, true, `${operation} returned invalid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EventInboxRequestError(operation, 200, true, `${operation} returned an invalid object`);
  }
  return value as Record<string, unknown>;
}

function header(response: PluginNetResponse, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(name) ? name : 'ERROR';
}
