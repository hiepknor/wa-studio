import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { readBoundedResponseText } from '../../core/http/bounded-response';

const maximumErrorResponseBytes = 64 * 1024;

export type OpenWAConnectorIngressFailureKind =
  | 'DEFINITIVE'
  | 'RATE_LIMITED_SAFE'
  | 'AMBIGUOUS_RETRYABLE';

export class OpenWAConnectorIngressError extends Error {
  constructor(
    readonly kind: OpenWAConnectorIngressFailureKind,
    readonly status: number | null,
    readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'OpenWAConnectorIngressError';
  }
}

@Injectable()
export class OpenWAConnectorIngressClient {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async submit(input: { commandId: string; body: Buffer }): Promise<{ duplicate: boolean }> {
    const instanceId = this.config.OPENWA_CONNECTOR_INSTANCE_ID;
    const secret = this.config.OPENWA_CONNECTOR_INGRESS_SECRET;
    if (!instanceId || !secret) throw new Error('OpenWA connector ingress is not configured');
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = `sha256=${createHmac('sha256', secret)
      .update(timestamp)
      .update('.')
      .update(input.body)
      .digest('hex')}`;
    let response: Response;
    try {
      response = await fetch(new URL(
        `/api/ingress/${encodeURIComponent(this.config.OPENWA_CONNECTOR_PLUGIN_ID)}/${encodeURIComponent(instanceId)}/commands`,
        this.config.OPENWA_BASE_URL,
      ), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': String(input.body.length),
          'x-wa-signature': signature,
          'x-wa-timestamp': timestamp,
          'x-delivery': input.commandId,
        },
        body: input.body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.OPENWA_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OpenWAConnectorIngressError(
        'AMBIGUOUS_RETRYABLE',
        null,
        null,
        `OpenWA connector ingress did not acknowledge the command: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 200 || response.status === 202) {
      await response.body?.cancel();
      return { duplicate: response.status === 200 };
    }
    const responseText = await readBoundedResponseText(response, maximumErrorResponseBytes);
    if (response.status === 429) {
      throw new OpenWAConnectorIngressError(
        'RATE_LIMITED_SAFE',
        response.status,
        retryAfterMilliseconds(response.headers),
        `OpenWA connector ingress rate limited the command: ${responseText}`,
      );
    }
    if (response.status >= 500 || response.status === 408) {
      throw new OpenWAConnectorIngressError(
        'AMBIGUOUS_RETRYABLE',
        response.status,
        retryAfterMilliseconds(response.headers),
        `OpenWA connector ingress returned an ambiguous HTTP ${response.status}: ${responseText}`,
      );
    }
    throw new OpenWAConnectorIngressError(
      'DEFINITIVE',
      response.status,
      null,
      `OpenWA connector ingress rejected the command with HTTP ${response.status}: ${responseText}`,
    );
  }
}

function retryAfterMilliseconds(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 3_600_000);
  const date = new Date(raw).valueOf();
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 3_600_000)) : null;
}
