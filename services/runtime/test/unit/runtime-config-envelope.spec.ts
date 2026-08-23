import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptRuntimeConfigEnvelope } from '../../src/core/config/runtime-config-envelope';

const aad = Buffer.from('wa-runtime-config-envelope:v1');

function envelope(environment: Record<string, string>, key: Buffer, nonce: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(environment), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    nonceHex: nonce.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
  });
}

describe('Runtime configuration envelope', () => {
  it('decrypts an authenticated environment produced by the desktop supervisor', () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(12, 3);
    const encoded = envelope({
      RUNTIME_API_KEY: 'runtime-secret',
      DATABASE_URL: 'postgresql://runtime-secret',
    }, key, nonce);

    expect(decryptRuntimeConfigEnvelope(encoded, key.toString('hex'))).toEqual({
      RUNTIME_API_KEY: 'runtime-secret',
      DATABASE_URL: 'postgresql://runtime-secret',
    });
    expect(encoded).not.toContain('runtime-secret');
  });

  it('fails closed for a wrong key, corrupted ciphertext, or invalid environment keys', () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(12, 3);
    const encoded = envelope({ RUNTIME_API_KEY: 'runtime-secret' }, key, nonce);
    const corrupted = JSON.stringify({ ...JSON.parse(encoded), ciphertextHex: `${'00'.repeat(17)}` });

    expect(() => decryptRuntimeConfigEnvelope(encoded, Buffer.alloc(32, 8).toString('hex')))
      .toThrow('authentication failed');
    expect(() => decryptRuntimeConfigEnvelope(corrupted, key.toString('hex')))
      .toThrow('authentication failed');
    expect(() => decryptRuntimeConfigEnvelope(
      envelope({ 'invalid-name': 'value' }, key, nonce),
      key.toString('hex'),
    )).toThrow('payload is invalid');
  });
});
