import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { z } from 'zod';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { readBoundedResponseJson } from '../../core/http/bounded-response';

const healthSchema = z.object({ version: z.string().min(1) });
const sessionsSchema = z.array(z.object({ id: z.uuid() }).passthrough()).max(1000);
@Injectable()
export class EventInboxOpenWAClient implements OnModuleDestroy {
  private readonly abort = new AbortController();

  constructor(
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  onModuleDestroy(): void {
    this.abort.abort();
  }

  async validateCredentials(openwaBaseUrl: string, apiKey: string): Promise<string[]> {
    const origin = new URL(openwaBaseUrl).origin;
    if (origin !== this.config.EVENT_INBOX_OPENWA_BASE_URL) {
      throw new Error('OpenWA origin is not configured for this Event Inbox');
    }
    const headers = { accept: 'application/json', 'x-api-key': apiKey };
    const health = await this.request('/api/health', headers, healthSchema);
    if (health.version !== this.config.EVENT_INBOX_OPENWA_RELEASE_TAG) {
      throw new Error('OpenWA release is incompatible with this Event Inbox');
    }
    const sessions = await this.request('/api/sessions?limit=1000', headers, sessionsSchema);
    const configured = new Set(this.config.EVENT_INBOX_ALLOWED_SESSION_IDS);
    const authorized = sessions.map(session => session.id).filter(id => configured.has(id));
    if (authorized.length === 0) throw new Error('No configured OpenWA sessions are available');
    return authorized;
  }

  private async request<T>(
    path: string,
    headers: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await fetch(new URL(path, this.config.EVENT_INBOX_OPENWA_BASE_URL), {
      headers,
      redirect: 'error',
      signal: AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(this.config.EVENT_INBOX_OPENWA_REQUEST_TIMEOUT_MS),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenWA credential probe returned HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(
      await readBoundedResponseJson(response, this.config.EVENT_INBOX_OPENWA_RESPONSE_MAX_BYTES),
    );
    if (!parsed.success) throw new Error('OpenWA credential probe returned an invalid response');
    return parsed.data;
  }
}
