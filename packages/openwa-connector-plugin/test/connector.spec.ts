import { describe, expect, it } from 'vitest';
import { WAStudioConnector } from '../src/connector';
import { ConnectorJournal } from '../src/journal';
import { sha256Utf8, type ConnectorEvidence } from '../src/protocol';
import type { WebhookRequest } from '../src/openwa';
import { connectorId, imageCommand, sessionId, textCommand } from './fixtures';
import { createPluginHarness, jsonResponse, waitFor } from './helpers';

describe('WA Studio OpenWA connector', () => {
  it('sends one text message and publishes ordered durable evidence under duplicate ingress', async () => {
    const harness = createPluginHarness();
    const plugin = new WAStudioConnector('0.1.0');
    await plugin.onEnable(harness.context);
    const handler = harness.webhooks.get('commands')!;
    const command = textCommand();
    const request = webhookRequest(command);

    await handler(request);
    await waitFor(() => evidenceFrom(harness.requests).some(event => event.kind === 'SEND_ACCEPTED'));
    await handler(request);
    await waitFor(() => evidenceFrom(harness.requests).length >= 3);

    expect(harness.sent).toEqual([{
      sessionId,
      chatId: command.recipientId,
      type: 'text',
      text: 'hello',
    }]);
    expect(evidenceFrom(harness.requests).map(event => event.kind)).toEqual([
      'COMMAND_RECEIVED',
      'SEND_STARTED',
      'SEND_ACCEPTED',
    ]);
    await plugin.onDisable();
  });

  it('never retries a send whose OpenWA result is ambiguous', async () => {
    const harness = createPluginHarness({ send: async () => { throw new Error('connection reset'); } });
    const plugin = new WAStudioConnector('0.1.0');
    await plugin.onEnable(harness.context);
    const handler = harness.webhooks.get('commands')!;
    const command = textCommand();
    const request = webhookRequest(command);

    await handler(request);
    await waitFor(() => evidenceFrom(harness.requests).some(event => event.kind === 'SEND_INDETERMINATE'));
    await handler(request);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(harness.sent).toHaveLength(1);
    expect(evidenceFrom(harness.requests).map(event => event.kind)).toEqual([
      'COMMAND_RECEIVED',
      'SEND_STARTED',
      'SEND_INDETERMINATE',
    ]);
    await plugin.onDisable();
  });

  it('preflights immutable image metadata before crossing SEND_STARTED', async () => {
    const harness = createPluginHarness({
      net: async (url, init) => {
        if (url.endsWith('/heartbeat')) {
          return jsonResponse({
            protocolVersion: 1,
            bindings: [{ sessionId, connectorId, webhookId: 'webhook-1', generation: 1, updatedAt: new Date().toISOString() }],
          });
        }
        if (url.endsWith('/events')) return jsonResponse({ accepted: true, duplicate: false });
        if (init?.method === 'HEAD') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: {
              'content-length': '999',
              'content-type': 'image/png',
              'x-wa-content-sha256': 'a'.repeat(64),
            },
            body: '',
          };
        }
        throw new Error('unexpected request');
      },
    });
    const plugin = new WAStudioConnector('0.1.0');
    await plugin.onEnable(harness.context);
    const command = imageCommand();
    await harness.webhooks.get('commands')!(webhookRequest(command));
    await waitFor(() => evidenceFrom(harness.requests).some(event => event.kind === 'SEND_REJECTED'));

    expect(harness.sent).toHaveLength(0);
    expect(evidenceFrom(harness.requests).map(event => event.kind)).toEqual([
      'COMMAND_RECEIVED',
      'SEND_REJECTED',
    ]);
    await plugin.onDisable();
  });

  it('projects OpenWA delivery hooks through the retained message index', async () => {
    const harness = createPluginHarness();
    const plugin = new WAStudioConnector('0.1.0');
    await plugin.onEnable(harness.context);
    const command = textCommand();
    await harness.webhooks.get('commands')!(webhookRequest(command));
    await waitFor(() => evidenceFrom(harness.requests).some(event => event.kind === 'SEND_ACCEPTED'));
    await harness.hooks.get('message:ack')!({
      event: 'message:ack',
      data: { messageId: 'wa-message-1', status: 'delivered' },
      sessionId,
      timestamp: new Date(),
      source: 'Engine',
    });
    await waitFor(() => evidenceFrom(harness.requests).some(event => event.kind === 'ACK_DELIVERED'));

    expect(evidenceFrom(harness.requests).at(-1)).toMatchObject({
      kind: 'ACK_DELIVERED',
      openwaMessageId: 'wa-message-1',
      deliveryStatus: 'DELIVERED',
    });
    await plugin.onDisable();
  });

  it('clears a delivery block after every durable evidence record drains', async () => {
    let rejectEvidence = true;
    const harness = createPluginHarness({
      net: async url => {
        if (url.endsWith('/heartbeat')) {
          return jsonResponse({
            protocolVersion: 1,
            bindings: [{ sessionId, connectorId, webhookId: 'webhook-1', generation: 1, updatedAt: new Date().toISOString() }],
          });
        }
        if (url.endsWith('/events')) {
          return jsonResponse(rejectEvidence ? { error: 'unavailable' } : { accepted: true, duplicate: false }, rejectEvidence ? 503 : 200);
        }
        throw new Error('unexpected request');
      },
    });
    const plugin = new WAStudioConnector('0.1.0');
    await plugin.onEnable(harness.context);
    const handler = harness.webhooks.get('commands')!;
    const command = textCommand();
    const request = webhookRequest(command);

    await handler(request);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitFor(() => harness.requests.filter(candidate => candidate.url.endsWith('/events')).length >= attempt);
      await handler(request);
    }
    await waitFor(asyncHealth(() => plugin.healthCheck(), result => result.message?.includes('evidence_delivery_blocked') === true));

    rejectEvidence = false;
    await handler(request);
    await waitFor(() => evidenceFrom(harness.requests).some(event => event.kind === 'SEND_ACCEPTED'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await plugin.healthCheck()).toEqual({ healthy: true });

    expect([...new Set(evidenceFrom(harness.requests).map(event => event.kind))]).toEqual([
      'COMMAND_RECEIVED',
      'SEND_STARTED',
      'SEND_ACCEPTED',
    ]);
    expect(harness.sent).toHaveLength(1);
    await plugin.onDisable();
  });

  it('compacts expired terminal evidence once before rejecting a new command under pressure', async () => {
    const harness = createPluginHarness();
    const limits = { storageQuotaBytes: 1024 * 1024, terminalRetentionMs: 1 };
    const plugin = new WAStudioConnector('0.1.0', limits);
    await plugin.onEnable(harness.context);

    const oldCommand = textCommand({
      commandId: 'b30309af-d474-40d0-91f5-f6a27f21fb63',
      attemptId: '452b4c6e-9afe-454c-bfb8-1cb8b19fd691',
      content: { type: 'TEXT', text: 'x'.repeat(300_000) },
    });
    const oldJournal = new ConnectorJournal(harness.storage, '0.1.0', limits);
    await oldJournal.receive(
      oldCommand,
      sha256Utf8(JSON.stringify(oldCommand)),
      'webhook-1',
      { now: new Date(0) },
    );
    await oldJournal.markRejected(
      oldCommand.commandId,
      'TRANSIENT_FAILURE',
      'TEST_TERMINAL_RECORD',
      new Date(1),
    );
    const oldRecord = await oldJournal.get(oldCommand.commandId);
    for (const entry of oldRecord?.evidence ?? []) {
      await oldJournal.markEvidenceDelivered(oldCommand.commandId, entry.evidence.eventId, new Date(2));
    }

    const next = textCommand();
    await harness.webhooks.get('commands')!(webhookRequest(next));
    await waitFor(() => evidenceFrom(harness.requests).some(event =>
      event.commandId === next.commandId && event.kind === 'SEND_ACCEPTED'));

    expect(harness.sent).toHaveLength(1);
    expect(harness.logs).toContainEqual(expect.objectContaining({
      level: 'log',
      message: 'wa-studio-connector reclaimed journal capacity',
    }));
    await plugin.onDisable();
  });
});

function webhookRequest(command: ReturnType<typeof textCommand>): WebhookRequest {
  const rawBody = JSON.stringify(command);
  return {
    instanceId: 'wa-studio',
    method: 'POST',
    headers: {},
    query: {},
    body: rawBody,
    rawBody,
    verified: true,
    deliveryId: command.commandId,
    sessionId,
  };
}

function evidenceFrom(requests: Array<{ url: string; init?: Record<string, unknown> }>): ConnectorEvidence[] {
  return requests.filter(request => request.url.endsWith('/events')).map(request => {
    const body = JSON.parse(String(request.init?.body)) as { envelope: { data: ConnectorEvidence } };
    return body.envelope.data;
  });
}

function asyncHealth<T>(read: () => Promise<T>, predicate: (value: T) => boolean): () => boolean {
  let matched = false;
  void read().then(value => { matched = predicate(value); });
  return () => matched;
}
