import { invoke } from "@tauri-apps/api/core";

interface NativeRuntimeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding?: "base64" | "utf8";
}

const FORWARDED_HEADERS = new Set(["content-type", "idempotency-key"]);
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

export async function managedRuntimeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : request.signal);
  const url = new URL(request.url);
  if (
    !ALLOWED_METHODS.has(request.method)
    || !url.pathname.startsWith("/api/v1/")
    || url.hash
    || /%(?:25|2e|2f|5c)/iu.test(url.pathname)
  ) {
    throw new Error("Managed Runtime request is outside API v1.");
  }
  throwIfAborted(signal);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (FORWARDED_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  const body = request.method === "GET" || request.method === "HEAD"
    ? null
    : await request.text();
  if (body !== null && new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new Error("Managed Runtime request body exceeds 2 MiB.");
  }
  throwIfAborted(signal);
  const response = await withAbort(
    invoke<NativeRuntimeResponse>("request_managed_runtime", {
      request: {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        body,
      },
    }),
    signal,
  );
  let responseBody: BodyInit | null;
  if (response.bodyEncoding === "base64") {
    responseBody = decodeBase64Body(response.body);
  } else {
    if (response.bodyEncoding && response.bodyEncoding !== "utf8") {
      throw new Error("Managed Runtime response uses an unsupported body encoding.");
    }
    if (new TextEncoder().encode(response.body).byteLength > MAX_RESPONSE_BODY_BYTES) {
      throw new Error("Managed Runtime response exceeds 8 MiB.");
    }
    responseBody = response.body || null;
  }
  return new Response(responseBody, {
    status: response.status,
    headers: response.headers,
  });
}

function decodeBase64Body(value: string): ArrayBuffer {
  if (value.length > Math.ceil(MAX_RESPONSE_BODY_BYTES / 3) * 4) {
    throw new Error("Managed Runtime response exceeds 8 MiB.");
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error("Managed Runtime returned an invalid base64 response.");
  }
  if (decoded.length > MAX_RESPONSE_BODY_BYTES) {
    throw new Error("Managed Runtime response exceeds 8 MiB.");
  }
  const buffer = new ArrayBuffer(decoded.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return buffer;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("The request was aborted.", "AbortError");
  }
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(
    signal.reason ?? new DOMException("The request was aborted.", "AbortError"),
  );
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(
      signal.reason ?? new DOMException("The request was aborted.", "AbortError"),
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
