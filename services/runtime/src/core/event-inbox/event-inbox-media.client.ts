import { Inject, Injectable } from '@nestjs/common';
import {
  eventInboxMediaLeaseResponseSchema,
  type EventInboxMediaLeaseResponse,
} from '../../contracts/event-inbox';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { readBoundedResponseJson, readBoundedResponseText } from '../http/bounded-response';

const maximumMediaRelayResponseBytes = 64 * 1024;

export class EventInboxMediaHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'EventInboxMediaHttpError';
  }
}

@Injectable()
export class EventInboxMediaClient {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async put(input: {
    attemptId: string;
    sessionId: string;
    filename: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    sha256: string;
    expiresAt: Date;
    content: Buffer;
  }): Promise<EventInboxMediaLeaseResponse> {
    if (!this.config.EVENT_INBOX_BASE_URL || !this.config.EVENT_INBOX_DEVICE_TOKEN) {
      throw new Error('Event Inbox media relay is not configured');
    }
    const response = await fetch(new URL(
      `/api/v1/event-inbox/media/${encodeURIComponent(input.attemptId)}`,
      this.config.EVENT_INBOX_BASE_URL,
    ), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.config.EVENT_INBOX_DEVICE_TOKEN}`,
        'content-type': input.mimeType,
        'content-length': String(input.content.length),
        'x-wa-session-id': input.sessionId,
        'x-wa-content-sha256': input.sha256,
        'x-wa-filename-b64': Buffer.from(input.filename, 'utf8').toString('base64url'),
        'x-wa-expires-at': input.expiresAt.toISOString(),
      },
      body: input.content,
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.EVENT_INBOX_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new EventInboxMediaHttpError(
        response.status,
        `Event Inbox media upload returned HTTP ${response.status}: ${await readBoundedResponseText(
          response,
          maximumMediaRelayResponseBytes,
        )}`,
      );
    }
    const parsed = eventInboxMediaLeaseResponseSchema.safeParse(
      await readBoundedResponseJson(response, maximumMediaRelayResponseBytes),
    );
    if (!parsed.success) throw new Error('Event Inbox returned an invalid media lease');
    const lease = parsed.data;
    if (lease.attemptId !== input.attemptId
      || lease.sessionId !== input.sessionId
      || lease.filename !== input.filename
      || lease.mimeType !== input.mimeType
      || lease.byteSize !== input.content.length
      || lease.sha256 !== input.sha256
      || lease.expiresAt !== input.expiresAt.toISOString()) {
      throw new Error('Event Inbox media lease does not match the immutable upload');
    }
    const expectedOrigin = new URL(this.config.EVENT_INBOX_BASE_URL).origin;
    if (new URL(lease.mediaUrl).origin !== expectedOrigin) {
      throw new Error('Event Inbox media lease returned an unexpected download origin');
    }
    return lease;
  }
}
