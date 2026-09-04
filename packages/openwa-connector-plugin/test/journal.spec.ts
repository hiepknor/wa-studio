import { describe, expect, it } from 'vitest';
import { ConnectorJournal, ConnectorJournalCapacityError } from '../src/journal';
import { sha256Utf8 } from '../src/protocol';
import { textCommand } from './fixtures';
import { MemoryStorage } from './helpers';

describe('durable connector journal', () => {
  it('turns a persisted SEND_STARTED into INDETERMINATE after process recovery', async () => {
    const storage = new MemoryStorage();
    const command = textCommand();
    const digest = sha256Utf8(JSON.stringify(command));
    const first = new ConnectorJournal(storage, '0.1.0');
    await first.receive(command, digest, 'webhook-1');
    await first.markStarted(command.commandId);

    const restarted = new ConnectorJournal(storage, '0.1.0');
    await expect(restarted.recover()).resolves.toMatchObject({ indeterminate: 1, resumable: [] });
    const record = await restarted.get(command.commandId);
    expect(record?.state).toBe('SEND_INDETERMINATE');
    expect(record?.evidence.map(entry => entry.evidence.kind)).toEqual([
      'COMMAND_RECEIVED',
      'SEND_STARTED',
      'SEND_INDETERMINATE',
    ]);
  });

  it('reconciles an acknowledgement that races ahead of the send response', async () => {
    const storage = new MemoryStorage();
    const command = textCommand();
    const journal = new ConnectorJournal(storage, '0.1.0');
    await journal.receive(command, sha256Utf8(JSON.stringify(command)), 'webhook-1');
    await journal.markStarted(command.commandId);
    await expect(journal.appendAcknowledgement(command.sessionId, 'wa-1', 'delivered'))
      .resolves.toBe(false);
    await journal.markAccepted(command.commandId, 'wa-1');

    const record = await journal.get(command.commandId);
    expect(record?.evidence.map(entry => entry.evidence.kind)).toEqual([
      'COMMAND_RECEIVED',
      'SEND_STARTED',
      'SEND_ACCEPTED',
      'ACK_DELIVERED',
    ]);
    await expect(journal.appendAcknowledgement(command.sessionId, 'wa-1', 'sent'))
      .resolves.toBe(false);
  });

  it('does not retain unrelated OpenWA acknowledgements without an active send race', async () => {
    const storage = new MemoryStorage();
    const journal = new ConnectorJournal(storage, '0.1.0');

    for (let index = 0; index < 1_000; index += 1) {
      await journal.appendAcknowledgement(
        textCommand().sessionId,
        `unrelated-${index}`,
        'delivered',
      );
    }

    expect(orphanAcknowledgementCount(storage)).toBe(0);
  });

  it('bounds active-race acknowledgements and expires them during compaction', async () => {
    const storage = new MemoryStorage();
    const base = new Date('2026-09-03T00:00:00.000Z');
    const command = textCommand({
      createdAt: base.toISOString(),
      expiresAt: new Date(base.valueOf() + 60_000).toISOString(),
    });
    const journal = new ConnectorJournal(storage, '0.1.0', {
      maximumOrphanAcknowledgements: 8,
      orphanRetentionMs: 1_000,
      orphanRaceWindowMs: 60_000,
    });
    await journal.receive(command, sha256Utf8(JSON.stringify(command)), 'webhook-1', { now: base });
    await journal.markStarted(command.commandId, base);

    for (let index = 0; index < 20; index += 1) {
      await journal.appendAcknowledgement(
        command.sessionId,
        `racing-${index}`,
        'delivered',
        new Date(base.valueOf() + 100 + index),
        new Date(base.valueOf() + 200 + index),
      );
    }
    expect(orphanAcknowledgementCount(storage)).toBe(8);

    await expect(journal.compact(new Date(base.valueOf() + 2_000))).resolves.toBe(8);
    expect(orphanAcknowledgementCount(storage)).toBe(0);
  });

  it('reconciles a retained race acknowledgement after the journal is recreated', async () => {
    const storage = new MemoryStorage();
    const command = textCommand();
    const first = new ConnectorJournal(storage, '0.1.0');
    await first.receive(command, sha256Utf8(JSON.stringify(command)), 'webhook-1');
    await first.markStarted(command.commandId);
    await first.appendAcknowledgement(command.sessionId, 'wa-after-recreate', 'sent');
    await first.appendAcknowledgement(command.sessionId, 'wa-after-recreate', 'failed');
    await first.appendAcknowledgement(command.sessionId, 'wa-after-recreate', 'delivered');
    await first.appendAcknowledgement(command.sessionId, 'wa-after-recreate', 'read');

    const recreated = new ConnectorJournal(storage, '0.1.0');
    await recreated.markAccepted(command.commandId, 'wa-after-recreate');

    expect((await recreated.get(command.commandId))?.evidence.map(entry => entry.evidence.kind)).toEqual([
      'COMMAND_RECEIVED',
      'SEND_STARTED',
      'SEND_ACCEPTED',
      'ACK_READ',
    ]);
    expect(orphanAcknowledgementCount(storage)).toBe(0);
  });

  it('accounts for the complete journal namespace and rejects only new commands under pressure', async () => {
    const storage = new MemoryStorage();
    const journal = new ConnectorJournal(storage, '0.1.0', { storageQuotaBytes: 1024 * 1024 });
    const first = textCommand();
    await journal.receive(first, sha256Utf8(JSON.stringify(first)), 'webhook-1', {
      maximumStorageUtilization: 0.75,
    });
    await storage.set('wa-studio:v1:journal:test-padding', 'x'.repeat(300_000));
    expect((await journal.stats()).storageUtilization).toBeGreaterThan(0.75);

    const second = textCommand({
      commandId: '620d7186-d718-43dc-af38-a358d3f6b5c9',
      attemptId: '9a1f20dc-a826-4ec1-bcb1-53a72bda132a',
    });
    await expect(journal.receive(
      second,
      sha256Utf8(JSON.stringify(second)),
      'webhook-1',
      { maximumStorageUtilization: 0.75 },
    )).rejects.toBeInstanceOf(ConnectorJournalCapacityError);

    await expect(journal.receive(
      first,
      sha256Utf8(JSON.stringify(first)),
      'webhook-1',
      { maximumStorageUtilization: 0.75 },
    )).resolves.toMatchObject({ created: false });
  });

  it('rejects a reused command id carrying a different immutable payload', async () => {
    const storage = new MemoryStorage();
    const command = textCommand();
    const journal = new ConnectorJournal(storage, '0.1.0');
    await journal.receive(command, 'a'.repeat(64), 'webhook-1');
    await expect(journal.receive(command, 'b'.repeat(64), 'webhook-1'))
      .rejects.toThrow('different payload digest');
  });

  it('resumes only commands that never crossed SEND_STARTED', async () => {
    const storage = new MemoryStorage();
    const command = textCommand();
    const journal = new ConnectorJournal(storage, '0.1.0');
    await journal.receive(command, sha256Utf8(JSON.stringify(command)), 'webhook-1');
    await expect(journal.recover()).resolves.toMatchObject({
      indeterminate: 0,
      resumable: [{ state: 'RECEIVED' }],
    });
  });
});

function orphanAcknowledgementCount(storage: MemoryStorage): number {
  return [...storage.values.entries()]
    .filter(([key]) => key.startsWith('wa-studio:v1:journal:orphan:'))
    .reduce((count, [, value]) => {
      const bucket = value as { acknowledgements?: Record<string, unknown> };
      return count + Object.keys(bucket.acknowledgements ?? {}).length;
    }, 0);
}
