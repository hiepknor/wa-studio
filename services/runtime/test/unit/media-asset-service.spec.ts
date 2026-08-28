import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import { MediaAssetError } from '../../src/modules/media-assets/media-asset.error';
import type { MediaAssetRepository } from '../../src/modules/media-assets/media-asset.repository';
import { MediaAssetService } from '../../src/modules/media-assets/media-asset.service';
import type { SessionScopeService } from '../../src/modules/gateway/session-scope.service';

const config = () => parseRuntimeConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
  REDIS_URL: 'redis://redis.test:6379',
  RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
  OPENWA_BASE_URL: 'http://openwa.test:2785',
  OPENWA_API_KEY: 'openwa-key',
  OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
  OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
});

describe('MediaAssetService live-read integrity', () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const service = (content: Buffer, sha256: string) => new MediaAssetService({
    readAsset: vi.fn().mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      sessionId,
      kind: 'IMAGE',
      filename: 'launch.png',
      mimeType: 'image/png',
      byteSize: content.byteLength,
      sha256,
      content,
      createdAt: new Date(),
    }),
  } as unknown as MediaAssetRepository, {} as SessionScopeService, config());

  it('returns bytes only when they still match the verified digest', async () => {
    const sha256 = createHash('sha256').update(image).digest('hex');
    await expect(service(image, sha256).readForSend(
      '22222222-2222-4222-8222-222222222222',
      sessionId,
    )).resolves.toMatchObject({ sha256, content: image });
  });

  it('blocks a corrupted stored image before any upstream send', async () => {
    const failure = await service(image, 'a'.repeat(64)).readForSend(
      '22222222-2222-4222-8222-222222222222',
      sessionId,
    ).catch(error => error);
    expect(failure).toBeInstanceOf(MediaAssetError);
    expect(failure.getResponse()).toMatchObject({ code: 'MEDIA_DIGEST_MISMATCH' });
  });
});
