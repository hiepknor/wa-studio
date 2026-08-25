import { isUUID } from 'class-validator';

export interface ActivityCursor {
  occurredAt: Date;
  id: string;
}

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify({
    occurredAt: cursor.occurredAt.toISOString(),
    id: cursor.id,
  }), 'utf8').toString('base64url');
}

export function decodeActivityCursor(value: string): ActivityCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object') return null;
    const occurredAtValue = (decoded as { occurredAt?: unknown }).occurredAt;
    const id = (decoded as { id?: unknown }).id;
    if (typeof occurredAtValue !== 'string' || typeof id !== 'string' || !isUUID(id)) return null;
    const occurredAt = new Date(occurredAtValue);
    if (!Number.isFinite(occurredAt.valueOf())) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}
