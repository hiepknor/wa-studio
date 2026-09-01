import type {
  HookContext,
  HookEvent,
  HookResult,
  PluginContext,
  PluginNetResponse,
  PluginStorage,
  WebhookRequest,
} from '../src/openwa';
import { connectorId } from './fixtures';

export class MemoryStorage implements PluginStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value === undefined ? null : structuredClone(value) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(prefix = ''): Promise<string[]> {
    return [...this.values.keys()].filter(key => key.startsWith(prefix)).sort();
  }
}

export function createPluginHarness(input?: {
  storage?: MemoryStorage;
  send?: (envelope: Record<string, unknown>) => Promise<unknown>;
  net?: (url: string, init?: Record<string, unknown>) => Promise<PluginNetResponse>;
}) {
  const storage = input?.storage ?? new MemoryStorage();
  const webhooks = new Map<string, (request: WebhookRequest) => Promise<void> | void>();
  const hooks = new Map<HookEvent, (context: HookContext) => Promise<HookResult> | HookResult>();
  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const sent: Record<string, unknown>[] = [];
  const requests: Array<{ url: string; init?: Record<string, unknown> }> = [];
  const context: PluginContext = {
    pluginId: 'wa-studio-connector',
    config: {
      eventInboxBaseUrl: 'https://events.example.test',
      connectorToken: `wac1.${connectorId}.1.${'a'.repeat(43)}`,
      sessionId: '91f27e51-fd00-4c07-bfbf-0ddf11a02af6',
      heartbeatIntervalSeconds: 60,
      storagePressureThreshold: 0.75,
    },
    storage,
    logger: {
      log: (message, meta) => logs.push({ level: 'log', message, ...(meta ? { meta } : {}) }),
      debug: (message, meta) => logs.push({ level: 'debug', message, ...(meta ? { meta } : {}) }),
      warn: (message, meta) => logs.push({ level: 'warn', message, ...(meta ? { meta } : {}) }),
      error: (message, _error, meta) => logs.push({ level: 'error', message, ...(meta ? { meta } : {}) }),
    },
    net: {
      fetch: async (url, init) => {
        requests.push({ url, ...(init ? { init: init as Record<string, unknown> } : {}) });
        if (input?.net) return input.net(url, init as Record<string, unknown> | undefined);
        if (url.endsWith('/heartbeat')) {
          return jsonResponse({
            protocolVersion: 1,
            serverTime: new Date().toISOString(),
            bindings: [{
              sessionId: context.config.sessionId,
              connectorId,
              webhookId: 'webhook-1',
              generation: 1,
              updatedAt: new Date().toISOString(),
            }],
          });
        }
        if (url.endsWith('/events')) return jsonResponse({ accepted: true, duplicate: false });
        return { ok: true, status: 200, statusText: 'OK', headers: {}, body: '' };
      },
    },
    conversations: {
      send: async envelope => {
        const record = envelope as unknown as Record<string, unknown>;
        sent.push(record);
        return input?.send ? input.send(record) : { messageId: 'wa-message-1', timestamp: 1 };
      },
    },
    registerWebhook: (route, handler) => webhooks.set(route, handler),
    registerHook: (event, handler) => hooks.set(event, handler),
  };
  return { context, storage, webhooks, hooks, logs, sent, requests };
}

export function jsonResponse(value: unknown, status = 200): PluginNetResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export async function waitFor(assertion: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
