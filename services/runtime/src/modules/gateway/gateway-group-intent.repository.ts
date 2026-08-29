import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { appendActivityEvent } from '../../core/activity/activity-writer';
import { DatabaseService } from '../../core/database/database.service';
import type {
  GroupCapabilityRefreshDto,
  GroupCapabilityRefreshStatus,
} from '../../contracts/groups/group-capability-refresh.dto';
import type { GroupSendCapabilityReason } from './group-capability';
import type {
  ClaimedGatewayGroupIntent,
  GatewayGroupIntentDispatch,
  GatewayGroupIntentFailurePolicy,
} from './gateway-group-intent.types';
import { GatewaySyncRateLimitRepository } from './gateway-sync-rate-limit.repository';

const MANUAL_CAPABILITY_REASON = 'manual.capability_refresh';
const MANUAL_PRIORITY = 1;
const AUTOMATIC_PRIORITY = 5;

interface GatewayGroupIntentRow {
  session_id: string;
  group_id: string;
  requested_revision: string;
  completed_revision: string;
  reasons: string[];
  status: 'PENDING' | 'RUNNING' | 'RETRY' | 'COMPLETED' | 'FAILED';
  priority: number;
  attempt_count: number;
  next_attempt_at: Date;
  last_error_code: string | null;
  last_requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

function mapCapabilityRefresh(
  row: GatewayGroupIntentRow,
  requestRevision = Number(row.requested_revision),
): GroupCapabilityRefreshDto {
  const completed = Number(row.completed_revision) >= requestRevision;
  const status: GroupCapabilityRefreshStatus = completed
    ? 'COMPLETED'
    : row.status === 'RETRY'
      ? 'RETRYING'
      : row.status;
  return {
    sessionId: row.session_id,
    groupId: row.group_id,
    requestRevision,
    status,
    source: row.reasons.includes(MANUAL_CAPABILITY_REASON) ? 'MANUAL' : 'SYSTEM',
    attemptCount: row.attempt_count,
    requestedAt: row.last_requested_at,
    startedAt: row.started_at,
    nextAttemptAt: ['PENDING', 'RETRYING'].includes(status) ? row.next_attempt_at : null,
    completedAt: completed || status === 'FAILED' ? row.completed_at : null,
    errorCode: status === 'FAILED' ? row.last_error_code : null,
  };
}

@Injectable()
export class GatewayGroupIntentRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly rateLimits: GatewaySyncRateLimitRepository = new GatewaySyncRateLimitRepository(database),
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async scheduleInTransaction(
    client: PoolClient,
    sessionId: string,
    groupId: string,
    reason: string,
    options: { immediate?: boolean; priority?: number } = {},
  ): Promise<{ created: boolean; coalescedCount: number; requestedRevision: number }> {
    await this.acquireMutationLock(client, sessionId, groupId);
    const debounceMs = options.immediate ? 0 : this.config.GATEWAY_GROUP_EVENT_DEBOUNCE_MS;
    const maxWaitMs = options.immediate ? 0 : this.config.GATEWAY_GROUP_EVENT_MAX_WAIT_MS;
    const priority = options.priority ?? AUTOMATIC_PRIORITY;
    const result = await client.query<{
      created: boolean;
      coalesced_count: string;
      requested_revision: string;
    }>(
      `INSERT INTO gateway_group_reconciliation_intents
         (session_id, group_id, reasons, priority, not_before, next_attempt_at)
       VALUES ($1, $2, ARRAY[$3], $6,
         now() + ($4::double precision * interval '1 millisecond'),
         now() + ($4::double precision * interval '1 millisecond'))
       ON CONFLICT (session_id, group_id) DO UPDATE SET
         requested_revision = gateway_group_reconciliation_intents.requested_revision + 1,
         reasons = CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
           THEN EXCLUDED.reasons ELSE ARRAY(
             SELECT DISTINCT value FROM unnest(
               gateway_group_reconciliation_intents.reasons || EXCLUDED.reasons
             ) AS value ORDER BY value
           ) END,
         priority = CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
           THEN EXCLUDED.priority ELSE LEAST(gateway_group_reconciliation_intents.priority, EXCLUDED.priority) END,
         status = CASE WHEN gateway_group_reconciliation_intents.status = 'RUNNING'
           THEN 'RUNNING'::gateway_group_intent_status ELSE 'PENDING'::gateway_group_intent_status END,
         not_before = LEAST(
           (CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
             THEN now() ELSE gateway_group_reconciliation_intents.first_requested_at END)
             + ($5::double precision * interval '1 millisecond'),
           now() + ($4::double precision * interval '1 millisecond')
         ),
         next_attempt_at = CASE WHEN gateway_group_reconciliation_intents.status = 'RUNNING'
           THEN gateway_group_reconciliation_intents.next_attempt_at
           ELSE LEAST(
             (CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
               THEN now() ELSE gateway_group_reconciliation_intents.first_requested_at END)
               + ($5::double precision * interval '1 millisecond'),
             now() + ($4::double precision * interval '1 millisecond')
           ) END,
         attempt_count = CASE WHEN gateway_group_reconciliation_intents.status = 'RUNNING'
           THEN gateway_group_reconciliation_intents.attempt_count ELSE 0 END,
         coalesced_count = CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
           THEN 0 ELSE gateway_group_reconciliation_intents.coalesced_count + 1 END,
         first_requested_at = CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
           THEN now() ELSE gateway_group_reconciliation_intents.first_requested_at END,
         last_requested_at = now(),
         started_at = CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
           THEN NULL ELSE gateway_group_reconciliation_intents.started_at END,
         completed_at = NULL, last_error_code = NULL, updated_at = now()
       RETURNING (xmax = 0) AS created, coalesced_count::text, requested_revision::text`,
      [sessionId, groupId, reason, debounceMs, maxWaitMs, priority],
    );
    await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
    const row = result.rows[0]!;
    return {
      created: row.created,
      coalescedCount: Number(row.coalesced_count),
      requestedRevision: Number(row.requested_revision),
    };
  }

