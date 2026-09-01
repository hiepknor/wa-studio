import { BindingStore } from './bindings';
import { readConfig, type ConnectorConfig } from './config';
import { EventInboxClient, EventInboxRequestError } from './event-inbox-client';
import {
  ConnectorJournal,
  type AckStatus,
  type CommandRecord,
  type JournalStats,
} from './journal';
import type { HookContext, IPlugin, PluginContext, WebhookRequest } from './openwa';
import {
  extractOpenWAMessageId,
  InvalidConnectorCommandError,
  parseCommand,
  sha256Utf8,
  type ConnectorCommand,
} from './protocol';

const hookPriority = 20;
const compactIntervalMs = 60 * 60 * 1_000;

export class WAStudioConnector implements IPlugin {
  private context: PluginContext | null = null;
  private config: ConnectorConfig | null = null;
  private journal: ConnectorJournal | null = null;
  private bindings: BindingStore | null = null;
  private eventInbox: EventInboxClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private ticking = false;
  private lastCompactedAt = 0;
  private lastHeartbeatAt: number | null = null;
  private lastError: string | null = null;
  private blockedReason: string | null = null;
  private stats: JournalStats = {
    pendingCount: 0,
    oldestPendingSeconds: null,
    storageUtilization: 0,
    totalRecords: 0,
  };
  private readonly activeCommands = new Set<string>();
  private readonly flushingCommands = new Map<string, Promise<void>>();
  private readonly flushRequested = new Set<string>();
  private resumable: CommandRecord[] = [];

  constructor(private readonly pluginVersion: string) {}

  async onEnable(context: PluginContext): Promise<void> {
    if (this.context) throw new Error('wa-studio-connector is already enabled');
    this.context = context;
    this.config = readConfig(context.config);
    this.journal = new ConnectorJournal(context.storage, this.pluginVersion);
    this.bindings = new BindingStore(
      context.storage,
      this.config.sessionId,
      this.config.connectorId,
    );
    this.eventInbox = new EventInboxClient(context.net, () => this.requireConfig(), this.pluginVersion);
    await this.bindings.load();
    const recovery = await this.journal.recover();
    this.resumable = recovery.resumable;
    if (recovery.indeterminate > 0) {
      context.logger.warn('wa-studio-connector recovered ambiguous sends without retrying', {
        count: recovery.indeterminate,
      });
    }
    context.registerWebhook('commands', request => this.handleIngress(request));
    context.registerHook('message:sent', hook => this.handleSentHook(hook), hookPriority);
    context.registerHook('message:ack', hook => this.handleAckHook(hook), hookPriority);
    this.stopped = false;
    await this.tick();
    this.startTimer();
    context.logger.log('wa-studio-connector enabled', {
      version: this.pluginVersion,
      sessionId: this.config.sessionId,
    });
  }

  async onConfigChange(_context: PluginContext, newConfig: Record<string, unknown>): Promise<void> {
    const next = readConfig(newConfig);
    const current = this.requireConfig();
    if (next.sessionId !== current.sessionId || next.connectorId !== current.connectorId) {
      throw new Error('wa-studio-connector: connector identity cannot change in place; provision a new connector instance');
    }
    this.config = next;
    this.clearTimer();
    await this.tick();
    this.startTimer();
  }

  async onDisable(): Promise<void> {
    await this.stop();
  }

  async onUnload(): Promise<void> {
    await this.stop();
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const config = this.config;
    if (!config || this.stopped) return { healthy: false, message: 'connector is disabled' };
    const heartbeatAge = this.lastHeartbeatAt === null ? Number.POSITIVE_INFINITY : Date.now() - this.lastHeartbeatAt;
    const heartbeatStale = heartbeatAge > config.heartbeatIntervalSeconds * 2_500;
    const pressure = this.stats.storageUtilization >= config.storagePressureThreshold;
    const reasons = [
      this.blockedReason,
      !this.bindings?.current() ? 'binding is not synchronized' : null,
      heartbeatStale ? 'heartbeat is stale' : null,
      pressure ? `journal storage is at ${(this.stats.storageUtilization * 100).toFixed(1)}%` : null,
      this.lastError ? `last error: ${this.lastError}` : null,
    ].filter((reason): reason is string => Boolean(reason));
    return {
      healthy: reasons.length === 0,
      ...(reasons.length ? { message: reasons.join('; ').slice(0, 500) } : {}),
    };
  }

