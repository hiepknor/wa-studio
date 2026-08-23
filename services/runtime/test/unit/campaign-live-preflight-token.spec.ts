import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import type { CampaignPreflightDto } from '../../src/contracts/campaigns/campaign-preflight.dto';
import {
  CampaignLivePreflightTokenService,
  InvalidCampaignLivePreflightTokenError,
} from '../../src/modules/campaigns/campaign-live-preflight-token.service';

const campaignId = '10000000-0000-4000-8000-000000000001';
const sessionId = '10000000-0000-4000-8000-000000000002';
const checkedAt = new Date('2026-08-23T10:00:00.000Z');

const config = parseRuntimeConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
  REDIS_URL: 'redis://redis.test:6379',
  RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
  OPENWA_BASE_URL: 'http://openwa.test:2785',
  OPENWA_API_KEY: 'openwa-key',
  OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
  OPENWA_ALLOWED_SESSION_IDS: sessionId,
  ALLOW_LIVE_SENDS: 'true',
  CAMPAIGN_LIVE_PREFLIGHT_TTL_SECONDS: '120',
});

const report: CampaignPreflightDto = {
  status: 'PASS' as never,
  policyVersion: 2,
  campaignRevision: 7,
  targetsRevision: 4,
  executionMode: 'LIVE' as never,
  checkedAt,
  totalTargets: 1,
  allowedTargets: 1,
  deniedTargets: 0,
  unknownTargets: 0,
  checks: [],
  targetIssues: [],
};

describe('Campaign LIVE preflight token', () => {
  it('signs a short-lived proof bound to campaign, session, and both reviewed revisions', () => {
    const tokens = new CampaignLivePreflightTokenService(config);
    const issued = tokens.issue({ campaignId, sessionId, report });

    expect(issued.expiresAt).toEqual(new Date('2026-08-23T10:02:00.000Z'));
    expect(tokens.verify(issued.token, {
      campaignId, sessionId, campaignRevision: 7, targetsRevision: 4,
    }, new Date('2026-08-23T10:01:59.000Z'))).toMatchObject({
      version: 1, campaignId, sessionId, campaignRevision: 7, targetsRevision: 4, policyVersion: 2,
    });
  });

  it('rejects expiry, tampering, and cross-snapshot reuse but authenticates an expired replay proof', () => {
    const tokens = new CampaignLivePreflightTokenService(config);
    const issued = tokens.issue({ campaignId, sessionId, report });
    const expected = { campaignId, sessionId, campaignRevision: 7, targetsRevision: 4 };

    expect(() => tokens.verify(issued.token, expected, issued.expiresAt))
      .toThrow(new InvalidCampaignLivePreflightTokenError('EXPIRED'));
    expect(tokens.verify(issued.token, expected, issued.expiresAt, { allowExpired: true }))
      .toMatchObject(expected);
    expect(() => tokens.verify(`${issued.token.slice(0, -1)}x`, expected, checkedAt))
      .toThrow(new InvalidCampaignLivePreflightTokenError('INVALID'));
    expect(() => tokens.verify(issued.token, { ...expected, targetsRevision: 5 }, checkedAt))
      .toThrow(new InvalidCampaignLivePreflightTokenError('MISMATCH'));
  });
});