  async requestCapabilityRefresh(
    sessionId: string,
    groupId: string,
    capabilityReason: GroupSendCapabilityReason = 'MANUAL_REFRESH',
    requestReason = MANUAL_CAPABILITY_REASON,
    priority = MANUAL_PRIORITY,
  ): Promise<GroupCapabilityRefreshDto | null> {
    return this.database.transaction(async client => {
      await this.acquireMutationLock(client, sessionId, groupId);
      const existingIntent = await client.query<GatewayGroupIntentRow>(
        `SELECT * FROM gateway_group_reconciliation_intents
         WHERE session_id = $1 AND group_id = $2 FOR UPDATE`,
        [sessionId, groupId],
      );
      const group = await client.query<{
        name: string;
        capability_invalidated_at: Date | null;
      }>(
        `SELECT name, capability_invalidated_at FROM gateway_groups
         WHERE session_id = $1 AND id = $2 AND is_active = true FOR UPDATE`,
        [sessionId, groupId],
      );
      const groupRow = group.rows[0];
      if (!groupRow) return null;

      const active = existingIntent.rows[0]?.status === 'PENDING'
        || existingIntent.rows[0]?.status === 'RUNNING'
        || existingIntent.rows[0]?.status === 'RETRY'
        ? existingIntent.rows[0]
        : null;
      let operation: GroupCapabilityRefreshDto;
      if (active) {
        const updated = await client.query<GatewayGroupIntentRow>(
          `UPDATE gateway_group_reconciliation_intents SET
             reasons = CASE WHEN $3 = ANY(reasons) THEN reasons ELSE array_append(reasons, $3) END,
             priority = LEAST(priority, $4),
             not_before = LEAST(not_before, now()),
             next_attempt_at = CASE WHEN status = 'RUNNING'
               THEN next_attempt_at ELSE LEAST(next_attempt_at, now()) END,
             last_requested_at = now(), updated_at = now()
           WHERE session_id = $1 AND group_id = $2 RETURNING *`,
          [sessionId, groupId, requestReason, priority],
        );
        operation = mapCapabilityRefresh(updated.rows[0]!);
      } else {
        const scheduled = await this.scheduleInTransaction(
          client,
          sessionId,
          groupId,
          requestReason,
          { immediate: true, priority },
        );
        const created = await client.query<GatewayGroupIntentRow>(
          `SELECT * FROM gateway_group_reconciliation_intents
           WHERE session_id = $1 AND group_id = $2`,
          [sessionId, groupId],
        );
        operation = mapCapabilityRefresh(created.rows[0]!, scheduled.requestedRevision);
      }

      if (groupRow.capability_invalidated_at === null) {
        await client.query(
          `UPDATE gateway_groups SET
             send_capability = CASE WHEN capability_checked_at IS NULL
               THEN 'UNKNOWN'::group_send_capability ELSE send_capability END,
             send_capability_reason = CASE WHEN capability_checked_at IS NULL
               THEN $3 ELSE send_capability_reason END,
             capability_invalidated_at = now(), capability_revision = capability_revision + 1,
             capability_refresh_attempt_count = 0, capability_refresh_next_attempt_at = now(),
             capability_refresh_lease_token = NULL, capability_refresh_lease_expires_at = NULL,
             capability_refresh_error = NULL, updated_at = now()
           WHERE session_id = $1 AND id = $2 AND is_active = true`,
          [sessionId, groupId, capabilityReason],
        );
      }
      await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
      await appendActivityEvent(client, {
        sessionId,
        eventType: 'group.capability_refresh.requested',
        category: 'SYNC',
        severity: 'INFO',
        origin: requestReason === MANUAL_CAPABILITY_REASON ? 'STUDIO' : 'RUNTIME',
        subjectType: 'GROUP',
        subjectId: groupId,
        subjectLabelSnapshot: groupRow.name,
        groupId,
        metadata: { requestRevision: operation.requestRevision, reason: requestReason },
        dedupeKey: `group-capability-refresh:${sessionId}:${groupId}:${operation.requestRevision}:requested`,
      });
      return operation;
    });
  }