  private async handleIngress(request: WebhookRequest): Promise<void> {
    if (this.stopped) throw new Error('wa-studio-connector is not accepting commands');
    if (!request.verified) throw new Error('wa-studio-connector received an unverified command');
    let command: ConnectorCommand;
    try {
      command = parseCommand(request.rawBody);
    } catch (error) {
      this.lastError = error instanceof InvalidConnectorCommandError ? error.message.slice(0, 200) : 'invalid command';
      throw error;
    }
    const config = this.requireConfig();
    if (request.deliveryId !== command.commandId) {
      throw new Error('connector delivery id does not match command id');
    }
    if (!request.sessionId || request.sessionId !== config.sessionId || command.sessionId !== config.sessionId) {
      throw new Error('connector command does not match the bound OpenWA session');
    }
    const binding = this.requireBindings().find(command.bindingGeneration);
    if (!binding) throw new Error('connector command binding generation has not been synchronized');
    const payloadSha256 = sha256Utf8(request.rawBody);
    const received = await this.requireJournal().receive(
      command,
      payloadSha256,
      binding.webhookId,
    );
    if (received.record.state === 'SEND_STARTED') {
      if (this.activeCommands.has(command.commandId)) return;
      await this.requireJournal().markIndeterminate(
        command.commandId,
        'INGRESS_REPLAY_AFTER_SEND_STARTED',
      );
      void this.flushCommand(command.commandId);
      return;
    }
    if (received.record.state !== 'RECEIVED') {
      void this.flushCommand(command.commandId);
      return;
    }
    if (this.stats.storageUtilization >= config.storagePressureThreshold) {
      await this.requireJournal().markRejected(
        command.commandId,
        'TRANSIENT_FAILURE',
        'CONNECTOR_STORAGE_PRESSURE',
      );
      void this.flushCommand(command.commandId);
      return;
    }
    if (this.requireBindings().current()?.generation !== command.bindingGeneration) {
      await this.requireJournal().markRejected(command.commandId, 'BINDING_MISMATCH', 'BINDING_ROTATED');
      void this.flushCommand(command.commandId);
      return;
    }
    this.schedule(command);
  }

  private schedule(command: ConnectorCommand): void {
    if (this.stopped || this.activeCommands.has(command.commandId)) return;
    this.activeCommands.add(command.commandId);
    void this.execute(command)
      .catch(error => {
        this.lastError = safeError(error);
        this.context?.logger.error('wa-studio-connector command execution failed', error, {
          commandId: command.commandId,
          attemptId: command.attemptId,
        });
      })
      .finally(() => this.activeCommands.delete(command.commandId));
  }

