import { verifySha256Hmac } from '../../core/security/hmac-signature';

export function verifyOpenWASignature(rawBody: Buffer, supplied: string | undefined, secret: string): boolean {
  return verifySha256Hmac(rawBody, supplied, secret);
}
