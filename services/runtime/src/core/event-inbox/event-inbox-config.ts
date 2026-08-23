import { z } from 'zod';

const originSchema = z.url().transform(value => {
  const url = new URL(value);
  if (!['', '/'].includes(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new Error('must be an origin without credentials, path, query or fragment');
  }
  return url.origin;
});

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  EVENT_INBOX_BIND_HOST: z.string().trim().min(1).default('127.0.0.1'),
  EVENT_INBOX_PORT: z.coerce.number().int().min(1).max(65535).default(34200),
  EVENT_INBOX_DATABASE_URL: z.url(),
  EVENT_INBOX_MASTER_SECRET: z.string().min(32).max(4096),
  EVENT_INBOX_PUBLIC_BASE_URL: originSchema,
  EVENT_INBOX_OPENWA_BASE_URL: originSchema,
  EVENT_INBOX_OPENWA_RELEASE_TAG: z.string().min(1).default('0.22.0'),
  EVENT_INBOX_ALLOWED_SESSION_IDS: z.string().min(1)
    .transform(value => value.split(',').map(item => item.trim()).filter(Boolean))
    .pipe(z.array(z.uuid()).min(1).max(1000)),
  EVENT_INBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  EVENT_INBOX_MAX_STORED_EVENTS: z.coerce.number().int().min(100).max(100_000).default(100_000),
  EVENT_INBOX_MAX_STORED_BYTES: z.coerce.number().int()
    .min(1_048_576).max(8_589_934_592).default(268_435_456),
  EVENT_INBOX_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(262_144),
  EVENT_INBOX_CLAIM_BATCH_MAX: z.coerce.number().int().min(1).max(100).default(100),
  EVENT_INBOX_LEASE_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  EVENT_INBOX_MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(20),
  EVENT_INBOX_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000)
    .default(300_000),
  EVENT_INBOX_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(100).max(10_000).default(1_000),
  EVENT_INBOX_CLEANUP_MAX_BATCHES: z.coerce.number().int().min(1).max(100).default(10),
}).superRefine((value, context) => {
  const database = new URL(value.EVENT_INBOX_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    context.addIssue({
      code: 'custom',
      path: ['EVENT_INBOX_DATABASE_URL'],
      message: 'EVENT_INBOX_DATABASE_URL must use PostgreSQL',
    });
  }
  for (const [name, origin] of [
    ['EVENT_INBOX_PUBLIC_BASE_URL', value.EVENT_INBOX_PUBLIC_BASE_URL],
    ['EVENT_INBOX_OPENWA_BASE_URL', value.EVENT_INBOX_OPENWA_BASE_URL],
  ] as const) {
    const url = new URL(origin);
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(value.NODE_ENV !== 'production'
      && url.protocol === 'http:' && loopback)) {
      context.addIssue({ code: 'custom', path: [name], message: `${name} must use HTTPS outside loopback development` });
    }
  }
});

export type EventInboxConfig = z.infer<typeof schema>;

let cached: EventInboxConfig | undefined;

export function parseEventInboxConfig(environment: NodeJS.ProcessEnv): EventInboxConfig {
  return schema.parse(environment);
}

export function eventInboxConfig(): EventInboxConfig {
  cached ??= parseEventInboxConfig(process.env);
  return cached;
}
