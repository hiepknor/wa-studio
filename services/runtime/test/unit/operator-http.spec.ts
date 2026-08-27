import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboundResponseTooLargeError } from '../../src/core/http/bounded-response';
import {
  OperatorHttpError,
  operatorJsonRequest,
  parseRuntimeApiRoot,
  runtimeApiRootFromOrigin,
} from '../../scripts/lib/operator-http';

const runtimeKey = 'runtime-key-with-at-least-32-characters';

afterEach(() => vi.unstubAllGlobals());

describe('operator HTTP client', () => {
  it('accepts an exact API root and allows plaintext only on loopback', () => {
    expect(parseRuntimeApiRoot('https://runtime.example.test/api/v1').toString())
      .toBe('https://runtime.example.test/api/v1/');
    expect(runtimeApiRootFromOrigin('http://127.0.0.1:3100').toString())
      .toBe('http://127.0.0.1:3100/api/v1/');

    expect(() => parseRuntimeApiRoot('http://runtime.example.test/api/v1'))
      .toThrow('must use HTTPS');
    expect(parseRuntimeApiRoot('http://api:3100/api/v1', { allowInsecureHttp: true }).toString())
      .toBe('http://api:3100/api/v1/');
    expect(() => parseRuntimeApiRoot('https://user:secret@runtime.example.test/api/v1'))
      .toThrow('without credentials');
    expect(() => parseRuntimeApiRoot('https://runtime.example.test/custom'))
      .toThrow('must target /api/v1');
    expect(() => runtimeApiRootFromOrigin('https://runtime.example.test/custom'))
      .toThrow('must be an origin');
  });

  it('sends the Runtime key only to a bounded, non-redirecting request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'ready' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(operatorJsonRequest(
      parseRuntimeApiRoot('https://runtime.example.test/api/v1'),
      runtimeKey,
      '/health/ready',
    )).resolves.toEqual({ status: 'ready' });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://runtime.example.test/api/v1/health/ready');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get('x-runtime-key')).toBe(runtimeKey);
  });

  it('reports only a safe machine code from upstream errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      code: 'RESOURCE_NOT_FOUND',
      message: 'operator secret must not escape',
      details: { token: 'secret-token' },
    }, 404)));

    const failure = await operatorJsonRequest(
      parseRuntimeApiRoot('https://runtime.example.test/api/v1'),
      runtimeKey,
      '/sessions/missing',
    ).catch(error => error);

    expect(failure).toBeInstanceOf(OperatorHttpError);
    expect(failure).toMatchObject({ status: 404, upstreamCode: 'RESOURCE_NOT_FOUND' });
    expect((failure as Error).message).not.toContain('operator secret');
    expect((failure as Error).message).not.toContain('secret-token');
  });

  it('rejects oversized success bodies and paths escaping the API root', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    })));
    const root = parseRuntimeApiRoot('https://runtime.example.test/api/v1');

    await expect(operatorJsonRequest(root, runtimeKey, '/sessions'))
      .rejects.toBeInstanceOf(OutboundResponseTooLargeError);
    await expect(operatorJsonRequest(root, runtimeKey, '//attacker.example.test'))
      .rejects.toThrow('path is invalid');
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
