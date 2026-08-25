import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeActivityCursor, encodeActivityCursor } from '../../src/modules/activity/activity-cursor';

describe('activity cursor', () => {
  it('round-trips the deterministic event boundary', () => {
    const cursor = { occurredAt: new Date('2026-08-25T10:00:00.000Z'), id: randomUUID() };
    expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
  });

  it.each([
    'not-json',
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ occurredAt: 'invalid', id: randomUUID() })).toString('base64url'),
    Buffer.from(JSON.stringify({ occurredAt: new Date().toISOString(), id: 'not-a-uuid' })).toString('base64url'),
  ])('rejects malformed cursor %s', (cursor) => {
    expect(decodeActivityCursor(cursor)).toBeNull();
  });
});
