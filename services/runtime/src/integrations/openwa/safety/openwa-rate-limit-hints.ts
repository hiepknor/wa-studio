export interface OpenWARateLimitHints {
  retryAfterMs?: number;
  limits: Partial<Record<'short' | 'medium' | 'long', number>>;
  remaining: Partial<Record<'short' | 'medium' | 'long', number>>;
  resetMs: Partial<Record<'short' | 'medium' | 'long', number>>;
}

const tiers = ['short', 'medium', 'long'] as const;
const maximumRetryAfterMs = 24 * 60 * 60 * 1000;

function secondsHeaderMs(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(maximumRetryAfterMs, Math.max(250, Math.ceil(seconds * 1000)));
}

function standardRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maximumRetryAfterMs, Math.max(250, Math.ceil(seconds * 1000)));
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(maximumRetryAfterMs, Math.max(250, at - Date.now()));
}

function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseOpenWARateLimitHints(headers: Headers): OpenWARateLimitHints {
  const limits: OpenWARateLimitHints['limits'] = {};
  const remaining: OpenWARateLimitHints['remaining'] = {};
  const resetMs: OpenWARateLimitHints['resetMs'] = {};
  const retryCandidates = [standardRetryAfterMs(headers)];
  for (const tier of tiers) {
    const limit = numericHeader(headers, `x-ratelimit-limit-${tier}`);
    const left = numericHeader(headers, `x-ratelimit-remaining-${tier}`);
    const reset = secondsHeaderMs(headers, `x-ratelimit-reset-${tier}`);
    const retry = secondsHeaderMs(headers, `retry-after-${tier}`);
    if (limit !== undefined) limits[tier] = limit;
    if (left !== undefined) remaining[tier] = left;
    if (reset !== undefined) resetMs[tier] = reset;
    retryCandidates.push(retry, left === 0 ? reset : undefined);
  }
  const valid = retryCandidates.filter((value): value is number => value !== undefined);
  return {
    ...(valid.length ? { retryAfterMs: Math.max(...valid) } : {}),
    limits,
    remaining,
    resetMs,
  };
}
