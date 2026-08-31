import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OPENWA_CONNECTOR_MAX_IMAGE_BYTES,
  openWAConnectorCommandSchema,
  openWAConnectorEvidenceSchema,
} from '../../src/contracts/openwa-connector';
import { renderOpenWAConnectorContract } from '../../scripts/generate-openwa-connector-contract';
import { encodeOpenWAConnectorCommand } from '../../src/modules/messages/openwa-connector-command';

const identity = {
  protocolVersion: 1,
  commandId: '760ba9a3-606c-4ceb-83ba-d6ea46e73fc1',
  attemptId: '9551a035-740f-4c01-b234-b1306de2fba8',
  sessionId: '91f27e51-fd00-4c07-bfbf-0ddf11a02af6',
  recipientId: '120363040772183977@g.us',
  safetyPermitId: '95837239-3fe1-4427-b6e9-6b807c1aa319',
  bindingGeneration: 4,
  createdAt: '2026-08-31T10:00:00.000Z',
  expiresAt: '2026-08-31T10:05:00.000Z',
};

describe('OpenWA connector protocol v1', () => {
  it('binds each operation to its matching immutable content shape', () => {
    expect(openWAConnectorCommandSchema.safeParse({
      ...identity,
      operation: 'SEND_TEXT',
      content: { type: 'TEXT', text: 'hello' },
    }).success).toBe(true);
    expect(openWAConnectorCommandSchema.safeParse({
      ...identity,
      operation: 'SEND_TEXT',
      content: {
        type: 'IMAGE',
        filename: 'image.png',
        mimeType: 'image/png',
        byteSize: 1,
        sha256: 'a'.repeat(64),
        mediaUrl: 'https://events.example.test/api/v1/media/attempt/token',
        caption: '',
      },
    }).success).toBe(false);
  });

  it('enforces the image byte ceiling and HTTPS media-reference transport', () => {
    const command = {
      ...identity,
      operation: 'SEND_IMAGE',
      content: {
        type: 'IMAGE',
        filename: 'image.webp',
        mimeType: 'image/webp',
        byteSize: OPENWA_CONNECTOR_MAX_IMAGE_BYTES,
        sha256: 'a'.repeat(64),
        mediaUrl: 'https://events.example.test/api/v1/media/9551a035-740f-4c01-b234-b1306de2fba8/token',
        caption: '',
      },
    };
    expect(openWAConnectorCommandSchema.safeParse(command).success).toBe(true);
    expect(openWAConnectorCommandSchema.safeParse({
      ...command,
      content: { ...command.content, byteSize: OPENWA_CONNECTOR_MAX_IMAGE_BYTES + 1 },
    }).success).toBe(false);
    expect(openWAConnectorCommandSchema.safeParse({
      ...command,
      content: { ...command.content, mediaUrl: 'http://events.example.test/media' },
    }).success).toBe(false);
    expect(openWAConnectorCommandSchema.safeParse({
      ...command,
      content: { ...command.content, base64: 'AA==' },
    }).success).toBe(false);
  });

  it('rejects unknown evidence kinds and malformed immutable digests', () => {
    const evidence = {
      protocolVersion: 1,
      eventId: 'f698b26a-b23d-414d-be67-e09b127d6cc8',
      commandId: identity.commandId,
      attemptId: identity.attemptId,
      sessionId: identity.sessionId,
      sequence: 1,
      kind: 'SEND_STARTED',
      openwaMessageId: null,
      deliveryStatus: 'PENDING',
      errorClass: null,
      errorCode: null,
      bindingGeneration: identity.bindingGeneration,
      pluginVersion: '1.0.0',
      occurredAt: identity.createdAt,
      payloadSha256: 'b'.repeat(64),
    };
    expect(openWAConnectorEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(openWAConnectorEvidenceSchema.safeParse({ ...evidence, kind: 'MAYBE_SENT' }).success)
      .toBe(false);
    expect(openWAConnectorEvidenceSchema.safeParse({ ...evidence, payloadSha256: 'nope' }).success)
      .toBe(false);
  });

  it('encodes one canonical byte representation for payload digest and retransmission', () => {
    const left = encodeOpenWAConnectorCommand({
      ...identity,
      operation: 'SEND_TEXT',
      content: { type: 'TEXT', text: 'hello' },
    });
    const right = encodeOpenWAConnectorCommand({
      content: { text: 'hello', type: 'TEXT' },
      operation: 'SEND_TEXT',
      ...identity,
    });
    expect(right.body).toEqual(left.body);
    expect(right.sha256).toBe(left.sha256);
    expect(left.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('keeps checked-in JSON Schemas byte-identical to the generated contract', () => {
    for (const file of renderOpenWAConnectorContract()) {
      const checkedIn = readFileSync(resolve(
        process.cwd(),
        '..',
        '..',
        'packages',
        'runtime-contract',
        'openwa-connector',
        'v1',
        file.filename,
      ), 'utf8');
      expect(checkedIn).toBe(file.contents);
    }
  });
});
