import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEventInboxConfig } from '../../src/core/event-inbox/event-inbox-config';
import { OutboundResponseTooLargeError } from '../../src/core/http/bounded-response';
import { OPENWA_RELEASE_TAG } from '../../src/contracts/release/openwa-release.generated';
import { EventInboxOpenWAClient } from '../../src/integrations/openwa/event-inbox-openwa.client';

const sessionId = '00000000-0000-4000-8000-000000000001';

const config = () => parseEventInboxConfig({
  NODE_ENV: 'test',
  EVENT_INBOX_DATABASE_URL: 'postgresql://events:events@postgres.test/events',
  EVENT_INBOX_MASTER_SECRET: 'event-inbox-master-secret-with-at-least-32-characters',
  EVENT_INBOX_PUBLIC_BASE_URL: 'http://127.0.0.1:34200',
  EVENT_INBOX_OPENWA_BASE_URL: 'http://127.0.0.1:2785',
  EVENT_INBOX_OPENWA_RESPONSE_MAX_BYTES: '65536',
  EVENT_INBOX_ALLOWED_SESSION_IDS: sessionId,
});

afterEach(() => vi.unstubAllGlobals());

describe('EventInboxOpenWAClient', () => {
  it('probes only the configured origin without following redirects', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ version: OPENWA_RELEASE_TAG }))
      .mockResolvedValueOnce(jsonResponse([{ id: sessionId }]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EventInboxOpenWAClient(config()).validateCredentials(
      'http://127.0.0.1:2785',
      'operator-key',
    )).resolves.toEqual([sessionId]);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:2785/api/health');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('x-api-key')).toBe('operator-key');
  });

  it('rejects an unconfigured origin before sending credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EventInboxOpenWAClient(config()).validateCredentials(
      'https://attacker.example.test',
      'operator-key',
    )).rejects.toThrow('origin is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized credential-probe response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      headers: { 'content-length': '65537' },
    })));

    await expect(new EventInboxOpenWAClient(config()).validateCredentials(
      'http://127.0.0.1:2785',
      'operator-key',
    )).rejects.toBeInstanceOf(OutboundResponseTooLargeError);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
