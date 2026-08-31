import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/protocol';
import { imageCommand, textCommand } from './fixtures';

describe('connector protocol consumer', () => {
  it('accepts the public Runtime command schema', () => {
    expect(parseCommand(JSON.stringify(textCommand())).operation).toBe('SEND_TEXT');
    expect(parseCommand(JSON.stringify(imageCommand())).operation).toBe('SEND_IMAGE');
  });

  it('enforces semantic expiry and media transport invariants not weakened by JSON parsing', () => {
    const command = textCommand();
    expect(() => parseCommand(JSON.stringify({
      ...command,
      expiresAt: new Date(new Date(command.createdAt).valueOf() + 3_600_001).toISOString(),
    }))).toThrow('expiry window');
    const image = imageCommand();
    expect(() => parseCommand(JSON.stringify({
      ...image,
      content: { ...image.content, mediaUrl: 'http://events.example.test/media' },
    }))).toThrow('media URL must use HTTPS');
  });

  it('rejects unknown fields and operation/content mismatches', () => {
    expect(() => parseCommand(JSON.stringify({ ...textCommand(), unexpected: true })))
      .toThrow('schema mismatch');
    expect(() => parseCommand(JSON.stringify({
      ...textCommand(),
      operation: 'SEND_IMAGE',
    }))).toThrow('schema mismatch');
  });
});
