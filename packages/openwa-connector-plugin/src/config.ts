export interface ConnectorConfig {
  eventInboxBaseUrl: string;
  connectorId: string;
  connectorToken: string;
  sessionId: string;
  heartbeatIntervalSeconds: number;
  storagePressureThreshold: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function readConfig(raw: Record<string, unknown>): ConnectorConfig {
  const eventInboxBaseUrl = String(raw.eventInboxBaseUrl ?? '').trim();
  const connectorToken = String(raw.connectorToken ?? '');
  const sessionId = String(raw.sessionId ?? '').trim();
  const heartbeatIntervalSeconds = boundedNumber(raw.heartbeatIntervalSeconds, 10, 5, 60);
  const storagePressureThreshold = boundedNumber(raw.storagePressureThreshold, 0.75, 0.5, 0.95);
  if (!eventInboxBaseUrl) throw new Error('wa-studio-connector: eventInboxBaseUrl is required');
  let url: URL;
  try {
    url = new URL(eventInboxBaseUrl);
  } catch {
    throw new Error('wa-studio-connector: eventInboxBaseUrl must be a valid URL');
  }
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || !['', '/'].includes(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new Error('wa-studio-connector: eventInboxBaseUrl must be an HTTPS origin');
  }
  const connectorTokenParts = connectorToken.match(
    /^wac1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([1-9]\d*)\.([A-Za-z0-9_-]{43})$/iu,
  );
  if (!connectorTokenParts || !Number.isSafeInteger(Number(connectorTokenParts[2]))) {
    throw new Error('wa-studio-connector: connectorToken is missing or invalid');
  }
  if (!uuid.test(sessionId)) throw new Error('wa-studio-connector: sessionId must be a UUID');
  return {
    eventInboxBaseUrl: url.origin,
    connectorId: connectorTokenParts[1]!.toLowerCase(),
    connectorToken,
    sessionId,
    heartbeatIntervalSeconds,
    storagePressureThreshold,
  };
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`wa-studio-connector: numeric config must be between ${minimum} and ${maximum}`);
  }
  return number;
}
