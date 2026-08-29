import { z } from 'zod';
import { OPENWA_RELEASE_TAG } from '../../contracts/release/openwa-release.generated';

const booleanFromEnv = (defaultValue: boolean) => z
  .enum(['true', 'false'])
  .optional()
  .transform(value => value === undefined ? defaultValue : value === 'true');

const desktopLoopbackHosts = new Set(['127.0.0.1', '::1']);

const originSchema = z.url().transform(value => {
  const url = new URL(value);
  if (!['', '/'].includes(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new Error('must be an origin without credentials, path, query or fragment');
  }
  return url.origin;
});

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    RUNTIME_PROFILE: z.enum(['server', 'desktop-managed']).default('server'),
    RUNTIME_INSTANCE_ID: z.string().trim().min(1).max(128)
      .regex(/^[A-Za-z0-9._:-]+$/u)
      .default('default'),
    RUNTIME_BIND_HOST: z.string().trim().min(1).optional(),
    RUNTIME_HTTP_BODY_MAX_BYTES: z.coerce.number().int()
      .min(65_536).max(16_777_216).default(1_048_576),
    RUNTIME_HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int()
      .min(1_000).max(120_000).default(30_000),
    RUNTIME_HTTP_HEADERS_TIMEOUT_MS: z.coerce.number().int()
      .min(1_000).max(60_000).default(10_000),
    QUEUE_BACKEND: z.enum(['redis', 'postgres']).default('redis'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
    DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: z.coerce.number().int()
      .min(1_000).max(300_000).default(30_000),
    DATABASE_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
    REDIS_URL: z.string().url().optional(),
    RUNTIME_API_KEY: z.string().min(32).max(4096),
    RUNTIME_METRICS_TOKEN: z.string().min(32).max(4096).optional(),
    ENABLE_RUNTIME_DOCS: z
      .enum(['true', 'false'])
      .optional()
      .transform(value => value === undefined ? undefined : value === 'true'),
    OPENWA_BASE_URL: originSchema,
    OPENWA_API_KEY: z.string().min(1),
    OPENWA_RELEASE_TAG: z.string().min(1).default(OPENWA_RELEASE_TAG),
    OPENWA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    OPENWA_REQUEST_DEADLINE_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
    OPENWA_RESPONSE_MAX_BYTES: z.coerce.number().int()
      .min(65_536).max(134_217_728).default(33_554_432),
    OPENWA_COMPATIBILITY_PROBE_TIMEOUT_MS: z.coerce.number().int()
      .min(1_000).max(30_000).default(5_000),
    OPENWA_COMPATIBILITY_FRESHNESS_MS: z.coerce.number().int()
      .min(1_000).max(300_000).default(60_000),
    OPENWA_COMPATIBILITY_PROBE_INTERVAL_MS: z.coerce.number().int()
      .min(10_000).max(3_600_000).default(60_000),
    OPENWA_WEBHOOK_SECRET: z.string().min(32),
    OPENWA_WEBHOOK_RECONCILIATION_ENABLED: booleanFromEnv(false),
    OPENWA_WEBHOOK_CALLBACK_URL: z.url().optional(),
    OPENWA_WEBHOOK_RECONCILIATION_INTERVAL_MS: z.coerce.number().int()
      .min(60_000).max(86_400_000).default(300_000),
    EVENT_INBOX_BASE_URL: z.url().optional(),
    EVENT_INBOX_DEVICE_TOKEN: z.string().min(32).max(4096).optional(),
    EVENT_INBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
    EVENT_INBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(100),
    EVENT_INBOX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(21_000).max(120_000).default(30_000),
    EVENT_INBOX_RESPONSE_MAX_BYTES: z.coerce.number().int()
      .min(1_048_576).max(167_772_160).default(41_943_040),
    OPENWA_ALLOWED_SESSION_IDS: z
      .string()
      .min(1)
      .transform(value => value.split(',').map(item => item.trim()).filter(Boolean))
      .pipe(z.array(z.uuid()).min(1)),
    ALLOW_LIVE_SENDS: booleanFromEnv(false),
    CAMPAIGN_LIVE_PREFLIGHT_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(120),
    CAMPAIGN_MEDIA_IMAGE_MAX_BYTES: z.coerce.number().int()
      .min(65_536).max(8_388_608).default(8_388_608),
    CAMPAIGN_MEDIA_STORAGE_MAX_BYTES: z.coerce.number().int()
      .min(16_777_216).max(10_737_418_240).default(536_870_912),
    CAMPAIGN_MEDIA_UPLOAD_TTL_SECONDS: z.coerce.number().int()
      .min(900).max(604_800).default(86_400),
    CAMPAIGN_MEDIA_ORPHAN_RETENTION_HOURS: z.coerce.number().int()
      .min(1).max(720).default(24),
    CAMPAIGN_MEDIA_SEND_MEMORY_BUDGET_BYTES: z.coerce.number().int()
      .min(33_554_432).max(1_073_741_824).default(33_554_432),
    OUTBOUND_MIN_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(3000),
    OUTBOUND_MAX_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(7000),
    MESSAGE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(1),
    MESSAGE_SAFE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    WEBHOOK_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    GATEWAY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(1),
    CAMPAIGN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
    RUNTIME_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
    RUNTIME_ACTIVITY_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
    RUNTIME_EVENT_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(30),
    RUNTIME_INBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).optional(),
    RUNTIME_RAW_WEBHOOK_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
    RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED: booleanFromEnv(false),
    RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED: booleanFromEnv(false),
    RUNTIME_RETENTION_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
    RUNTIME_RETENTION_BATCH_SIZE: z.coerce.number().int().min(100).max(10_000).default(5000),
    RUNTIME_RETENTION_MAX_BATCHES_PER_RUN: z.coerce.number().int().min(1).max(1_000).default(100),
    RUNTIME_RETENTION_TIME_BUDGET_MS: z.coerce.number().int().min(1_000).max(240_000).default(240_000),
    GATEWAY_SYNC_GROUPS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(40),
    GATEWAY_SYNC_ITEM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    GATEWAY_GROUP_DETAILS_STALE_AFTER_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
    GATEWAY_SYNC_SNAPSHOT_MIN_BASELINE: z.coerce.number().int().min(1).max(100_000).default(20),
    GATEWAY_SYNC_SNAPSHOT_DROP_RATIO: z.coerce.number().min(0).max(1).default(0.25),
    GATEWAY_SYNC_SNAPSHOT_CONFIRMATIONS: z.coerce.number().int().min(2).max(5).default(2),
    GATEWAY_TARGETED_RECONCILIATION_ENABLED: booleanFromEnv(false),
    GATEWAY_GROUP_EVENT_DEBOUNCE_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),
    GATEWAY_GROUP_EVENT_MAX_WAIT_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
    GATEWAY_SYNC_NOTIFY_WAKEUP_ENABLED: booleanFromEnv(false),
    GATEWAY_SYNC_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    GATEWAY_SYNC_ADAPTIVE_PACING: booleanFromEnv(false),
    GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(5),
    GATEWAY_SYNC_RATE_RECOVERY_SUCCESSES: z.coerce.number().int().min(1).max(1_000).default(25),
    CONTACT_SNAPSHOT_SYNC_ENABLED: booleanFromEnv(false),
    CONTACT_SNAPSHOT_STAGING_ENABLED: booleanFromEnv(false),
    CONTACT_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(30),
    CONTACT_MESSAGE_OBSERVATION_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(30),
    CONTACT_EVIDENCE_DUAL_WRITE_ENABLED: booleanFromEnv(false),
    CONTACT_RESOLUTION_SHADOW_ENABLED: booleanFromEnv(false),
    CONTACT_RESOLUTION_MAX_RUNS_PER_TICK: z.coerce.number().int().min(1).max(20).default(2),
    CONTACT_PROJECTION_SHADOW_ENABLED: booleanFromEnv(false),
    CONTACT_PROJECTION_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
    CONTACT_PROJECTION_MAX_JOBS_PER_TICK: z.coerce.number().int().min(1).max(100).default(10),
    CONTACT_PROJECTION_MAX_BATCHES_PER_JOB: z.coerce.number().int().min(1).max(100).default(4),
    CONTACT_PROJECTION_BOOTSTRAP_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(1_000),
    CONTACT_EVIDENCE_BACKFILL_ENABLED: booleanFromEnv(false),
    CONTACT_EVIDENCE_BACKFILL_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(2_000),
    CONTACT_PROJECTION_READ_ENABLED: booleanFromEnv(false),
    CONTACT_LEGACY_MEMBER_FANOUT_ENABLED: booleanFromEnv(true),
    CONTACT_MESSAGE_ENRICHMENT_ENABLED: booleanFromEnv(false),
    CONTACT_PERIODIC_SYNC_ENABLED: booleanFromEnv(false),
    CONTACT_PERIODIC_SYNC_INTERVAL_MS: z.coerce.number().int().min(300_000).default(86_400_000),
    CONTACT_MEMBER_IDENTITY_BACKFILL_ENABLED: booleanFromEnv(false),
    CONTACT_MEMBER_IDENTITY_BACKFILL_BATCH_SIZE: z.coerce.number().int().min(100).max(10_000).default(1000),
    CONTACT_MEMBER_IDENTITY_BACKFILL_MAX_BATCHES: z.coerce.number().int().min(1).max(100).default(20),
  })
  .superRefine((value, context) => {
    if (value.QUEUE_BACKEND === 'redis' && !value.REDIS_URL) {
      context.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required when QUEUE_BACKEND=redis',
      });
    }
    if (value.RUNTIME_METRICS_TOKEN === value.RUNTIME_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['RUNTIME_METRICS_TOKEN'],
        message: 'RUNTIME_METRICS_TOKEN must be different from RUNTIME_API_KEY',
      });
    }
    if (value.RUNTIME_PROFILE === 'desktop-managed' && value.RUNTIME_BIND_HOST
      && !desktopLoopbackHosts.has(value.RUNTIME_BIND_HOST)) {
      context.addIssue({
        code: 'custom',
        path: ['RUNTIME_BIND_HOST'],
        message: 'desktop-managed Runtime must bind to a loopback address',
      });
    }
    if (value.RUNTIME_HTTP_HEADERS_TIMEOUT_MS > value.RUNTIME_HTTP_REQUEST_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom', path: ['RUNTIME_HTTP_HEADERS_TIMEOUT_MS'],
        message: 'RUNTIME_HTTP_HEADERS_TIMEOUT_MS cannot exceed RUNTIME_HTTP_REQUEST_TIMEOUT_MS',
      });
    }
    if (value.OUTBOUND_MAX_DELAY_MS < value.OUTBOUND_MIN_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        path: ['OUTBOUND_MAX_DELAY_MS'],
        message: 'must be greater than or equal to OUTBOUND_MIN_DELAY_MS',
      });
    }
    if (value.OPENWA_REQUEST_DEADLINE_MS < value.OPENWA_REQUEST_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom', path: ['OPENWA_REQUEST_DEADLINE_MS'],
        message: 'OPENWA_REQUEST_DEADLINE_MS must be greater than or equal to OPENWA_REQUEST_TIMEOUT_MS',
      });
    }
    if (value.GATEWAY_GROUP_EVENT_MAX_WAIT_MS < value.GATEWAY_GROUP_EVENT_DEBOUNCE_MS) {
      context.addIssue({
        code: 'custom', path: ['GATEWAY_GROUP_EVENT_MAX_WAIT_MS'],
        message: 'GATEWAY_GROUP_EVENT_MAX_WAIT_MS must be greater than or equal to GATEWAY_GROUP_EVENT_DEBOUNCE_MS',
      });
    }
    if (value.GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE > value.GATEWAY_SYNC_GROUPS_PER_MINUTE) {
      context.addIssue({
        code: 'custom', path: ['GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE'],
        message: 'GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE cannot exceed GATEWAY_SYNC_GROUPS_PER_MINUTE',
      });
    }
    if (value.OPENWA_WEBHOOK_RECONCILIATION_ENABLED && !value.OPENWA_WEBHOOK_CALLBACK_URL) {
      context.addIssue({
        code: 'custom', path: ['OPENWA_WEBHOOK_CALLBACK_URL'],
        message: 'OPENWA_WEBHOOK_CALLBACK_URL is required when webhook reconciliation is enabled',
      });
    }
    if (value.OPENWA_WEBHOOK_CALLBACK_URL) {
      const callback = new URL(value.OPENWA_WEBHOOK_CALLBACK_URL);
      const loopback = ['127.0.0.1', '::1', 'localhost'].includes(callback.hostname);
      if (callback.protocol !== 'https:' && !(value.NODE_ENV !== 'production'
        && callback.protocol === 'http:' && loopback)) {
        context.addIssue({
          code: 'custom', path: ['OPENWA_WEBHOOK_CALLBACK_URL'],
          message: 'OPENWA_WEBHOOK_CALLBACK_URL must use HTTPS outside loopback development',
        });
      }
      const path = callback.pathname.replace(/\/+$/u, '');
      if (path !== '/api/v1/webhooks/openwa' || callback.search || callback.hash
        || callback.username || callback.password) {
        context.addIssue({
          code: 'custom', path: ['OPENWA_WEBHOOK_CALLBACK_URL'],
          message: 'OPENWA_WEBHOOK_CALLBACK_URL must target /api/v1/webhooks/openwa without credentials, query or fragment',
        });
      }
    }
    if (Boolean(value.EVENT_INBOX_BASE_URL) !== Boolean(value.EVENT_INBOX_DEVICE_TOKEN)) {
      context.addIssue({
        code: 'custom', path: ['EVENT_INBOX_DEVICE_TOKEN'],
        message: 'EVENT_INBOX_BASE_URL and EVENT_INBOX_DEVICE_TOKEN must be configured together',
      });
    }
    if (value.EVENT_INBOX_BASE_URL) {
      const inbox = new URL(value.EVENT_INBOX_BASE_URL);
      const loopback = ['127.0.0.1', '::1', 'localhost'].includes(inbox.hostname);
      if (inbox.protocol !== 'https:' && !(value.NODE_ENV !== 'production'
        && inbox.protocol === 'http:' && loopback)) {
        context.addIssue({
          code: 'custom', path: ['EVENT_INBOX_BASE_URL'],
          message: 'EVENT_INBOX_BASE_URL must use HTTPS outside loopback development',
        });
      }
      if (!['', '/'].includes(inbox.pathname) || inbox.search || inbox.hash
        || inbox.username || inbox.password) {
        context.addIssue({
          code: 'custom', path: ['EVENT_INBOX_BASE_URL'],
          message: 'EVENT_INBOX_BASE_URL must be an origin without credentials, path, query or fragment',
        });
      }
    }
    if (value.CONTACT_EVIDENCE_DUAL_WRITE_ENABLED && !value.CONTACT_SNAPSHOT_STAGING_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CONTACT_EVIDENCE_DUAL_WRITE_ENABLED'],
        message: 'CONTACT_EVIDENCE_DUAL_WRITE_ENABLED requires CONTACT_SNAPSHOT_STAGING_ENABLED',
      });
    }
    if (value.CONTACT_RESOLUTION_SHADOW_ENABLED && !value.CONTACT_EVIDENCE_DUAL_WRITE_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CONTACT_RESOLUTION_SHADOW_ENABLED'],
        message: 'CONTACT_RESOLUTION_SHADOW_ENABLED requires CONTACT_EVIDENCE_DUAL_WRITE_ENABLED',
      });
    }
    if (value.CONTACT_PROJECTION_SHADOW_ENABLED && !value.CONTACT_RESOLUTION_SHADOW_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CONTACT_PROJECTION_SHADOW_ENABLED'],
        message: 'CONTACT_PROJECTION_SHADOW_ENABLED requires CONTACT_RESOLUTION_SHADOW_ENABLED',
      });
    }
    if (value.CONTACT_PROJECTION_READ_ENABLED && !value.CONTACT_PROJECTION_SHADOW_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CONTACT_PROJECTION_READ_ENABLED'],
        message: 'CONTACT_PROJECTION_READ_ENABLED requires CONTACT_PROJECTION_SHADOW_ENABLED',
      });
    }
    if (value.CONTACT_EVIDENCE_BACKFILL_ENABLED && !value.CONTACT_EVIDENCE_DUAL_WRITE_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CONTACT_EVIDENCE_BACKFILL_ENABLED'],
        message: 'CONTACT_EVIDENCE_BACKFILL_ENABLED requires CONTACT_EVIDENCE_DUAL_WRITE_ENABLED',
      });
    }
    if (!value.CONTACT_LEGACY_MEMBER_FANOUT_ENABLED && !value.CONTACT_PROJECTION_SHADOW_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CONTACT_LEGACY_MEMBER_FANOUT_ENABLED'],
        message: 'Disabling CONTACT_LEGACY_MEMBER_FANOUT_ENABLED requires CONTACT_PROJECTION_SHADOW_ENABLED',
      });
    }
  });

