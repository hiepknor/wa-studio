import { describe, expect, it } from 'vitest';
import {
  OutboundResponseTooLargeError,
  OutboundResponseParseError,
  readBoundedResponseJson,
  readBoundedResponseText,
} from '../../src/core/http/bounded-response';

describe('bounded outbound responses', () => {
  it('rejects a declared body that exceeds the limit before reading it', async () => {
    const response = new Response('small', { headers: { 'content-length': '1025' } });

    await expect(readBoundedResponseText(response, 1024))
      .rejects.toBeInstanceOf(OutboundResponseTooLargeError);
    expect(response.bodyUsed).toBe(true);
  });

  it('enforces the limit while streaming when content-length is absent', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(400));
        controller.close();
      },
    }));

    await expect(readBoundedResponseText(response, 1024))
      .rejects.toBeInstanceOf(OutboundResponseTooLargeError);
  });

  it('decodes and parses a bounded multi-chunk JSON response', async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"status":'));
        controller.enqueue(encoder.encode('"ok"}'));
        controller.close();
      },
    }));

    await expect(readBoundedResponseJson(response, 1024)).resolves.toEqual({ status: 'ok' });
  });

  it('does not echo malformed upstream data through parse errors', async () => {
    const response = new Response('{"operatorSecret":"do-not-echo"');

    const failure = await readBoundedResponseJson(response, 1024).catch(error => error);
    expect(failure).toBeInstanceOf(OutboundResponseParseError);
    expect((failure as Error).message).not.toContain('do-not-echo');
  });
});
