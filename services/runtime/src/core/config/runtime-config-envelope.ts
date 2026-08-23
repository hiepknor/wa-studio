import { createDecipheriv } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';

const ENVELOPE_AAD = Buffer.from('wa-runtime-config-envelope:v1');
const ENVELOPE_PATH_VARIABLE = 'RUNTIME_CONFIG_ENVELOPE_PATH';

interface RuntimeConfigEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  nonceHex: string;
  ciphertextHex: string;
}

export async function loadRuntimeConfigEnvelope(): Promise<void> {
  const path = process.env[ENVELOPE_PATH_VARIABLE];
  if (!path) return;

  const keyHex = await readKeyLine();
  let encoded: string;
  try {
    encoded = readFileSync(path, 'utf8');
  } finally {
    unlinkSync(path);
  }
  const environment = decryptRuntimeConfigEnvelope(encoded, keyHex);
  for (const [name, value] of Object.entries(environment)) {
    process.env[name] = value;
  }
  delete process.env[ENVELOPE_PATH_VARIABLE];
}

export function decryptRuntimeConfigEnvelope(
  encoded: string,
  keyHex: string,
): Record<string, string> {
  const envelope = parseEnvelope(encoded);
  const key = decodeHex(keyHex.trim(), 32, 'key');
  const nonce = decodeHex(envelope.nonceHex, 12, 'nonce');
  const sealed = decodeHex(envelope.ciphertextHex, undefined, 'ciphertext');
  if (sealed.length <= 16) throw new Error('Runtime configuration envelope ciphertext is invalid.');
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(ENVELOPE_AAD);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Runtime configuration envelope authentication failed.');
  }
  let value: unknown;
  try {
    value = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('Runtime configuration envelope payload is invalid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runtime configuration envelope payload is invalid.');
  }
  const environment: Record<string, string> = {};
  for (const [name, setting] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof setting !== 'string') {
      throw new Error('Runtime configuration envelope payload is invalid.');
    }
    environment[name] = setting;
  }
  return environment;
}

function parseEnvelope(encoded: string): RuntimeConfigEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error('Runtime configuration envelope is invalid.');
  }
  if (!value || typeof value !== 'object'
    || (value as Partial<RuntimeConfigEnvelope>).version !== 1
    || (value as Partial<RuntimeConfigEnvelope>).algorithm !== 'aes-256-gcm'
    || typeof (value as Partial<RuntimeConfigEnvelope>).nonceHex !== 'string'
    || typeof (value as Partial<RuntimeConfigEnvelope>).ciphertextHex !== 'string') {
    throw new Error('Runtime configuration envelope is invalid.');
  }
  return value as RuntimeConfigEnvelope;
}

function decodeHex(value: string, expectedBytes: number | undefined, label: string): Buffer {
  if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0
    || (expectedBytes !== undefined && value.length !== expectedBytes * 2)) {
    throw new Error(`Runtime configuration envelope ${label} is invalid.`);
  }
  return Buffer.from(value, 'hex');
}

function readKeyLine(): Promise<string> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return new Promise((resolve, reject) => {
    let received = false;
    lines.once('line', line => {
      received = true;
      lines.close();
      process.stdin.destroy();
      resolve(line);
    });
    lines.once('close', () => {
      if (!received) reject(new Error('Runtime configuration envelope key was not delivered.'));
    });
  });
}
