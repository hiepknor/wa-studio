import { createHash } from 'node:crypto';
import type { PluginStorage } from './openwa';
import { AsyncMutex } from './mutex';
import {
  createEvidence,
  type ConnectorCommand,
  type ConnectorEvidence,
  type DeliveryStatus,
  type EvidenceErrorClass,
  type EvidenceKind,
} from './protocol';

export type CommandJournalState =
  | 'RECEIVED'
  | 'SEND_STARTED'
  | 'SEND_ACCEPTED'
  | 'SEND_REJECTED'
  | 'SEND_INDETERMINATE';

export interface JournalEvidence {
  evidence: ConnectorEvidence;
  deliveredAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface CommandRecord {
  schemaVersion: 1;
  command: ConnectorCommand;
  payloadSha256: string;
  webhookId: string;
  state: CommandJournalState;
  openwaMessageId: string | null;
  evidence: JournalEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface JournalStats {
  pendingCount: number;
  oldestPendingSeconds: number | null;
  storageUtilization: number;
  totalRecords: number;
}

export interface JournalReceiveOptions {
  now?: Date;
  maximumStorageUtilization?: number;
}

export interface ConnectorJournalLimits {
  storageQuotaBytes?: number;
  terminalRetentionMs?: number;
  orphanRetentionMs?: number;
  orphanRaceWindowMs?: number;
  maximumOrphanAcknowledgements?: number;
}

export class ConnectorJournalCapacityError extends Error {
  constructor(readonly storageUtilization: number) {
    super(`connector journal storage utilization is ${(storageUtilization * 100).toFixed(1)}%`);
    this.name = 'ConnectorJournalCapacityError';
  }
}

interface CommandBucket {
  schemaVersion: 1;
  records: Record<string, CommandRecord>;
}

interface PointerBucket {
  schemaVersion: 1;
  pointers: Record<string, { bucketKey: string; payloadSha256: string }>;
}

interface MessageIndexBucket {
  schemaVersion: 1;
  pointers: Record<string, { commandId: string; sessionId: string }>;
}

interface OrphanAckBucket {
  schemaVersion: 1;
  acknowledgements: Record<string, { sessionId: string; status: AckStatus; occurredAt: string }>;
}

interface ActiveSendRace {
  sessionId: string;
  startedAt: number;
  deadline: number;
}

export type AckStatus = 'sent' | 'delivered' | 'read' | 'failed';

const journalPrefix = 'wa-studio:v1:journal:';
const commandPrefix = `${journalPrefix}commands:`;
const pointerPrefix = 'wa-studio:v1:journal:index:';
const messagePrefix = 'wa-studio:v1:journal:message:';
const orphanPrefix = 'wa-studio:v1:journal:orphan:';
const defaultStorageQuotaBytes = 50 * 1024 * 1024;
const conservativePackageOverheadBytes = 512 * 1024;
const defaultTerminalRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const defaultOrphanRetentionMs = 10 * 60 * 1_000;
const defaultOrphanRaceWindowMs = 5 * 60 * 1_000;
const maximumAckClockSkewMs = 30 * 1_000;
const defaultMaximumOrphanAcknowledgements = 128;

export class ConnectorJournal {
  private readonly mutex = new AsyncMutex();
  private readonly activeSendRaces = new Map<string, ActiveSendRace>();
  private readonly storageQuotaBytes: number;
  private readonly terminalRetentionMs: number;
  private readonly orphanRetentionMs: number;
  private readonly orphanRaceWindowMs: number;
  private readonly maximumOrphanAcknowledgements: number;

  constructor(
    private readonly storage: PluginStorage,
    private readonly pluginVersion: string,
    limits: ConnectorJournalLimits = {},
  ) {
    this.storageQuotaBytes = positiveInteger(
      limits.storageQuotaBytes,
      defaultStorageQuotaBytes,
      'storageQuotaBytes',
    );
    this.terminalRetentionMs = positiveInteger(
      limits.terminalRetentionMs,
      defaultTerminalRetentionMs,
      'terminalRetentionMs',
    );
    this.orphanRetentionMs = positiveInteger(
      limits.orphanRetentionMs,
      defaultOrphanRetentionMs,
      'orphanRetentionMs',
    );
    this.orphanRaceWindowMs = positiveInteger(
      limits.orphanRaceWindowMs,
      defaultOrphanRaceWindowMs,
      'orphanRaceWindowMs',
    );
    this.maximumOrphanAcknowledgements = positiveInteger(
      limits.maximumOrphanAcknowledgements,
      defaultMaximumOrphanAcknowledgements,
      'maximumOrphanAcknowledgements',
    );
  }

  receive(
    command: ConnectorCommand,
    payloadSha256: string,
    webhookId: string,
    options: JournalReceiveOptions = {},
  ): Promise<{ record: CommandRecord; created: boolean }> {
    return this.mutex.run(async () => {
      const now = options.now ?? new Date();
      const pointer = await this.findPointer(command.commandId);
      if (pointer) {
        if (pointer.payloadSha256 !== payloadSha256) {
          throw new Error('connector command id conflicts with a different payload digest');
        }
        const record = await this.loadRecord(pointer.bucketKey, command.commandId);
        return { record: clone(record), created: false };
      }
      const bucketKey = commandBucketKey(command);
      const bucket = await this.loadCommandBucket(bucketKey);
      const existing = bucket.records[command.commandId];
      if (existing) {
        if (existing.payloadSha256 !== payloadSha256) {
          throw new Error('connector command bucket contains a conflicting payload digest');
        }
        await this.setPointer(command.commandId, bucketKey, payloadSha256);
        return { record: clone(existing), created: false };
      }
      const maximumStorageUtilization = options.maximumStorageUtilization ?? 1;
      if (!Number.isFinite(maximumStorageUtilization)
        || maximumStorageUtilization <= 0 || maximumStorageUtilization > 1) {
        throw new TypeError('maximumStorageUtilization must be greater than 0 and at most 1');
      }
      const storageUtilization = await this.storageUtilization();
      if (storageUtilization >= maximumStorageUtilization) {
        throw new ConnectorJournalCapacityError(storageUtilization);
      }
      const occurredAt = now.toISOString();
      const evidence = createEvidence({
        command,
        payloadSha256,
        pluginVersion: this.pluginVersion,
        sequence: 1,
        kind: 'COMMAND_RECEIVED',
        deliveryStatus: 'PENDING',
        now,
      });
      const record: CommandRecord = {
        schemaVersion: 1,
        command,
        payloadSha256,
        webhookId,
        state: 'RECEIVED',
        openwaMessageId: null,
        evidence: [pendingEvidence(evidence)],
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      bucket.records[command.commandId] = record;
      await this.storage.set(bucketKey, bucket);
      await this.setPointer(command.commandId, bucketKey, payloadSha256);
      return { record: clone(record), created: true };
    });
  }

  get(commandId: string): Promise<CommandRecord | null> {
    return this.mutex.run(async () => {
      const pointer = await this.findPointer(commandId);
      if (!pointer) return null;
      return clone(await this.loadRecord(pointer.bucketKey, commandId));
    });
  }

  markStarted(commandId: string, now = new Date()): Promise<CommandRecord> {
    return this.transition(commandId, {
      state: 'SEND_STARTED',
      kind: 'SEND_STARTED',
      deliveryStatus: 'PENDING',
      now,
    });
  }

  markRejected(
    commandId: string,
    errorClass: EvidenceErrorClass,
    errorCode: string,
    now = new Date(),
  ): Promise<CommandRecord> {
    return this.transition(commandId, {
      state: 'SEND_REJECTED',
      kind: 'SEND_REJECTED',
      deliveryStatus: 'FAILED',
      errorClass,
      errorCode,
      now,
    });
  }

  markIndeterminate(
    commandId: string,
    errorCode: string,
    now = new Date(),
  ): Promise<CommandRecord> {
    return this.transition(commandId, {
      state: 'SEND_INDETERMINATE',
      kind: 'SEND_INDETERMINATE',
      deliveryStatus: 'INDETERMINATE',
      errorClass: 'AMBIGUOUS',
      errorCode,
      now,
    });
  }

  markAccepted(commandId: string, messageId: string, now = new Date()): Promise<CommandRecord> {
    return this.mutex.run(async () => {
      const { bucketKey, bucket, record } = await this.mutableRecord(commandId);
      if (record.state === 'SEND_ACCEPTED') {
        this.activeSendRaces.delete(commandId);
        return clone(record);
      }
      if (isTerminal(record.state)) {
        this.activeSendRaces.delete(commandId);
        return clone(record);
      }
      if (record.state !== 'SEND_STARTED') {
        throw new Error(`cannot accept connector command from journal state ${record.state}`);
      }
      appendEvidence(record, this.pluginVersion, {
        state: 'SEND_ACCEPTED',
        kind: 'SEND_ACCEPTED',
        deliveryStatus: 'ACCEPTED',
        openwaMessageId: messageId,
        now,
      });
      record.openwaMessageId = messageId;
      this.activeSendRaces.delete(commandId);
      await this.storage.set(bucketKey, bucket);
      await this.setMessagePointer(messageId, commandId, record.command.sessionId);
      await this.applyOrphanAck(record, bucketKey, bucket, messageId);
      return clone(record);
    });
  }

  appendAcknowledgement(
    sessionId: string,
    messageId: string,
    status: AckStatus,
    occurredAt = new Date(),
    observedAt = new Date(),
  ): Promise<boolean> {
    return this.mutex.run(async () => {
      const messageIndex = await this.loadMessageIndex(messageId);
      const pointer = messageIndex.pointers[messageId];
      if (!pointer) {
        if (!this.hasActiveRaceCandidate(sessionId, occurredAt)) return false;
        await this.storeOrphanAck(sessionId, messageId, status, occurredAt, observedAt);
        return false;
      }
      if (pointer.sessionId !== sessionId) return false;
      const mutable = await this.mutableRecord(pointer.commandId);
      const changed = appendAckEvidence(mutable.record, this.pluginVersion, status, occurredAt);
      if (changed) await this.storage.set(mutable.bucketKey, mutable.bucket);
      return changed;
    });
  }

  async pendingRecords(limit = 100): Promise<CommandRecord[]> {
    return this.mutex.run(async () => {
      const records = await this.scanRecords();
      return records
        .filter(record => record.evidence.some(entry => !entry.deliveredAt))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, limit)
        .map(clone);
    });
  }

  markEvidenceDelivered(commandId: string, eventId: string, now = new Date()): Promise<void> {
    return this.mutex.run(async () => {
      const { bucketKey, bucket, record } = await this.mutableRecord(commandId);
      const entry = record.evidence.find(candidate => candidate.evidence.eventId === eventId);
      if (!entry || entry.deliveredAt) return;
      entry.deliveredAt = now.toISOString();
      entry.attempts += 1;
      entry.lastAttemptAt = now.toISOString();
      entry.lastError = null;
      record.updatedAt = now.toISOString();
      await this.storage.set(bucketKey, bucket);
    });
  }

  noteEvidenceFailure(commandId: string, eventId: string, error: string, now = new Date()): Promise<void> {
    return this.mutex.run(async () => {
      const { bucketKey, bucket, record } = await this.mutableRecord(commandId);
      const entry = record.evidence.find(candidate => candidate.evidence.eventId === eventId);
      if (!entry || entry.deliveredAt) return;
      entry.attempts += 1;
      entry.lastAttemptAt = now.toISOString();
      entry.lastError = error.slice(0, 256);
      record.updatedAt = now.toISOString();
      await this.storage.set(bucketKey, bucket);
    });
  }

  recover(now = new Date()): Promise<{ resumable: CommandRecord[]; indeterminate: number }> {
    return this.mutex.run(async () => {
      const keys = (await this.storage.list(commandPrefix)).filter(key => key.startsWith(commandPrefix));
      const resumable: CommandRecord[] = [];
      let indeterminate = 0;
      for (const key of keys) {
        const bucket = await this.loadCommandBucket(key, false);
        let changed = false;
        for (const record of Object.values(bucket.records)) {
          await this.setPointer(record.command.commandId, key, record.payloadSha256);
          if (record.openwaMessageId) {
            await this.setMessagePointer(
              record.openwaMessageId,
              record.command.commandId,
              record.command.sessionId,
            );
          }
          if (record.state === 'SEND_STARTED') {
            this.activeSendRaces.delete(record.command.commandId);
            appendEvidence(record, this.pluginVersion, {
              state: 'SEND_INDETERMINATE',
              kind: 'SEND_INDETERMINATE',
              deliveryStatus: 'INDETERMINATE',
              errorClass: 'AMBIGUOUS',
              errorCode: 'PLUGIN_RESTART_AFTER_SEND_STARTED',
              now,
            });
            changed = true;
            indeterminate += 1;
          } else if (record.state === 'RECEIVED') {
            resumable.push(clone(record));
          }
        }
        if (changed) await this.storage.set(key, bucket);
      }
      return { resumable, indeterminate };
    });
  }

  stats(now = new Date()): Promise<JournalStats> {
    return this.mutex.run(async () => {
      const journalKeys = await this.listJournalKeys();
      const keys = journalKeys.filter(key => key.startsWith(commandPrefix));
      const pendingSince: number[] = [];
      let pendingCount = 0;
      let totalRecords = 0;
      for (const key of keys) {
        const bucket = await this.loadCommandBucket(key, false);
        for (const record of Object.values(bucket.records)) {
          totalRecords += 1;
          if (record.state === 'RECEIVED' || record.state === 'SEND_STARTED'
            || record.evidence.some(entry => !entry.deliveredAt)) {
            pendingCount += 1;
            pendingSince.push(new Date(record.createdAt).valueOf());
          }
        }
      }
      const oldest = pendingSince.length ? Math.min(...pendingSince) : null;
      return {
        pendingCount,
        oldestPendingSeconds: oldest === null ? null : Math.max(0, Math.floor((now.valueOf() - oldest) / 1_000)),
        storageUtilization: await this.storageUtilization(journalKeys),
        totalRecords,
      };
    });
  }

  compact(now = new Date()): Promise<number> {
    return this.mutex.run(async () => {
      const keys = (await this.storage.list(commandPrefix)).filter(key => key.startsWith(commandPrefix));
      let removed = 0;
      for (const key of keys) {
        const bucket = await this.loadCommandBucket(key, false);
        for (const [commandId, record] of Object.entries(bucket.records)) {
          if (!isTerminal(record.state) || record.evidence.some(entry => !entry.deliveredAt)
            || now.valueOf() - new Date(record.updatedAt).valueOf() < this.terminalRetentionMs) continue;
          delete bucket.records[commandId];
          await this.deletePointer(commandId);
          if (record.openwaMessageId) await this.deleteMessagePointer(record.openwaMessageId);
          removed += 1;
        }
        if (Object.keys(bucket.records).length === 0) await this.storage.delete(key);
        else await this.storage.set(key, bucket);
      }
      removed += await this.pruneOrphanAcknowledgements(now);
      return removed;
    });
  }

  private async listJournalKeys(): Promise<string[]> {
    return (await this.storage.list(journalPrefix)).filter(key => key.startsWith(journalPrefix));
  }

  private async storageUtilization(keys?: string[]): Promise<number> {
    let bytes = conservativePackageOverheadBytes;
    for (const key of keys ?? await this.listJournalKeys()) {
      const value = await this.storage.get<unknown>(key);
      if (value === null) continue;
      bytes += Buffer.byteLength(key, 'utf8');
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    }
    return Math.min(1, bytes / this.storageQuotaBytes);
  }

  private hasActiveRaceCandidate(sessionId: string, occurredAt: Date): boolean {
    const acknowledgementTime = occurredAt.valueOf();
    if (!Number.isFinite(acknowledgementTime)) return false;
    return [...this.activeSendRaces.values()].some(race => race.sessionId === sessionId
      && acknowledgementTime >= race.startedAt - maximumAckClockSkewMs
      && acknowledgementTime <= race.deadline);
  }

  private trackActiveSend(record: CommandRecord): void {
    const startedAt = new Date(record.updatedAt).valueOf();
    const expiresAt = new Date(record.command.expiresAt).valueOf();
    this.activeSendRaces.set(record.command.commandId, {
      sessionId: record.command.sessionId,
      startedAt,
      deadline: Math.min(
        startedAt + this.orphanRaceWindowMs,
        expiresAt + maximumAckClockSkewMs,
      ),
    });
  }

  private async pruneOrphanAcknowledgements(
    now: Date,
    retainAtMost = this.maximumOrphanAcknowledgements,
  ): Promise<number> {
    const nowValue = now.valueOf();
    const keys = (await this.storage.list(orphanPrefix)).filter(key => key.startsWith(orphanPrefix));
    const buckets = new Map<string, OrphanAckBucket>();
    const changed = new Set<string>();
    const retained: Array<{ key: string; messageId: string; occurredAt: number }> = [];
    let removed = 0;

    for (const key of keys) {
      const bucket = await this.loadOrphanBucketByKey(key);
      buckets.set(key, bucket);
      for (const [messageId, acknowledgement] of Object.entries(bucket.acknowledgements)) {
        const occurredAt = new Date(acknowledgement.occurredAt).valueOf();
        if (!Number.isFinite(occurredAt)
          || occurredAt > nowValue + maximumAckClockSkewMs
          || nowValue - occurredAt > this.orphanRetentionMs) {
          delete bucket.acknowledgements[messageId];
          changed.add(key);
          removed += 1;
          continue;
        }
        retained.push({ key, messageId, occurredAt });
      }
    }

    const excess = Math.max(0, retained.length - Math.max(0, retainAtMost));
    retained.sort((left, right) => left.occurredAt - right.occurredAt
      || left.messageId.localeCompare(right.messageId));
    for (const acknowledgement of retained.slice(0, excess)) {
      const bucket = buckets.get(acknowledgement.key)!;
      delete bucket.acknowledgements[acknowledgement.messageId];
      changed.add(acknowledgement.key);
      removed += 1;
    }

    for (const key of changed) {
      const bucket = buckets.get(key)!;
      if (Object.keys(bucket.acknowledgements).length === 0) await this.storage.delete(key);
      else await this.storage.set(key, bucket);
    }
    return removed;
  }

  private transition(
    commandId: string,
    transition: Transition,
  ): Promise<CommandRecord> {
    return this.mutex.run(async () => {
      const { bucketKey, bucket, record } = await this.mutableRecord(commandId);
      if (record.state === transition.state) {
        if (record.state === 'SEND_STARTED') this.trackActiveSend(record);
        return clone(record);
      }
      if (isTerminal(record.state)) {
        this.activeSendRaces.delete(commandId);
        return clone(record);
      }
      if (transition.state === 'SEND_STARTED' && record.state !== 'RECEIVED') {
        throw new Error(`cannot start connector command from journal state ${record.state}`);
      }
      if (transition.state === 'SEND_REJECTED' && record.state !== 'RECEIVED') {
        throw new Error(`cannot safely reject connector command from journal state ${record.state}`);
      }
      appendEvidence(record, this.pluginVersion, transition);
      if (record.state === 'SEND_STARTED') this.trackActiveSend(record);
      else this.activeSendRaces.delete(commandId);
      await this.storage.set(bucketKey, bucket);
      return clone(record);
    });
  }

  private async mutableRecord(commandId: string): Promise<{
    bucketKey: string;
    bucket: CommandBucket;
    record: CommandRecord;
  }> {
    const pointer = await this.findPointer(commandId);
    if (!pointer) throw new Error('connector command is missing from the journal index');
    const bucket = await this.loadCommandBucket(pointer.bucketKey, false);
    const record = bucket.records[commandId];
    if (!record) throw new Error('connector command journal index points to a missing record');
    if (record.payloadSha256 !== pointer.payloadSha256) {
      throw new Error('connector command journal index digest mismatch');
    }
    return { bucketKey: pointer.bucketKey, bucket, record };
  }

  private async loadRecord(bucketKey: string, commandId: string): Promise<CommandRecord> {
    const bucket = await this.loadCommandBucket(bucketKey, false);
    const record = bucket.records[commandId];
    if (!record) throw new Error('connector command journal record is missing');
    return record;
  }

  private async scanRecords(): Promise<CommandRecord[]> {
    const keys = (await this.storage.list(commandPrefix)).filter(key => key.startsWith(commandPrefix));
    const records: CommandRecord[] = [];
    for (const key of keys) {
      const bucket = await this.loadCommandBucket(key, false);
      records.push(...Object.values(bucket.records));
    }
    return records;
  }

  private async loadCommandBucket(key: string, create = true): Promise<CommandBucket> {
    const value = await this.storage.get<CommandBucket>(key);
    if (!value && create) return { schemaVersion: 1, records: {} };
    if (!value || value.schemaVersion !== 1 || !value.records || typeof value.records !== 'object') {
      throw new Error(`connector journal bucket is missing or corrupt: ${key}`);
    }
    return value;
  }

  private async findPointer(commandId: string): Promise<{ bucketKey: string; payloadSha256: string } | null> {
    const bucket = await this.loadPointerBucket(commandId);
    return bucket.pointers[commandId] ?? null;
  }

  private async setPointer(commandId: string, bucketKey: string, payloadSha256: string): Promise<void> {
    const key = pointerKey(commandId);
    const bucket = await this.loadPointerBucket(commandId);
    const current = bucket.pointers[commandId];
    if (current && (current.bucketKey !== bucketKey || current.payloadSha256 !== payloadSha256)) {
      throw new Error('connector command id conflicts with its retained journal index');
    }
    if (current) return;
    bucket.pointers[commandId] = { bucketKey, payloadSha256 };
    await this.storage.set(key, bucket);
  }

  private async deletePointer(commandId: string): Promise<void> {
    const key = pointerKey(commandId);
    const bucket = await this.loadPointerBucket(commandId);
    delete bucket.pointers[commandId];
    if (Object.keys(bucket.pointers).length === 0) await this.storage.delete(key);
    else await this.storage.set(key, bucket);
  }

  private async loadPointerBucket(commandId: string): Promise<PointerBucket> {
    const key = pointerKey(commandId);
    const value = await this.storage.get<PointerBucket>(key);
    if (!value) return { schemaVersion: 1, pointers: {} };
    if (value.schemaVersion !== 1 || !value.pointers || typeof value.pointers !== 'object') {
      throw new Error(`connector journal pointer bucket is corrupt: ${key}`);
    }
    return value;
  }

  private async setMessagePointer(messageId: string, commandId: string, sessionId: string): Promise<void> {
    const key = messageKey(messageId);
    const bucket = await this.loadMessageIndex(messageId);
    const current = bucket.pointers[messageId];
    if (current && (current.commandId !== commandId || current.sessionId !== sessionId)) {
      throw new Error('OpenWA message id conflicts with another connector command');
    }
    if (current) return;
    bucket.pointers[messageId] = { commandId, sessionId };
    await this.storage.set(key, bucket);
  }

  private async deleteMessagePointer(messageId: string): Promise<void> {
    const key = messageKey(messageId);
    const bucket = await this.loadMessageIndex(messageId);
    delete bucket.pointers[messageId];
    if (Object.keys(bucket.pointers).length === 0) await this.storage.delete(key);
    else await this.storage.set(key, bucket);
  }

  private async loadMessageIndex(messageId: string): Promise<MessageIndexBucket> {
    const key = messageKey(messageId);
    const value = await this.storage.get<MessageIndexBucket>(key);
    if (!value) return { schemaVersion: 1, pointers: {} };
    if (value.schemaVersion !== 1 || !value.pointers || typeof value.pointers !== 'object') {
      throw new Error(`connector message index is corrupt: ${key}`);
    }
    return value;
  }

  private async storeOrphanAck(
    sessionId: string,
    messageId: string,
    status: AckStatus,
    occurredAt: Date,
    observedAt: Date,
  ): Promise<void> {
    const occurredAtValue = occurredAt.valueOf();
    const observedAtValue = observedAt.valueOf();
    if (!Number.isFinite(occurredAtValue) || !Number.isFinite(observedAtValue)
      || occurredAtValue > observedAtValue + maximumAckClockSkewMs
      || observedAtValue - occurredAtValue > this.orphanRetentionMs) return;
    const key = orphanKey(messageId);
    let bucket = await this.loadOrphanBucket(messageId);
    const current = bucket.acknowledgements[messageId];
    if (current) {
      if (shouldReplaceAck(current.status, status)) {
        bucket.acknowledgements[messageId] = { sessionId, status, occurredAt: occurredAt.toISOString() };
        await this.storage.set(key, bucket);
      }
      return;
    }
    await this.pruneOrphanAcknowledgements(
      observedAt,
      this.maximumOrphanAcknowledgements - 1,
    );
    bucket = await this.loadOrphanBucket(messageId);
    bucket.acknowledgements[messageId] = { sessionId, status, occurredAt: occurredAt.toISOString() };
    await this.storage.set(key, bucket);
  }

  private async applyOrphanAck(
    record: CommandRecord,
    commandBucketKeyValue: string,
    commandBucket: CommandBucket,
    messageId: string,
  ): Promise<void> {
    const key = orphanKey(messageId);
    const bucket = await this.loadOrphanBucket(messageId);
    const orphan = bucket.acknowledgements[messageId];
    if (!orphan || orphan.sessionId !== record.command.sessionId) return;
    if (appendAckEvidence(record, this.pluginVersion, orphan.status, new Date(orphan.occurredAt))) {
      await this.storage.set(commandBucketKeyValue, commandBucket);
    }
    delete bucket.acknowledgements[messageId];
    if (Object.keys(bucket.acknowledgements).length === 0) await this.storage.delete(key);
    else await this.storage.set(key, bucket);
  }

  private async loadOrphanBucket(messageId: string): Promise<OrphanAckBucket> {
    return this.loadOrphanBucketByKey(orphanKey(messageId));
  }

  private async loadOrphanBucketByKey(key: string): Promise<OrphanAckBucket> {
    const value = await this.storage.get<OrphanAckBucket>(key);
    if (!value) return { schemaVersion: 1, acknowledgements: {} };
    if (value.schemaVersion !== 1 || !value.acknowledgements
      || typeof value.acknowledgements !== 'object') {
      throw new Error(`connector orphan acknowledgement bucket is corrupt: ${key}`);
    }
    return value;
  }
}

interface Transition {
  state: CommandJournalState;
  kind: EvidenceKind;
  deliveryStatus: DeliveryStatus;
  errorClass?: EvidenceErrorClass;
  errorCode?: string;
  openwaMessageId?: string;
  now: Date;
}

function appendEvidence(record: CommandRecord, pluginVersion: string, transition: Transition): void {
  if (record.evidence.some(entry => entry.evidence.kind === transition.kind)) return;
  const evidence = createEvidence({
    command: record.command,
    payloadSha256: record.payloadSha256,
    pluginVersion,
    sequence: record.evidence.length + 1,
    kind: transition.kind,
    deliveryStatus: transition.deliveryStatus,
    openwaMessageId: transition.openwaMessageId ?? record.openwaMessageId,
    errorClass: transition.errorClass ?? null,
    errorCode: transition.errorCode ?? null,
    now: transition.now,
  });
  record.evidence.push(pendingEvidence(evidence));
  record.state = transition.state;
  record.updatedAt = transition.now.toISOString();
}

function appendAckEvidence(
  record: CommandRecord,
  pluginVersion: string,
  status: AckStatus,
  occurredAt: Date,
): boolean {
  if (!record.openwaMessageId || record.state !== 'SEND_ACCEPTED') return false;
  const mapping: Record<AckStatus, { kind: EvidenceKind; deliveryStatus: DeliveryStatus }> = {
    sent: { kind: 'ACK_SENT', deliveryStatus: 'SENT' },
    delivered: { kind: 'ACK_DELIVERED', deliveryStatus: 'DELIVERED' },
    read: { kind: 'ACK_READ', deliveryStatus: 'READ' },
    failed: { kind: 'ACK_FAILED', deliveryStatus: 'FAILED' },
  };
  const mapped = mapping[status];
  if ((status === 'sent' && record.evidence.some(entry =>
    ['ACK_SENT', 'ACK_DELIVERED', 'ACK_READ'].includes(entry.evidence.kind)))
    || (status === 'delivered' && record.evidence.some(entry => entry.evidence.kind === 'ACK_READ'))
    || (status === 'failed' && record.evidence.some(entry =>
      ['ACK_DELIVERED', 'ACK_READ'].includes(entry.evidence.kind)))) return false;
  if (record.evidence.some(entry => entry.evidence.kind === mapped.kind)) return false;
  record.evidence.push(pendingEvidence(createEvidence({
    command: record.command,
    payloadSha256: record.payloadSha256,
    pluginVersion,
    sequence: record.evidence.length + 1,
    kind: mapped.kind,
    deliveryStatus: mapped.deliveryStatus,
    openwaMessageId: record.openwaMessageId,
    errorClass: status === 'failed' ? 'TRANSIENT_FAILURE' : null,
    errorCode: status === 'failed' ? 'OPENWA_DELIVERY_FAILED' : null,
    now: occurredAt,
  })));
  record.updatedAt = occurredAt.toISOString();
  return true;
}

function pendingEvidence(evidence: ConnectorEvidence): JournalEvidence {
  return { evidence, deliveredAt: null, attempts: 0, lastAttemptAt: null, lastError: null };
}

function commandBucketKey(command: ConnectorCommand): string {
  const day = command.createdAt.slice(0, 10).replaceAll('-', '');
  return `${commandPrefix}${command.sessionId}:${day}:${shard(command.commandId)}`;
}

function pointerKey(commandId: string): string {
  return `${pointerPrefix}${shard(commandId)}`;
}

function messageKey(messageId: string): string {
  return `${messagePrefix}${shard(messageId)}`;
}

function orphanKey(messageId: string): string {
  return `${orphanPrefix}${shard(messageId)}`;
}

function shard(value: string): string {
  return createHash('sha256').update(value).digest('hex')[0]!;
}

function isTerminal(state: CommandJournalState): boolean {
  return ['SEND_ACCEPTED', 'SEND_REJECTED', 'SEND_INDETERMINATE'].includes(state);
}

function shouldReplaceAck(current: AckStatus, next: AckStatus): boolean {
  if (current === next || current === 'read') return false;
  if (next === 'read') return true;
  if (next === 'delivered') return current !== 'delivered';
  return next === 'failed' && current === 'sent';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}
