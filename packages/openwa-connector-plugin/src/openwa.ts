// Minimal installable-plugin surface aligned field-by-field with OpenWA v0.23.3
// src/core/plugins/plugin.interfaces.ts and the official OpenWA-plugins vendored types. OpenWA does
// not publish an SDK package, so this file is intentionally type-only and must be revalidated for
// every testedOpenWAVersion bump.

export type HookEvent = 'message:sent' | 'message:ack';

export interface HookContext<T = unknown> {
  event: HookEvent;
  data: T;
  sessionId?: string;
  timestamp: Date;
  source: string;
}

export interface HookResult<T = unknown> {
  continue: boolean;
  data?: T;
}

export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface PluginLogger {
  log(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown, meta?: Record<string, unknown>): void;
}

export interface PluginNetResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface PluginNetCapability {
  fetch(url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    timeoutMs?: number;
  }): Promise<PluginNetResponse>;
}

export interface ConversationSendEnvelope {
  sessionId?: string;
  chatId?: string;
  type: 'text' | 'image';
  text?: string;
  mediaUrl?: string;
}

export interface WebhookRequest {
  instanceId: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string;
  rawBody: string;
  verified: boolean;
  deliveryId: string;
  sessionId?: string;
}

export interface PluginContext {
  pluginId: string;
  config: Record<string, unknown>;
  logger: PluginLogger;
  storage: PluginStorage;
  net: PluginNetCapability;
  conversations: { send(envelope: ConversationSendEnvelope): Promise<unknown> };
  registerWebhook(
    route: string,
    handler: (request: WebhookRequest) => Promise<void> | void,
  ): void;
  registerHook(
    event: HookEvent,
    handler: (context: HookContext) => Promise<HookResult> | HookResult,
    priority?: number,
  ): void;
}

export interface IPlugin {
  onLoad?(context: PluginContext): Promise<void>;
  onEnable?(context: PluginContext): Promise<void>;
  onDisable?(context: PluginContext): Promise<void>;
  onUnload?(context: PluginContext): Promise<void>;
  onConfigChange?(context: PluginContext, newConfig: Record<string, unknown>): Promise<void>;
  healthCheck?(): Promise<{ healthy: boolean; message?: string }>;
}