  async findCapabilityRefresh(
    sessionId: string,
    groupId: string,
    requestRevision?: number,
  ): Promise<GroupCapabilityRefreshDto | null> {
    const result = await this.database.query<GatewayGroupIntentRow>(
      `SELECT * FROM gateway_group_reconciliation_intents
       WHERE session_id = $1 AND group_id = $2`,
      [sessionId, groupId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const revision = requestRevision ?? Number(row.requested_revision);
    if (revision < 1 || revision > Number(row.requested_revision)) return null;
    return mapCapabilityRefresh(row, revision);
  }

  async completeFromAuthoritativeSync(
    sessionId: string,
    groupId: string,
    observedAfter: Date,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE gateway_group_reconciliation_intents SET
         completed_revision = requested_revision,
         status = 'COMPLETED', claimed_revision = NULL,
         lease_token = NULL, lease_expires_at = NULL,
         completed_at = now(), last_error_code = NULL, updated_at = now()
       WHERE session_id = $1 AND group_id = $2 AND status IN ('PENDING', 'RETRY')
         AND last_requested_at <= $3`,
      [sessionId, groupId, observedAfter],
    );
    return result.rowCount === 1;
  }

  async listDispatchable(limit: number): Promise<GatewayGroupIntentDispatch[]> {
    const result = await this.database.query<{
      session_id: string; group_id: string; requested_revision: string; available_at: Date;
      priority: number;
    }>(
      `SELECT intents.session_id, intents.group_id, intents.requested_revision::text,
         intents.priority,
         GREATEST(intents.next_attempt_at, intents.not_before,
           COALESCE(limits.next_request_at, '-infinity'::timestamptz),
           COALESCE(limits.cooldown_until, '-infinity'::timestamptz),
           CASE WHEN limits.active_lease_token IS NOT NULL
             THEN COALESCE(limits.active_lease_expires_at, now()) ELSE '-infinity'::timestamptz END
         ) AS available_at
       FROM gateway_group_reconciliation_intents intents
       LEFT JOIN gateway_sync_rate_limits limits ON limits.session_id = intents.session_id
       WHERE intents.status IN ('PENDING', 'RETRY')
         AND ($4 OR intents.priority <= $5)
         AND intents.attempt_count < $2
         AND intents.session_id = ANY($3::text[])
         AND NOT EXISTS (
           SELECT 1 FROM sync_runs WHERE sync_runs.session_id = intents.session_id
             AND sync_runs.status IN ('PENDING', 'RUNNING') AND sync_runs.phase = 'DISCOVERING'
         )
         AND (limits.active_lease_token IS NULL OR limits.active_lease_expires_at < now())
         AND NOT EXISTS (
           SELECT 1 FROM gateway_sync_items items
           JOIN sync_runs runs ON runs.id = items.sync_run_id AND runs.status = 'RUNNING'
           WHERE items.session_id = intents.session_id AND items.group_id = intents.group_id
             AND items.status IN ('PENDING', 'RUNNING', 'RETRY')
         )
       ORDER BY intents.priority, available_at, intents.last_requested_at
       LIMIT $1`,
      [
        limit,
        this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS,
        this.config.OPENWA_ALLOWED_SESSION_IDS,
        this.config.GATEWAY_TARGETED_RECONCILIATION_ENABLED,
        MANUAL_PRIORITY,
      ],
    );
    return result.rows.map(row => ({
      sessionId: row.session_id, groupId: row.group_id,
      requestedRevision: Number(row.requested_revision),
      availableAt: row.available_at,
      priority: row.priority,
    }));
  }

  async claim(sessionId: string, groupId: string): Promise<ClaimedGatewayGroupIntent | null> {
    return this.database.transaction(async client => {
      const intent = await client.query<{
        requested_revision: string; coalesced_count: string; first_requested_at: Date;
        reasons: string[];
      }>(
        `SELECT requested_revision::text, coalesced_count::text, first_requested_at, reasons
         FROM gateway_group_reconciliation_intents
         WHERE session_id = $1 AND group_id = $2 FOR UPDATE`,
        [sessionId, groupId],
      );
      const row = intent.rows[0];
      if (!row) return null;
      await this.rateLimits.ensure(client, sessionId);
      const effectiveRate = await this.rateLimits.readyAndRate(client, sessionId);
      if (effectiveRate === null) return null;
      const claimed = await client.query<{ lease_token: string; attempt_count: number }>(
        `UPDATE gateway_group_reconciliation_intents SET status = 'RUNNING',
           claimed_revision = requested_revision, attempt_count = attempt_count + 1,
           lease_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes',
           started_at = COALESCE(started_at, now()), last_error_code = NULL, updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND status IN ('PENDING', 'RETRY')
           AND next_attempt_at <= now() AND not_before <= now() AND attempt_count < $3
           AND NOT EXISTS (
             SELECT 1 FROM sync_runs
             WHERE sync_runs.session_id = gateway_group_reconciliation_intents.session_id
               AND sync_runs.status IN ('PENDING', 'RUNNING')
               AND sync_runs.phase = 'DISCOVERING'
           )
           AND NOT EXISTS (
             SELECT 1 FROM gateway_sync_items items
             JOIN sync_runs runs ON runs.id = items.sync_run_id AND runs.status = 'RUNNING'
             WHERE items.session_id = gateway_group_reconciliation_intents.session_id
               AND items.group_id = gateway_group_reconciliation_intents.group_id
               AND items.status IN ('PENDING', 'RUNNING', 'RETRY')
           )
         RETURNING lease_token, attempt_count`,
        [sessionId, groupId, this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS],
      );
      const claim = claimed.rows[0];
      if (!claim) return null;
      await this.rateLimits.acquire(client, sessionId, claim.lease_token, effectiveRate);
      return {
        sessionId, groupId, requestedRevision: Number(row.requested_revision),
        leaseToken: claim.lease_token, attemptNumber: claim.attempt_count,
        coalescedCount: Number(row.coalesced_count), requestedAt: row.first_requested_at,
        source: row.reasons.includes(MANUAL_CAPABILITY_REASON) ? 'MANUAL' : 'SYSTEM',
      };
    });
  }

  async renewLease(sessionId: string, groupId: string, leaseToken: string): Promise<boolean> {
    return this.database.transaction(async client => {
      const result = await client.query(
        `UPDATE gateway_group_reconciliation_intents
         SET lease_expires_at = now() + interval '2 minutes', updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
           AND lease_token = $3 AND lease_expires_at > now()`,
        [sessionId, groupId, leaseToken],
      );
      if (result.rowCount !== 1 || !await this.rateLimits.renew(client, sessionId, leaseToken)) {
        throw new LostGatewayGroupIntentLeaseError();
      }
      return true;
    }).catch(error => {
      if (error instanceof LostGatewayGroupIntentLeaseError) return false;
      throw error;
    });
  }

  async complete(
    sessionId: string,
    groupId: string,
    leaseToken: string,
    claimedRevision: number,
  ): Promise<'COMPLETED' | 'PENDING' | 'LOST_OWNERSHIP'> {
    return this.database.transaction(async client => {
      const result = await client.query<{ status: 'COMPLETED' | 'PENDING' }>(
        `UPDATE gateway_group_reconciliation_intents SET
           completed_revision = GREATEST(completed_revision, $4),
           status = CASE WHEN requested_revision > $4
             THEN 'PENDING'::gateway_group_intent_status ELSE 'COMPLETED'::gateway_group_intent_status END,
           attempt_count = CASE WHEN requested_revision > $4 THEN 0 ELSE attempt_count END,
           next_attempt_at = CASE WHEN requested_revision > $4 THEN GREATEST(not_before, now())
             ELSE next_attempt_at END,
           claimed_revision = NULL, lease_token = NULL, lease_expires_at = NULL,
           completed_at = CASE WHEN requested_revision = $4 THEN now() ELSE NULL END,
           last_error_code = NULL, updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
           AND lease_token = $3 AND lease_expires_at > now() AND claimed_revision = $4
         RETURNING status`,
        [sessionId, groupId, leaseToken, claimedRevision],
      );
      const row = result.rows[0];
      if (!row) return 'LOST_OWNERSHIP';
      await this.rateLimits.success(client, sessionId, leaseToken);
      if (row.status === 'PENDING') {
        await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
      }
      return row.status;
    });
  }

  async skipMissing(
    sessionId: string,
    groupId: string,
    leaseToken: string,
    claimedRevision: number,
  ): Promise<boolean> {
    return this.database.transaction(async client => {
      const result = await client.query<{ status: 'COMPLETED' | 'PENDING' }>(
        `UPDATE gateway_group_reconciliation_intents SET
           completed_revision = GREATEST(completed_revision, $4),
           status = CASE WHEN requested_revision > $4
             THEN 'PENDING'::gateway_group_intent_status ELSE 'COMPLETED'::gateway_group_intent_status END,
           attempt_count = CASE WHEN requested_revision > $4 THEN 0 ELSE attempt_count END,
           next_attempt_at = CASE WHEN requested_revision > $4 THEN GREATEST(not_before, now())
             ELSE next_attempt_at END,
           claimed_revision = NULL, lease_token = NULL, lease_expires_at = NULL,
           completed_at = CASE WHEN requested_revision = $4 THEN now() ELSE NULL END,
           last_error_code = 'GROUP_NOT_FOUND', updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
           AND lease_token = $3 AND lease_expires_at > now() AND claimed_revision = $4
         RETURNING status`,
        [sessionId, groupId, leaseToken, claimedRevision],
      );
      if (result.rowCount !== 1) return false;
      if (result.rows[0]?.status === 'COMPLETED') {
        await client.query(
          `UPDATE gateway_groups SET is_active = false,
             send_capability = 'DENIED', send_capability_reason = 'GROUP_INACTIVE',
             capability_checked_at = now(), capability_invalidated_at = NULL,
             capability_revision = capability_revision + 1,
             capability_refresh_attempt_count = 0,
             capability_refresh_lease_token = NULL,
             capability_refresh_lease_expires_at = NULL,
             capability_refresh_error = NULL, updated_at = now()
           WHERE session_id = $1 AND id = $2 AND is_active = true`,
          [sessionId, groupId],
        );
      }
      await this.rateLimits.release(client, sessionId, leaseToken);
      if (result.rows[0]?.status === 'PENDING') {
        await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
      }
      return true;
    });
  }

  async fail(
    sessionId: string,
    groupId: string,
    leaseToken: string,
    claimedRevision: number,
    policy: GatewayGroupIntentFailurePolicy,
  ): Promise<'RETRY' | 'FAILED' | 'PENDING' | 'LOST_OWNERSHIP'> {
    return this.database.transaction(async client => {
      const owned = await client.query<{ attempt_count: number; requested_revision: string }>(
        `SELECT attempt_count, requested_revision::text
         FROM gateway_group_reconciliation_intents
         WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
           AND lease_token = $3 AND lease_expires_at > now() AND claimed_revision = $4 FOR UPDATE`,
        [sessionId, groupId, leaseToken, claimedRevision],
      );
      const row = owned.rows[0];
      if (!row) return 'LOST_OWNERSHIP';
      const newerRevision = Number(row.requested_revision) > claimedRevision;
      const willRetry = policy.retryable && row.attempt_count < this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS;
      const status = newerRevision ? 'PENDING' : willRetry ? 'RETRY' : 'FAILED';
      const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, row.attempt_count - 1))
        * (0.8 + Math.random() * 0.4);
      await client.query(
        `UPDATE gateway_group_reconciliation_intents SET status = $5::gateway_group_intent_status,
           attempt_count = CASE WHEN $5 = 'PENDING' THEN 0 ELSE attempt_count END,
           next_attempt_at = CASE WHEN $5 = 'PENDING' THEN GREATEST(not_before, now())
             WHEN $5 = 'RETRY' THEN now() + ($6::double precision * interval '1 second')
             ELSE next_attempt_at END,
           claimed_revision = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error_code = $7, completed_at = CASE WHEN $5 = 'FAILED' THEN now() ELSE NULL END,
           updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND lease_token = $3 AND claimed_revision = $4`,
        [sessionId, groupId, leaseToken, claimedRevision, status, delaySeconds, policy.code],
      );
      await this.rateLimits.failure(client, sessionId, leaseToken, policy);
      if (status !== 'FAILED') {
        await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
      }
      return status;
    });
  }

  async recoverExpired(): Promise<number> {
    const result = await this.database.query(
      `WITH recovered AS (
         UPDATE gateway_group_reconciliation_intents SET
           status = CASE WHEN requested_revision > COALESCE(claimed_revision, completed_revision)
             THEN 'PENDING'::gateway_group_intent_status WHEN attempt_count >= $1
             THEN 'FAILED'::gateway_group_intent_status ELSE 'RETRY'::gateway_group_intent_status END,
           attempt_count = CASE WHEN requested_revision > COALESCE(claimed_revision, completed_revision)
             THEN 0 ELSE attempt_count END,
           claimed_revision = NULL, lease_token = NULL, lease_expires_at = NULL,
           next_attempt_at = CASE
             WHEN requested_revision > COALESCE(claimed_revision, completed_revision) THEN GREATEST(not_before, now())
             WHEN attempt_count >= $1 THEN next_attempt_at ELSE now() END,
           last_error_code = 'LEASE_EXPIRED', updated_at = now()
         WHERE status = 'RUNNING' AND lease_expires_at < now()
         RETURNING session_id, status
       ), released AS (
         UPDATE gateway_sync_rate_limits limits SET active_lease_token = NULL,
           active_lease_expires_at = NULL, updated_at = now()
         FROM recovered WHERE limits.session_id = recovered.session_id
           AND limits.active_lease_expires_at < now()
       ) SELECT count(*)::integer AS count FROM recovered`,
      [this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS],
    );
    return Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0);
  }

  private async acquireMutationLock(
    client: PoolClient,
    sessionId: string,
    groupId: string,
  ): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('gateway-group-intent:' || $1 || ':' || $2, 0)
       )`,
      [sessionId, groupId],
    );
  }

}

class LostGatewayGroupIntentLeaseError extends Error {}
