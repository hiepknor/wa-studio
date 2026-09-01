import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/core/config/runtime-config';
import {
  OpenWACompatibilityService,
  OpenWAIncompatibleReleaseError,
  OpenWAUnavailableError,
} from '../../src/integrations/openwa/openwa-compatibility.service';

const config = (): RuntimeConfig => ({
  OPENWA_BASE_URL: 'http://openwa.test',
  OPENWA_API_KEY: 'test-key',
  OPENWA_RELEASE_TAG: '0.22.0',
  OPENWA_COMPATIBILITY_PROBE_TIMEOUT_MS: 5_000,
  OPENWA_COMPATIBILITY_FRESHNESS_MS: 60_000,
} as RuntimeConfig);

const healthResponse = (version = '0.22.0') => new Response(JSON.stringify({
  status: 'ok',
  timestamp: '2026-08-29T00:00:00.000Z',
  version,
}), { headers: { 'content-type': 'application/json' } });

describe('OpenWACompatibilityService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('caches a compatible release inside the bounded freshness window', async () => {
    const fetchMock = vi.fn().mockResolvedValue(healthResponse());
    vi.stubGlobal('fetch', fetchMock);
    const compatibility = new OpenWACompatibilityService(config());

    await expect(compatibility.requireCompatible()).resolves.toBeUndefined();
    await expect(compatibility.requireCompatible()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(compatibility.snapshot()).toMatchObject({
      status: 'COMPATIBLE',
      expectedRelease: '0.22.0',
      observedRelease: '0.22.0',
      reason: null,
    });
  });

  it('opens the circuit when the live release differs from the reviewed pin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse('0.23.0')));
    const compatibility = new OpenWACompatibilityService(config());

    await expect(compatibility.requireCompatible())
      .rejects.toBeInstanceOf(OpenWAIncompatibleReleaseError);
    expect(compatibility.snapshot()).toMatchObject({
      status: 'INCOMPATIBLE',
      expectedRelease: '0.22.0',
      observedRelease: '0.23.0',
      reason: 'release_mismatch',
    });
  });

  it('opens the circuit without leaking network details when the probe fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('secret endpoint failure'));
    vi.stubGlobal('fetch', fetchMock);
    const compatibility = new OpenWACompatibilityService(config());

    await expect(compatibility.requireCompatible()).rejects.toBeInstanceOf(OpenWAUnavailableError);
    await expect(compatibility.requireCompatible()).rejects.not.toThrow(/secret endpoint failure/u);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(compatibility.snapshot()).toMatchObject({
      status: 'UNAVAILABLE',
      observedRelease: null,
      reason: 'network_error',
    });
  });

  it('deduplicates concurrent probes into one upstream health request', async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { resolveResponse = resolve; });
    const fetchMock = vi.fn().mockReturnValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const compatibility = new OpenWACompatibilityService(config());

    const first = compatibility.probe({ force: true });
    const second = compatibility.probe({ force: true });
    resolveResponse(healthResponse());

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
