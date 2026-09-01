import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEventInboxConfig } from '../../src/core/event-inbox/event-inbox-config';
import { EventInboxTokenService } from '../../src/core/event-inbox/event-inbox-token.service';
import type { EventInboxDeviceRepository } from '../../src/modules/event-inbox/event-inbox-device.repository';
import {
  EventInboxMediaDownloadController,
  EventInboxMediaUploadController,
} from '../../src/modules/event-inbox/event-inbox-media.controller';
import type { EventInboxMediaRepository } from '../../src/modules/event-inbox/event-inbox-media.repository';

const sessionId = '00000000-0000-4000-8000-000000000001';
const deviceId = '00000000-0000-4000-8000-000000000002';
const attemptId = '00000000-0000-4000-8000-000000000003';
const masterSecret = 'event-inbox-master-secret-with-at-least-32-characters';
const now = new Date('2026-08-31T08:00:00.000Z');
const expiresAt = new Date(now.getTime() + 300_000);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha256 = createHash('sha256').update(png).digest('hex');

const config = parseEventInboxConfig({
  NODE_ENV: 'test',
  EVENT_INBOX_DATABASE_URL: 'postgresql://events:events@postgres.test:5432/events',
  EVENT_INBOX_MASTER_SECRET: masterSecret,
  EVENT_INBOX_PUBLIC_BASE_URL: 'http://127.0.0.1:34200',
  EVENT_INBOX_OPENWA_BASE_URL: 'http://127.0.0.1:2785',
  EVENT_INBOX_ALLOWED_SESSION_IDS: sessionId,
});

afterEach(() => vi.useRealTimers());

describe('Event Inbox connector media relay', () => {
  it('accepts an authenticated image only when bytes, MIME and digest agree', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const repository = {
      store: vi.fn().mockResolvedValue({
        kind: 'stored',
        value: {
          attemptId,
          sessionId,
          mediaUrl: `https://events.example.test/api/v1/media/${attemptId}/token`,
          filename: 'watch.png',
          mimeType: 'image/png',
          byteSize: png.length,
          sha256,
          expiresAt: expiresAt.toISOString(),
          duplicate: false,
        },
      }),
    };
    const devices = {
      authorize: vi.fn().mockResolvedValue({
        deviceId,
        tokenGeneration: 1,
        tokenVersion: 2,
        sessionIds: [sessionId],
      }),
    };
    const tokens = new EventInboxTokenService(config);
    const token = tokens.issueDeviceToken(
      deviceId,
      1,
      now,
      new Date(now.getTime() + 86_400_000),
    );
    const controller = new EventInboxMediaUploadController(
      repository as unknown as EventInboxMediaRepository,
      tokens,
      devices as unknown as EventInboxDeviceRepository,
      config,
    );
    await expect(controller.upload(
      attemptId,
      `Bearer ${token}`,
      sessionId,
      sha256,
      Buffer.from('watch.png').toString('base64url'),
      expiresAt.toISOString(),
      'image/png',
      png,
    )).resolves.toMatchObject({ attemptId, mediaUrl: expect.stringContaining('/media/') });
    expect(repository.store).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId, tokenGeneration: 1 }),
      expect.objectContaining({
        attemptId,
        sessionId,
        filename: 'watch.png',
        mimeType: 'image/png',
        sha256,
        content: png,
      }),
    );

    await expect(controller.upload(
      attemptId,
      `Bearer ${token}`,
      sessionId,
      'a'.repeat(64),
      Buffer.from('watch.png').toString('base64url'),
      expiresAt.toISOString(),
      'image/png',
      png,
    )).rejects.toThrow('digest does not match');
    expect(repository.store).toHaveBeenCalledTimes(1);

    await expect(controller.upload(
      attemptId,
      `Bearer ${token}`,
      sessionId,
      sha256,
      Buffer.from('watch.png').toString('base64url'),
      expiresAt.toISOString(),
      'image/png',
      [png] as unknown,
    )).rejects.toThrow('requires a binary image body');
    expect(repository.store).toHaveBeenCalledTimes(1);
  });

  it('serves bounded HEAD/GET responses without exposing a listing endpoint', async () => {
    const repository = {
      download: vi.fn().mockResolvedValue({
        filename: 'watch.png',
        mimeType: 'image/png',
        byteSize: png.length,
        sha256,
        expiresAt,
        content: png,
      }),
    };
    const response = responseMock();
    const controller = new EventInboxMediaDownloadController(
      repository as unknown as EventInboxMediaRepository,
    );
    const token = 'A'.repeat(43);
    await controller.head(attemptId, token, response.value);
    expect(repository.download).toHaveBeenLastCalledWith(attemptId, token, false);
    expect(response.end).toHaveBeenCalledOnce();
    expect(response.send).not.toHaveBeenCalled();

    await controller.get(attemptId, token, response.value);
    expect(repository.download).toHaveBeenLastCalledWith(attemptId, token, true);
    expect(response.send).toHaveBeenCalledWith(png);
    expect(response.setHeader).toHaveBeenCalledWith('x-wa-content-sha256', sha256);

    await expect(controller.get(attemptId, 'short', response.value)).rejects.toMatchObject({
      status: 404,
    });
  });
});

function responseMock() {
  const setHeader = vi.fn();
  const send = vi.fn();
  const end = vi.fn();
  const response = {
    setHeader,
    status: vi.fn().mockReturnThis(),
    send,
    end,
  };
  return { value: response as never, setHeader, send, end };
}
