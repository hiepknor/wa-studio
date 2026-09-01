import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

const webhookPath = '/api/v1/webhooks/openwa';
const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface WebhookProxyOptions {
  runtimePort: number;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  upstreamTimeoutMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
}

class ProxyPayloadTooLargeError extends Error {}
class ProxyResponseTooLargeError extends Error {}

export function createWebhookProxy(options: WebhookProxyOptions): Server {
  const server = createServer((incoming, outgoing) => {
    void handleRequest(incoming, outgoing, options).catch(error => {
      if (outgoing.headersSent || outgoing.destroyed) {
        outgoing.destroy();
        return;
      }
      if (error instanceof ProxyPayloadTooLargeError) {
        writeJson(outgoing, 413, 'PAYLOAD_TOO_LARGE', 'Webhook body exceeds the proxy limit');
        return;
      }
      writeJson(outgoing, 502, 'UPSTREAM_UNAVAILABLE', 'Runtime webhook endpoint is unavailable');
    });
  });
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = options.headersTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  return server;
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: WebhookProxyOptions,
): Promise<void> {
  const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
  if (incoming.method !== 'POST' || url.pathname !== webhookPath || url.search !== '') {
    incoming.resume();
    writeJson(outgoing, 404, 'RESOURCE_NOT_FOUND', 'Not found');
    return;
  }

  const body = await collectBody(incoming, options.maximumRequestBytes, 'request');
  const upstream = await sendToRuntime(body, incoming.headers, options);
  outgoing.writeHead(upstream.status, forwardedHeaders(upstream.headers));
  outgoing.end(upstream.body);
}

function sendToRuntime(
  body: Buffer,
  incomingHeaders: IncomingHttpHeaders,
  options: WebhookProxyOptions,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers = forwardedHeaders(incomingHeaders);
    headers.host = `127.0.0.1:${options.runtimePort}`;
    headers['content-length'] = String(body.byteLength);
    const upstream = request({
      hostname: '127.0.0.1',
      port: options.runtimePort,
      path: webhookPath,
      method: 'POST',
      headers,
    }, response => {
      collectBody(response, options.maximumResponseBytes, 'response')
        .then(responseBody => resolve({
          status: response.statusCode ?? 502,
          headers: response.headers,
          body: responseBody,
        }))
        .catch(error => {
          response.destroy();
          reject(error);
        });
    });
    upstream.setTimeout(options.upstreamTimeoutMs, () => {
      upstream.destroy(new Error('Runtime webhook request timed out'));
    });
    upstream.once('error', reject);
    upstream.end(body);
  });
}

async function collectBody(
  message: IncomingMessage,
  maximumBytes: number,
  boundary: 'request' | 'response',
): Promise<Buffer> {
  const tooLarge = () => boundary === 'request'
    ? new ProxyPayloadTooLargeError()
    : new ProxyResponseTooLargeError();
  const declaredLength = Number(message.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    message.resume();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let exceeded = false;
  for await (const chunk of message) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    receivedBytes += bytes.byteLength;
    if (receivedBytes > maximumBytes) {
      exceeded = true;
      chunks.length = 0;
      continue;
    }
    if (!exceeded) chunks.push(bytes);
  }
  if (exceeded) throw tooLarge();
  return Buffer.concat(chunks, receivedBytes);
}

function forwardedHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) =>
    value !== undefined && name !== 'host' && name !== 'content-length' && !hopByHopHeaders.has(name),
  ));
}

function writeJson(response: ServerResponse, status: number, code: string, message: string): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify({ code, message, details: {} }));
}

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function main(): Promise<void> {
  const listenPort = integerSetting('WEBHOOK_PROXY_PORT', 3101, 1, 65_535);
  const options: WebhookProxyOptions = {
    runtimePort: integerSetting('PORT', 3100, 1, 65_535),
    maximumRequestBytes: integerSetting('WEBHOOK_PROXY_MAX_BODY_BYTES', 1_048_576, 65_536, 16_777_216),
    maximumResponseBytes: integerSetting('WEBHOOK_PROXY_MAX_RESPONSE_BYTES', 1_048_576, 65_536, 16_777_216),
    upstreamTimeoutMs: integerSetting('WEBHOOK_PROXY_UPSTREAM_TIMEOUT_MS', 30_000, 1_000, 120_000),
    requestTimeoutMs: integerSetting('WEBHOOK_PROXY_REQUEST_TIMEOUT_MS', 30_000, 1_000, 120_000),
    headersTimeoutMs: integerSetting('WEBHOOK_PROXY_HEADERS_TIMEOUT_MS', 10_000, 1_000, 60_000),
  };
  if (options.headersTimeoutMs > options.requestTimeoutMs) {
    throw new Error('WEBHOOK_PROXY_HEADERS_TIMEOUT_MS cannot exceed WEBHOOK_PROXY_REQUEST_TIMEOUT_MS');
  }
  const server = createWebhookProxy(options);
  server.listen(listenPort, '127.0.0.1', () => {
    process.stdout.write(`Webhook-only proxy listening on http://127.0.0.1:${listenPort}${webhookPath}\n`);
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
    forceClose.unref();
    server.close(error => {
      clearTimeout(forceClose);
      if (error) {
        process.stderr.write('Webhook proxy shutdown failed.\n');
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
