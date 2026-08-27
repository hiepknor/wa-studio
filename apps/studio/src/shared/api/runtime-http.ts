const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_SUCCESS_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_ERROR_RESPONSE_MAX_BYTES = 256 * 1024;

interface RuntimeHttpPolicy {
  requestTimeoutMs?: number;
  requestMaxBytes?: number;
  successResponseMaxBytes?: number;
  errorResponseMaxBytes?: number;
}

export class RuntimeTransportError extends Error {
  readonly requestDispatched: boolean;

  constructor(
    message: string,
    options: { requestDispatched?: boolean } = {},
  ) {
    super(message);
    this.name = "RuntimeTransportError";
    this.requestDispatched = options.requestDispatched ?? false;
  }
}

export function createRuntimeHttpFetch(
  baseUrl: string,
  upstreamFetch: typeof globalThis.fetch,
  policy: RuntimeHttpPolicy = {},
): typeof globalThis.fetch {
  const origin = new URL(baseUrl).origin;
  const requestTimeoutMs = positiveInteger(
    policy.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "request timeout",
  );
  const requestMaxBytes = positiveInteger(
    policy.requestMaxBytes ?? DEFAULT_REQUEST_MAX_BYTES,
    "request limit",
  );
  const successResponseMaxBytes = positiveInteger(
    policy.successResponseMaxBytes ?? DEFAULT_SUCCESS_RESPONSE_MAX_BYTES,
    "success response limit",
  );
  const errorResponseMaxBytes = positiveInteger(
    policy.errorResponseMaxBytes ?? DEFAULT_ERROR_RESPONSE_MAX_BYTES,
    "error response limit",
  );

  return async (input, init) => {
    const request = new Request(input, init);
    assertRuntimeTarget(request.url, origin);
    const deadline = requestDeadline(request.signal, requestTimeoutMs);
    let requestDispatched = false;

    try {
      await assertBoundedRequestBody(request, requestMaxBytes, deadline.signal);
      const boundedRequest = new Request(request, {
        redirect: "error",
        signal: deadline.signal,
      });
      requestDispatched = true;
      const response = await withAbort(upstreamFetch(boundedRequest), deadline.signal);
      assertRuntimeResponseTarget(response, origin);
      return await cloneBoundedResponse(
        response,
        response.ok ? successResponseMaxBytes : errorResponseMaxBytes,
        deadline.signal,
      );
    } catch (error) {
      if (deadline.didTimeout()) {
        throw new RuntimeTransportError(
          `WA Runtime did not respond within ${Math.ceil(requestTimeoutMs / 1_000)} seconds.`,
          { requestDispatched },
        );
      }
      if (request.signal.aborted) throw abortReason(request.signal);
      throw classifyTransportFailure(error, requestDispatched);
    } finally {
      deadline.dispose();
    }
  };
}

function classifyTransportFailure(
  error: unknown,
  requestDispatched: boolean,
): unknown {
  if (!requestDispatched) return error;
  if (error instanceof RuntimeTransportError) {
    return error.requestDispatched
      ? error
      : new RuntimeTransportError(error.message, { requestDispatched: true });
  }
  return new RuntimeTransportError(
    "WA Runtime connection ended before a complete response was received.",
    { requestDispatched: true },
  );
}

async function assertBoundedRequestBody(
  request: Request,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<void> {
  if (!request.body) return;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    throw requestTooLarge(maximumBytes);
  }
  const bytes = await withAbort(request.clone().arrayBuffer(), signal);
  if (bytes.byteLength > maximumBytes) throw requestTooLarge(maximumBytes);
}

function assertRuntimeTarget(value: string, origin: string): void {
  const target = new URL(value);
  const encodedTraversal = /%(?:25|2e|2f|5c)/iu.test(target.pathname);
  if (
    target.origin !== origin
    || !target.pathname.startsWith("/api/v1/")
    || target.username
    || target.password
    || target.hash
    || encodedTraversal
  ) {
    throw new RuntimeTransportError("WA Runtime request escaped the configured API origin.");
  }
}

function assertRuntimeResponseTarget(response: Response, origin: string): void {
  if (response.redirected || response.type === "opaqueredirect") {
    void response.body?.cancel().catch(() => undefined);
    throw new RuntimeTransportError("WA Runtime redirects are not allowed.");
  }
  if (response.url && new URL(response.url).origin !== origin) {
    void response.body?.cancel().catch(() => undefined);
    throw new RuntimeTransportError("WA Runtime returned a response from another origin.");
  }
}

async function cloneBoundedResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Response> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw responseTooLarge(maximumBytes);
  }

  if (!response.body) {
    return new Response(null, responseInit(response));
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  let cancellation: Promise<void> | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    const reason = signal.reason ?? new DOMException("The request was aborted.", "AbortError");
    cancellation = reader.cancel(reason).catch(() => undefined);
    rejectAbort?.(reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw abortReason(signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(maximumBytes);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    const release = () => {
      try {
        reader.releaseLock();
      } catch {
        // Cancellation owns the reader until its pending read settles.
      }
    };
    if (cancellation) {
      void cancellation.then(release);
    } else {
      release();
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, responseInit(response));
}

function responseInit(response: Response): ResponseInit {
  return {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  };
}

function responseTooLarge(maximumBytes: number): RuntimeTransportError {
  return new RuntimeTransportError(
    `WA Runtime response exceeded the ${formatByteLimit(maximumBytes)} safety limit.`,
  );
}

function requestTooLarge(maximumBytes: number): RuntimeTransportError {
  return new RuntimeTransportError(
    `WA Runtime request exceeded the ${formatByteLimit(maximumBytes)} safety limit.`,
  );
}

function formatByteLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} byte`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Runtime HTTP ${label} must be a positive integer.`);
  }
  return value;
}

function requestDeadline(source: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onSourceAbort = () => controller.abort(
    source.reason ?? new DOMException("The request was aborted.", "AbortError"),
  );
  if (source.aborted) onSourceAbort();
  else source.addEventListener("abort", onSourceAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new RuntimeTransportError("WA Runtime request timed out."));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      source.removeEventListener("abort", onSourceAbort);
    },
  };
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The request was aborted.", "AbortError");
}
