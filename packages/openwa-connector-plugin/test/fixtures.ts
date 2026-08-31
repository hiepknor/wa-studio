import type { ConnectorCommand } from '../src/protocol';

export const sessionId = '91f27e51-fd00-4c07-bfbf-0ddf11a02af6';
export const connectorId = '760ba9a3-606c-4ceb-83ba-d6ea46e73fc1';

export function textCommand(overrides: Partial<ConnectorCommand> = {}): ConnectorCommand {
  const now = new Date();
  return {
    protocolVersion: 1,
    commandId: '760ba9a3-606c-4ceb-83ba-d6ea46e73fc1',
    attemptId: '9551a035-740f-4c01-b234-b1306de2fba8',
    sessionId,
    recipientId: '120363040772183977@g.us',
    safetyPermitId: '95837239-3fe1-4427-b6e9-6b807c1aa319',
    bindingGeneration: 1,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.valueOf() + 300_000).toISOString(),
    operation: 'SEND_TEXT',
    content: { type: 'TEXT', text: 'hello' },
    ...overrides,
  } as ConnectorCommand;
}

export function imageCommand(): ConnectorCommand {
  const command = textCommand();
  return {
    ...command,
    operation: 'SEND_IMAGE',
    content: {
      type: 'IMAGE',
      filename: 'watch.png',
      mimeType: 'image/png',
      byteSize: 1_024,
      sha256: 'a'.repeat(64),
      mediaUrl: `https://events.example.test/api/v1/media/${command.attemptId}/${'t'.repeat(43)}`,
      caption: 'watch',
    },
  };
}
