import {
  readBoundedResponseJson,
  readBoundedResponseText,
} from '../../src/core/http/bounded-response';

const maximumSuccessResponseBytes = 4 * 1024 * 1024;
const maximumErrorResponseBytes = 64 * 1024;
const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

export class OperatorHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly upstreamCode?: string,
  ) {
    super(`${method} ${path} failed with HTTP ${status}${upstreamCode ? ` (${upstreamCode})` : ''}`);
    this.name = 'OperatorHttpError';
  }
}

export function parseRuntimeApiRoot(
  value: string,
  options: { allowInsecureHttp?: boolean } = {},
): URL {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/u, '') || '/';
  if (url.username || url.password || url.search || url.hash || path !== '/api/v1') {
    throw new Error('Runtime API URL must target /api/v1 without credentials, query or fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:'
    && (loopbackHosts.has(url.hostname) || options.allowInsecureHttp === true))) {
    throw new Error('Runtime API URL must use HTTPS outside loopback');
  }
  url.pathname = '/api/v1/';
  return url;
}

export function runtimeApiRootFromOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.username || origin.password || origin.search || origin.hash
    || !['', '/'].includes(origin.pathname)) {
    throw new Error('Runtime URL must be an origin without credentials, path, query or fragment');
  }
  return parseRuntimeApiRoot(new URL('/api/v1', origin).toString());
}

export async function operatorJsonRequest<T = unknown>(
  root: URL,
  runtimeKey: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<T> {
  if (runtimeKey.length < 32 || runtimeKey.length > 4096) {
    throw new Error('Runtime key must contain between 32 and 4096 characters');
  }
  if (!/^\/[A-Za-z0-9]/u.test(path) || path.includes('\\') || path.includes('//')) {
    throw new Error('Runtime API request path is invalid');
  }
  const url = new URL(`.${path}`, root);
  if (url.origin !== root.origin || !url.pathname.startsWith('/api/v1/')) {
    throw new Error('Runtime API request escaped the configured API root');
  }

  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('x-runtime-key', runtimeKey);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const method = init.method ?? 'GET';
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await readBoundedResponseText(response, maximumErrorResponseBytes);
    throw new OperatorHttpError(method, path, response.status, safeRuntimeErrorCode(body));
  }
  return await readBoundedResponseJson(response, maximumSuccessResponseBytes) as T;
}

function safeRuntimeErrorCode(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as { code?: unknown };
    return typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value.code)
      ? value.code
      : undefined;
  } catch {
    return undefined;
  }
}