  private async execute(command: ConnectorCommand): Promise<void> {
    if (this.stopped) return;
    const journal = this.requireJournal();
    if (Date.now() >= new Date(command.expiresAt).valueOf()) {
      await journal.markRejected(command.commandId, 'EXPIRED_COMMAND', 'COMMAND_EXPIRED');
      await this.flushCommand(command.commandId);
      return;
    }
    if (this.requireBindings().current()?.generation !== command.bindingGeneration) {
      await journal.markRejected(command.commandId, 'BINDING_MISMATCH', 'BINDING_ROTATED');
      await this.flushCommand(command.commandId);
      return;
    }
    if (command.operation === 'SEND_IMAGE') {
      try {
        await this.requireEventInbox().verifyMedia(command);
      } catch (error) {
        const mismatch = error instanceof EventInboxRequestError && error.persistent;
        await journal.markRejected(
          command.commandId,
          mismatch ? 'INVALID_COMMAND' : 'TRANSIENT_FAILURE',
          mismatch ? 'MEDIA_PREFLIGHT_REJECTED' : 'MEDIA_PREFLIGHT_UNAVAILABLE',
        );
        await this.flushCommand(command.commandId);
        return;
      }
    }
    if (Date.now() >= new Date(command.expiresAt).valueOf()) {
      await journal.markRejected(command.commandId, 'EXPIRED_COMMAND', 'COMMAND_EXPIRED');
      await this.flushCommand(command.commandId);
      return;
    }
    await journal.markStarted(command.commandId);
    void this.flushCommand(command.commandId);
    let messageId: string | null = null;
    try {
      const result = await this.requireContext().conversations.send(command.operation === 'SEND_TEXT'
        ? {
            sessionId: command.sessionId,
            chatId: command.recipientId,
            type: 'text',
            text: command.content.text,
          }
        : {
            sessionId: command.sessionId,
            chatId: command.recipientId,
            type: 'image',
            mediaUrl: command.content.mediaUrl,
            text: command.content.caption,
          });
      messageId = extractOpenWAMessageId(result);
      if (!messageId) {
        await journal.markIndeterminate(command.commandId, 'OPENWA_RESPONSE_MISSING_MESSAGE_ID');
      } else {
        await journal.markAccepted(command.commandId, messageId);
      }
    } catch {
      await journal.markIndeterminate(command.commandId, 'OPENWA_SEND_RESULT_AMBIGUOUS');
    }
    await this.flushCommand(command.commandId);
  }

  private async handleSentHook(hook: HookContext): Promise<{ continue: true; data: unknown }> {
    const data = objectValue(hook.data);
    const messageId = typeof data?.id === 'string' ? data.id : null;
    const sessionId = hook.sessionId;
    if (messageId && sessionId && sessionId === this.config?.sessionId) {
      await this.requireJournal().appendAcknowledgement(sessionId, messageId, 'sent', hook.timestamp);
      void this.flushPending(20);
    }
    return { continue: true, data: hook.data };
  }

