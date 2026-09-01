import { describe, expect, it } from 'vitest';
import { parseOpenWARateLimitHints } from '../../src/integrations/openwa/safety/openwa-rate-limit-hints';

describe('OpenWA rate-limit hints', () => {
  it('honors the longest named Retry-After window', () => {
    const hints = parseOpenWARateLimitHints(new Headers({
      'retry-after': '2',
      'retry-after-short': '3',
      'retry-after-medium': '45',
      'retry-after-long': '900',
    }));
    expect(hints.retryAfterMs).toBe(900_000);
  });

  it('uses an exhausted reset window even when Retry-After is absent', () => {
    const hints = parseOpenWARateLimitHints(new Headers({
      'x-ratelimit-limit-long': '1000',
      'x-ratelimit-remaining-long': '0',
      'x-ratelimit-reset-long': '3600',
    }));
    expect(hints.retryAfterMs).toBe(3_600_000);
    expect(hints.limits.long).toBe(1000);
    expect(hints.remaining.long).toBe(0);
  });

  it('ignores malformed values and caps hostile delays at one day', () => {
    const malformed = parseOpenWARateLimitHints(new Headers({
      'retry-after-short': 'later',
      'x-ratelimit-reset-short': '-1',
    }));
    expect(malformed.retryAfterMs).toBeUndefined();

    const capped = parseOpenWARateLimitHints(new Headers({ 'retry-after-long': '999999999' }));
    expect(capped.retryAfterMs).toBe(86_400_000);
  });
});
