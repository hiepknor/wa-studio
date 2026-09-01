import { describe, expect, it } from 'vitest';
import { ConnectorJournal } from '../src/journal';
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
