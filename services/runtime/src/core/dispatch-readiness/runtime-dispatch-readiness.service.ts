import { Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { DatabaseService } from '../database/database.service';

export type RuntimeDispatchReadinessState = 'DISABLED' | 'RECOVERING' | 'READY' | 'DEGRADED';

export interface RuntimeDispatchReadinessSnapshot {
  required: boolean;
  ready: boolean;
  state: RuntimeDispatchReadinessState;
  reason: string | null;
  recoveryWatermark: string | null;
  recoveryStartedAt: Date | null;
  readyAt: Date | null;
  heartbeatAt: Date | null;
}

interface RuntimeDispatchReadinessRow {
  state: Exclude<RuntimeDispatchReadinessState, 'DISABLED'>;
  reason: string | null;
  recovery_watermark: string | null;
  recovery_started_at: Date;
  ready_at: Date | null;
  heartbeat_at: Date | null;
  ready: boolean;
}

@Injectable()
export class RuntimeDispatchReadinessService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  required(): boolean {
    return Boolean(this.config.EVENT_INBOX_BASE_URL);
  }

  maximumHeartbeatAgeMs(): number {
    return Math.max(
      60_000,
      this.config.EVENT_INBOX_REQUEST_TIMEOUT_MS
        + this.config.EVENT_INBOX_POLL_INTERVAL_MS * 2,
    );
  }

  async beginRecovery(): Promise<void> {
    if (!this.required()) return;
    await this.database.query(
      `INSERT INTO runtime_dispatch_readiness
         (singleton, state, reason, recovery_started_at, updated_at)
       VALUES (true, 'RECOVERING', 'event_inbox_startup_recovery', now(), now())
       ON CONFLICT (singleton) DO UPDATE SET
         state = 'RECOVERING', recovery_watermark = NULL,
         reason = 'event_inbox_startup_recovery',
         recovery_started_at = now(), ready_at = NULL, heartbeat_at = NULL,
         updated_at = now()`,
    );
  }

  async markReady(watermark: string): Promise<void> {
    if (!this.required()) return;
    await this.database.query(
      `INSERT INTO runtime_dispatch_readiness
         (singleton, state, recovery_watermark, reason, recovery_started_at,
          ready_at, heartbeat_at, updated_at)
       VALUES (true, 'READY', $1::bigint, NULL, now(), now(), now(), now())
       ON CONFLICT (singleton) DO UPDATE SET
         state = 'READY', recovery_watermark = EXCLUDED.recovery_watermark,
         reason = NULL, ready_at = now(), heartbeat_at = now(), updated_at = now()`,
      [watermark],
    );
  }

  async markDegraded(reason: string): Promise<void> {
    if (!this.required()) return;
    await this.database.query(
      `INSERT INTO runtime_dispatch_readiness
         (singleton, state, reason, recovery_started_at, updated_at)
       VALUES (true, 'DEGRADED', $1, now(), now())
       ON CONFLICT (singleton) DO UPDATE SET
         state = 'DEGRADED', recovery_watermark = NULL, reason = EXCLUDED.reason,
         recovery_started_at = now(), ready_at = NULL, heartbeat_at = NULL,
         updated_at = now()`,
      [reason.slice(0, 512)],
    );
  }

  async refreshHeartbeat(): Promise<void> {
    if (!this.required()) return;
    await this.database.query(
      `UPDATE runtime_dispatch_readiness
       SET heartbeat_at = now(), updated_at = now()
       WHERE singleton = true AND state = 'READY'`,
    );
  }

  async snapshot(): Promise<RuntimeDispatchReadinessSnapshot> {
    if (!this.required()) {
      return {
        required: false,
        ready: true,
        state: 'DISABLED',
        reason: null,
        recoveryWatermark: null,
        recoveryStartedAt: null,
        readyAt: null,
        heartbeatAt: null,
      };
    }
    const result = await this.database.query<RuntimeDispatchReadinessRow>(
      `SELECT state, reason, recovery_watermark::text,
         recovery_started_at, ready_at, heartbeat_at,
         state = 'READY'
           AND heartbeat_at > now() - ($1::double precision * interval '1 millisecond') AS ready
       FROM runtime_dispatch_readiness
       WHERE singleton = true`,
      [this.maximumHeartbeatAgeMs()],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        required: true,
        ready: false,
        state: 'RECOVERING',
        reason: 'event_inbox_recovery_not_initialized',
        recoveryWatermark: null,
        recoveryStartedAt: null,
        readyAt: null,
        heartbeatAt: null,
      };
    }
    return {
      required: true,
      ready: row.ready,
      state: row.ready ? row.state : row.state === 'READY' ? 'DEGRADED' : row.state,
      reason: row.ready
        ? null
        : row.state === 'READY' ? 'event_inbox_consumer_heartbeat_stale' : row.reason,
      recoveryWatermark: row.recovery_watermark,
      recoveryStartedAt: row.recovery_started_at,
      readyAt: row.ready_at,
      heartbeatAt: row.heartbeat_at,
    };
  }
}
