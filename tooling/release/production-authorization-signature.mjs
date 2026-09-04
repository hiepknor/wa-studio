import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const signatureDomain = "WA_STUDIO_PRODUCTION_AUTHORIZATION_V1";
const maximumKeyBytes = 16 * 1024;
const keyIdPattern = /^sha256:[0-9a-f]{64}$/u;

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > 512) throw new Error(`${label} is too long.`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = required(value, label);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp.`);
  }
  return normalized;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains missing or unexpected fields.`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Signed authorization contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new Error("Signed authorization contains an unsupported value.");
  }
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function readKey(path, label, requirePrivateMode) {
  const resolvedPath = resolve(required(path, `${label} path`));
  const metadata = lstatSync(resolvedPath);
  if (metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size < 1
    || metadata.size > maximumKeyBytes) {
    throw new Error(`${label} must be a non-empty regular file below ${maximumKeyBytes} bytes.`);
  }
  const mode = metadata.mode & 0o777;
  if ((mode & 0o400) === 0
    || (mode & 0o133) !== 0
    || (requirePrivateMode && (mode & 0o044) !== 0)) {
    throw new Error(`${label} permissions are unsafe.`);
  }
  return readFileSync(resolvedPath);
}

function ed25519PrivateKey(path) {
  let key;
  try {
    key = createPrivateKey(readKey(path, "Production authorization private key", true));
  } catch (error) {
    throw new Error(`Production authorization private key is invalid: ${error.message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Production authorization private key must use Ed25519.");
  }
  return key;
}

function ed25519PublicKey(path) {
  let key;
  try {
    key = createPublicKey(readKey(path, "Production authorization public key", false));
  } catch (error) {
    throw new Error(`Production authorization public key is invalid: ${error.message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Production authorization public key must use Ed25519.");
  }
  return key;
}

function keyId(key) {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const digest = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  return `sha256:${digest}`;
}

function payload({ purpose, keyId: id, signedAt, authorization }) {
  const normalizedPurpose = required(purpose, "Authorization purpose");
  const normalizedKeyId = required(id, "Authorization signing key ID");
  if (!keyIdPattern.test(normalizedKeyId)) {
    throw new Error("Authorization signing key ID is invalid.");
  }
  const normalizedSignedAt = timestamp(signedAt, "Authorization signature time");
  return Buffer.from(
    `${signatureDomain}\0${normalizedPurpose}\0${normalizedKeyId}\0${normalizedSignedAt}\0${canonicalJson(authorization)}`,
    "utf8",
  );
}

export function signProductionAuthorization({
  authorization,
  purpose,
  privateKeyPath,
  signedAt,
}) {
  const key = ed25519PrivateKey(privateKeyPath);
  const signature = {
    schemaVersion: 1,
    algorithm: "Ed25519",
    purpose: required(purpose, "Authorization purpose"),
    keyId: keyId(key),
    signedAt: timestamp(signedAt, "Authorization signature time"),
    value: "",
  };
  signature.value = sign(null, payload({
    purpose: signature.purpose,
    keyId: signature.keyId,
    signedAt: signature.signedAt,
    authorization,
  }), key).toString("base64");
  return signature;
}

export function verifyProductionAuthorization({
  authorization,
  signature,
  expectedPurpose,
  publicKeyPath,
}) {
  exactKeys(
    signature,
    ["schemaVersion", "algorithm", "purpose", "keyId", "signedAt", "value"],
    "Production authorization signature",
  );
  if (signature.schemaVersion !== 1
    || signature.algorithm !== "Ed25519"
    || signature.purpose !== required(expectedPurpose, "Expected authorization purpose")) {
    throw new Error("Production authorization signature metadata is incompatible.");
  }
  const key = ed25519PublicKey(publicKeyPath);
  if (signature.keyId !== keyId(key)) {
    throw new Error("Production authorization signature uses an untrusted key.");
  }
  const value = required(signature.value, "Production authorization signature value");
  const signatureBytes = Buffer.from(value, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== value) {
    throw new Error("Production authorization signature encoding is invalid.");
  }
  if (!verify(null, payload({
    purpose: signature.purpose,
    keyId: signature.keyId,
    signedAt: signature.signedAt,
    authorization,
  }), key, signatureBytes)) {
    throw new Error("Production authorization signature verification failed.");
  }
  return {
    keyId: signature.keyId,
    signedAt: timestamp(signature.signedAt, "Authorization signature time"),
  };
}