  private async handleAckHook(hook: HookContext): Promise<{ continue: true; data: unknown }> {
    const data = objectValue(hook.data);
    const messageId = typeof data?.messageId === 'string' ? data.messageId : null;
    const status = normalizeAckStatus(data?.status);
    const sessionId = hook.sessionId;
    if (messageId && status && sessionId && sessionId === this.config?.sessionId) {
      await this.requireJournal().appendAcknowledgement(sessionId, messageId, status, hook.timestamp);
      void this.flushPending(20);
    }
    return { continue: true, data: hook.data };
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped || !this.journal || !this.bindings || !this.eventInbox) return;
    this.ticking = true;
    try {
      this.stats = await this.journal.stats();
      const pressure = this.stats.storageUtilization >= this.requireConfig().storagePressureThreshold;
      const heartbeatBlocked = pressure ? 'journal_storage_pressure' : this.blockedReason;
      const reportedGeneration = this.bindings.current()?.generation ?? 0;
      const bindings = await this.eventInbox.heartbeat(this.stats, reportedGeneration, heartbeatBlocked);
      const changed = await this.bindings.apply(bindings);
      this.lastHeartbeatAt = Date.now();
      this.lastError = null;
      if (this.blockedReason?.startsWith('heartbeat_')) this.blockedReason = null;
      if (changed && (this.bindings.current()?.generation ?? 0) !== reportedGeneration) {
        await this.eventInbox.heartbeat(
          this.stats,
          this.bindings.current()?.generation ?? 0,
          heartbeatBlocked,
        );
        this.lastHeartbeatAt = Date.now();
      }
      this.resumeRecovered();
      await this.flushPending(100);
      if (Date.now() - this.lastCompactedAt >= compactIntervalMs) {
        await this.journal.compact();
        this.lastCompactedAt = Date.now();
      }
    } catch (error) {
      this.lastError = safeError(error);
      if (error instanceof EventInboxRequestError && error.persistent) {
        this.blockedReason = `${error.operation}_${error.status ?? 'invalid'}_blocked`;
      }
      this.context?.logger.warn('wa-studio-connector maintenance tick failed', {
        error: this.lastError,
      });
    } finally {
      this.ticking = false;
    }
  }

  private resumeRecovered(): void {
    const currentGeneration = this.bindings?.current()?.generation;
    if (!currentGeneration) return;
    const remaining: CommandRecord[] = [];
    for (const record of this.resumable) {
      if (this.bindings?.find(record.command.bindingGeneration)) this.schedule(record.command);
      else remaining.push(record);
    }
    this.resumable = remaining;
  }

  private async flushPending(limit: number): Promise<void> {
    const records = await this.requireJournal().pendingRecords(limit);
    for (const record of records) await this.flushCommand(record.command.commandId);
  }

  private async flushCommand(commandId: string): Promise<void> {
    if (!this.journal || !this.eventInbox) return;
    const journal = this.journal;
    const eventInbox = this.eventInbox;
    const current = this.flushingCommands.get(commandId);
    if (current) {
      this.flushRequested.add(commandId);
      await current;
      return;
    }
    const flush = (async () => {
      const record = await journal.get(commandId);
      if (!record) return;
      for (let index = 0; index < record.evidence.length; index += 1) {
        const entry = record.evidence[index]!;
        if (entry.deliveredAt) continue;
        try {
          await eventInbox.postEvidence(record, index);
          await journal.markEvidenceDelivered(commandId, entry.evidence.eventId);
        } catch (error) {
          const message = safeError(error);
          await journal.noteEvidenceFailure(commandId, entry.evidence.eventId, message);
          this.lastError = message;
          if ((error instanceof EventInboxRequestError && error.persistent) || entry.attempts >= 2) {
            this.blockedReason = 'evidence_delivery_blocked';
          }
          break;
        }
      }
    })();
    this.flushingCommands.set(commandId, flush);
    await flush.finally(() => this.flushingCommands.delete(commandId));
    if (this.flushRequested.delete(commandId)) await this.flushCommand(commandId);
    await this.clearEvidenceBlockIfDrained();
  }

  private async clearEvidenceBlockIfDrained(): Promise<void> {
    if (this.blockedReason !== 'evidence_delivery_blocked' || !this.journal) return;
    if ((await this.journal.pendingRecords(1)).length > 0) return;
    this.blockedReason = null;
    if (this.lastError?.startsWith('evidence:')) this.lastError = null;
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    if (this.journal && this.eventInbox) await this.flushPending(20).catch(() => undefined);
    this.context = null;
  }

  private startTimer(): void {
    this.clearTimer();
    const intervalMs = this.requireConfig().heartbeatIntervalSeconds * 1_000;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private requireContext(): PluginContext {
    if (!this.context) throw new Error('wa-studio-connector context is unavailable');
    return this.context;
  }

  private requireConfig(): ConnectorConfig {
    if (!this.config) throw new Error('wa-studio-connector config is unavailable');
    return this.config;
  }

  private requireJournal(): ConnectorJournal {
    if (!this.journal) throw new Error('wa-studio-connector journal is unavailable');
    return this.journal;
  }

  private requireBindings(): BindingStore {
    if (!this.bindings) throw new Error('wa-studio-connector binding store is unavailable');
    return this.bindings;
  }

  private requireEventInbox(): EventInboxClient {
    if (!this.eventInbox) throw new Error('wa-studio-connector Event Inbox client is unavailable');
    return this.eventInbox;
  }
}

function normalizeAckStatus(value: unknown): AckStatus | null {
  return ['sent', 'delivered', 'read', 'failed'].includes(String(value))
    ? String(value) as AckStatus
    : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeError(error: unknown): string {
  if (error instanceof EventInboxRequestError) {
    return `${error.operation}:${error.status ?? 'network'}`.slice(0, 200);
  }
  if (error instanceof InvalidConnectorCommandError) return 'invalid_connector_command';
  if (!error || typeof error !== 'object') return 'unknown_error';
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(name) ? name : 'connector_error';
}
