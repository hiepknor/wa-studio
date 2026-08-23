import { invoke } from "@tauri-apps/api/core";

interface NativeRuntimeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const FORWARDED_HEADERS = new Set(["content-type", "idempotency-key"]);

export async function managedRuntimeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (FORWARDED_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  const body = request.method === "GET" || request.method === "HEAD"
    ? null
    : await request.text();
  const response = await invoke<NativeRuntimeResponse>("request_managed_runtime", {
    request: {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      body,
    },
  });
  return new Response(response.body || null, {
    status: response.status,
    headers: response.headers,
  });
}