type ParsedRuntimeConfig = z.infer<typeof schema>;

export type RuntimeConfig = Omit<
  ParsedRuntimeConfig,
  'RUNTIME_BIND_HOST' | 'RUNTIME_INBOX_RETENTION_DAYS'
> & {
  RUNTIME_BIND_HOST: string;
  RUNTIME_INBOX_RETENTION_DAYS: number;
  enableRuntimeDocs: boolean;
};

let cached: RuntimeConfig | undefined;

export function parseRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const parsed = schema.parse(environment);
  return {
    ...parsed,
    RUNTIME_BIND_HOST: parsed.RUNTIME_BIND_HOST
      ?? (parsed.RUNTIME_PROFILE === 'desktop-managed' ? '127.0.0.1' : '0.0.0.0'),
    RUNTIME_INBOX_RETENTION_DAYS:
      parsed.RUNTIME_INBOX_RETENTION_DAYS ?? parsed.RUNTIME_EVENT_RETENTION_DAYS,
    enableRuntimeDocs: parsed.ENABLE_RUNTIME_DOCS ?? parsed.NODE_ENV !== 'production',
  };
}

export function runtimeConfig(): RuntimeConfig {
  if (cached) return cached;
  cached = parseRuntimeConfig(process.env);
  return cached;
}
