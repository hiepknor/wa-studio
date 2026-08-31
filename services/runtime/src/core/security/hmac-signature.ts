import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySha256Hmac(
  payload: Buffer,
  supplied: string | undefined,
  secret: string,
): boolean {
  if (!supplied) return false;
  const expected = signSha256Hmac(payload, secret);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export function signSha256Hmac(payload: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}
