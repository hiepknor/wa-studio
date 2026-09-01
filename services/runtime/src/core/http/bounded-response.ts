export class OutboundResponseTooLargeError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Outbound response exceeded the ${maximumBytes} byte limit`);
    this.name = 'OutboundResponseTooLargeError';
  }
}

export class OutboundResponseParseError extends Error {
  constructor() {
    super('Outbound response was not valid JSON');
    this.name = 'OutboundResponseParseError';
  }
}

export function delayWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    const handleAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      await response.body?.cancel();
      throw new OutboundResponseTooLargeError(maximumBytes);
    }
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel();
        throw new OutboundResponseTooLargeError(maximumBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function readBoundedResponseJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const body = await readBoundedResponseText(response, maximumBytes);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new OutboundResponseParseError();
  }
}
