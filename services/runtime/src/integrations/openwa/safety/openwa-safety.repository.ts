import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { appendActivityEvent } from '../../../core/activity/activity-writer';
import { DatabaseService } from '../../../core/database/database.service';
import {
  RuntimeMutationReceiptRepository,
  type RuntimeMutationType,
} from '../../../core/database/runtime-mutation-receipt.repository';
import {
  emissionIntervalMs,
  messageBucketPolicies,
  messageSafetyPolicy,
  operationBucketPolicies,
} from './openwa-safety-policy';
import {
  OPENWA_SAFETY_POLICY_VERSION,
  type CommittedOpenWAMessagePermit,
  type OpenWAConnectorCommandCommit,
  type OpenWAMessageOperationClass,
  type OpenWAMessagePermit,
  type OpenWAOperationClass,
  type OpenWAOperationPermit,
  type OpenWAOperationPermitDecision,
  type OpenWAOperationOutcome,
  type OpenWAPermitDecision,
  type OpenWASafetyBucketPolicy,
  type OpenWASafetyProfile,
  type OpenWASafetyQuiescenceSnapshot,
  type OpenWASafetyScopeSnapshot,
} from './openwa-safety.types';

interface ScopeRow {
  scope_type: 'WORKSPACE' | 'UPSTREAM' | 'SESSION';
  upstream_id: string;
  session_id: string;
  circuit_state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'MANUAL_BLOCKED';
  rate_mode: 'NORMAL' | 'THROTTLED';
  reason_code: string | null;
  cooldown_until: Date | null;
  policy_profile: OpenWASafetyProfile;
  policy_version: number;
  revision: string;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  updated_at: Date;
}

interface BucketRow {
  theoretical_arrival_at: Date;
  emission_interval_ms: number;
  burst_capacity: number;
}

const scopeStatus = (row: ScopeRow): OpenWASafetyScopeSnapshot['status'] => {
  if (row.circuit_state === 'MANUAL_BLOCKED') return 'BLOCKED';
  if (row.circuit_state === 'HALF_OPEN') return 'RECOVERY';
  if (row.circuit_state === 'OPEN' || (row.cooldown_until && row.cooldown_until > new Date())) return 'COOLDOWN';
  return row.rate_mode === 'THROTTLED' ? 'THROTTLED' : 'READY';
};

const mapScope = (row: ScopeRow): OpenWASafetyScopeSnapshot => ({
  scopeType: row.scope_type,
  effectiveScopeType: row.scope_type,
  circuitState: row.circuit_state,
  rateMode: row.rate_mode,
  status: scopeStatus(row),
  reason: row.reason_code,
  cooldownUntil: row.cooldown_until,
  profile: row.policy_profile,
  policyVersion: row.policy_version,
  revision: Number(row.revision),
  lastSuccessAt: row.last_success_at,
  lastFailureAt: row.last_failure_at,
  updatedAt: row.updated_at,
});

const statusPriority: Record<OpenWASafetyScopeSnapshot['status'], number> = {
  READY: 0,
  THROTTLED: 1,
  RECOVERY: 2,
  COOLDOWN: 3,
  BLOCKED: 4,
};

const mapEffectiveSession = (scopes: ScopeRow[]): OpenWASafetyScopeSnapshot => {
  const session = scopes.find(scope => scope.scope_type === 'SESSION');
  if (!session) throw new Error('OpenWA session safety scope is missing');
  const effective = scopes.reduce((current, candidate) => (
    statusPriority[scopeStatus(candidate)] > statusPriority[scopeStatus(current)]
      ? candidate
      : current
  ), session);
  return {
    ...mapScope(session),
    effectiveScopeType: effective.scope_type,
    status: scopeStatus(effective),
    reason: effective.reason_code,
    cooldownUntil: effective.cooldown_until,
  };
};

export class OpenWASafetyMutationConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used for a different OpenWA safety mutation');
    this.name = 'OpenWASafetyMutationConflictError';
  }
}

@Injectable()
export class OpenWASafetyRepository {
  private readonly mutationReceipts = new RuntimeMutationReceiptRepository();

  constructor(private readonly database: DatabaseService) {}

  async reserveOperation(input: {
    upstreamId: string;
    sessionId?: string;
    operationClass: Exclude<OpenWAOperationClass, OpenWAMessageOperationClass>;
    holderType: 'GATEWAY_SYNC' | 'GROUP_REFRESH' | 'CONTACT_SYNC' | 'WEBHOOK_RECONCILIATION' | 'PROBE';
    holderId: string;
    leaseTtlMs: number;
    upstreamCost?: number;
  }): Promise<OpenWAOperationPermitDecision> {
    const upstreamCost = input.upstreamCost ?? 1;
    if (!Number.isInteger(upstreamCost) || upstreamCost < 1 || upstreamCost > 10) {
      throw new Error('OpenWA operation upstream cost must be an integer between 1 and 10');
    }
    const sessionId = input.sessionId ?? '';
    return this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `openwa-safety:${input.upstreamId}:${sessionId}`,
      ]);
      await this.ensureScopes(client, input.upstreamId, sessionId);
      let scopes = await this.lockScopes(client, input.upstreamId, sessionId);
      scopes = await this.transitionExpiredCircuits(client, scopes);
      const circuitDecision = this.circuitDecision(scopes);
      if (circuitDecision) return circuitDecision;

      const activeRecovery = await client.query<{ lease_expires_at: Date }>(
        `SELECT max(lease_expires_at) AS lease_expires_at FROM openwa_safety_leases
         WHERE lane = 'RECOVERY' AND lease_expires_at > now() AND (
           (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '')
           OR (scope_type = 'UPSTREAM' AND upstream_id = $1 AND session_id = '')
           OR ($2 <> '' AND scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2)
         )`,
        [input.upstreamId, sessionId],
      );
      if (activeRecovery.rows[0]?.lease_expires_at) {
        return {
          outcome: 'DEFERRED', notBefore: activeRecovery.rows[0].lease_expires_at,
          reason: 'RECOVERY_PROBE_IN_FLIGHT',
        };
      }

      const profile = (scopes.find(scope => scope.scope_type === 'SESSION')
        ?? scopes.find(scope => scope.scope_type === 'WORKSPACE'))!.policy_profile;
      const policies = operationBucketPolicies(input.operationClass, Boolean(sessionId), upstreamCost);
      const bucketDecision = await this.checkBuckets(client, { upstreamId: input.upstreamId, sessionId }, policies);
      if (bucketDecision) return bucketDecision;

      const token = await client.query<{ token: string }>('SELECT gen_random_uuid()::text AS token');
      const permitToken = token.rows[0]!.token;
      const recovering = scopes.filter(scope => scope.circuit_state === 'HALF_OPEN');
      if (recovering.length) {
        for (const scope of recovering) {
          await client.query(
            `INSERT INTO openwa_safety_leases
               (scope_type, upstream_id, session_id, lane, lease_token, holder_type, holder_id,
                lease_expires_at)
             VALUES ($1, $2, $3, 'RECOVERY', $4, $5, $6,
               now() + ($7::double precision * interval '1 millisecond'))`,
            [scope.scope_type, scope.upstream_id, scope.session_id, permitToken,
              input.holderType, input.holderId, input.leaseTtlMs],
          );
        }
      }
      for (const policy of policies) {
        await this.consumeBucket(client, { upstreamId: input.upstreamId, sessionId }, policy);
      }
      return {
        outcome: 'GRANTED',
        permit: {
          permitToken,
          upstreamId: input.upstreamId,
          sessionId,
          operationClass: input.operationClass,
          policyProfile: profile,
          policyVersion: OPENWA_SAFETY_POLICY_VERSION,
          reservedAt: new Date(),
        },
      };
    });
  }

  async reserveMessage(input: {
    upstreamId: string;
    sessionId: string;
    messageJobId: string;
    recipientId: string;
    operationClass: OpenWAMessageOperationClass;
    leaseTtlMs: number;
  }): Promise<OpenWAPermitDecision> {
    return this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `openwa-safety:${input.upstreamId}:${input.sessionId}`,
      ]);
      await this.ensureScopes(client, input.upstreamId, input.sessionId);
      let scopes = await this.lockScopes(client, input.upstreamId, input.sessionId);
      scopes = await this.transitionExpiredCircuits(client, scopes);
      const circuitDecision = this.circuitDecision(scopes);
      if (circuitDecision) return circuitDecision;

      const activeRecovery = await client.query<{ lease_expires_at: Date }>(
        `SELECT max(lease_expires_at) AS lease_expires_at FROM openwa_safety_leases
         WHERE lane = 'RECOVERY' AND lease_expires_at > now() AND (
           (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '')
           OR (scope_type = 'UPSTREAM' AND upstream_id = $1 AND session_id = '')
           OR (scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2)
         )`,
        [input.upstreamId, input.sessionId],
      );
      if (activeRecovery.rows[0]?.lease_expires_at) {
        return {
          outcome: 'DEFERRED',
          notBefore: activeRecovery.rows[0].lease_expires_at,
          reason: 'RECOVERY_PROBE_IN_FLIGHT',
        };
      }

      const profile = (scopes.find(scope => scope.scope_type === 'SESSION')
        ?? scopes.find(scope => scope.scope_type === 'WORKSPACE'))!.policy_profile;
      const frequency = messageSafetyPolicy(profile);
      const recent = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM message_jobs
         WHERE session_id = $1 AND recipient_id = $2
           AND current_upstream_started_at >= now() - ($3::double precision * interval '1 millisecond')
           AND status IN ('PROCESSING','ACCEPTED','SENT','DELIVERED','READ','FAILED','UNKNOWN')`,
        [input.sessionId, input.recipientId, frequency.recipientWindowMs],
      );
      if (Number(recent.rows[0]?.count ?? 0) >= frequency.recipientLimit) {
        const first = await client.query<{ next_at: Date }>(
          `SELECT min(current_upstream_started_at) + ($3::double precision * interval '1 millisecond') AS next_at
           FROM message_jobs WHERE session_id = $1 AND recipient_id = $2
             AND current_upstream_started_at >= now() - ($3::double precision * interval '1 millisecond')
             AND status IN ('PROCESSING','ACCEPTED','SENT','DELIVERED','READ','FAILED','UNKNOWN')`,
          [input.sessionId, input.recipientId, frequency.recipientWindowMs],
        );
        return {
          outcome: 'DEFERRED',
          notBefore: first.rows[0]?.next_at ?? new Date(Date.now() + frequency.recipientWindowMs),
          reason: 'RECIPIENT_FREQUENCY_LIMIT',
        };
      }

      const activeLease = await client.query<{ lease_expires_at: Date }>(
        `SELECT lease_expires_at FROM openwa_safety_leases
         WHERE scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2
           AND lane = 'ACTIVE_SESSION' AND lease_expires_at > now()`,
        [input.upstreamId, input.sessionId],
      );
      if (activeLease.rows[0]) {
        return {
          outcome: 'DEFERRED',
          notBefore: activeLease.rows[0].lease_expires_at,
          reason: 'SESSION_OPERATION_IN_FLIGHT',
        };
      }

      const policies = messageBucketPolicies(profile, input.operationClass);
      const bucketDecision = await this.checkBuckets(client, input, policies);
      if (bucketDecision) return bucketDecision;

      const lease = await client.query<{ lease_token: string; reserved_at: Date; expires_at: Date }>(
        `INSERT INTO openwa_safety_leases
           (scope_type, upstream_id, session_id, lane, lease_token, holder_type, holder_id, lease_expires_at)
         VALUES ('SESSION', $1, $2, 'ACTIVE_SESSION', gen_random_uuid(), 'MESSAGE_JOB', $3,
           now() + ($4::double precision * interval '1 millisecond'))
         ON CONFLICT (scope_type, upstream_id, session_id, lane) DO UPDATE SET
           lease_token = gen_random_uuid(), holder_type = 'MESSAGE_JOB', holder_id = EXCLUDED.holder_id,
           lease_expires_at = EXCLUDED.lease_expires_at, acquired_at = now(), updated_at = now()
         WHERE openwa_safety_leases.lease_expires_at <= now()
         RETURNING lease_token, acquired_at AS reserved_at, lease_expires_at AS expires_at`,
        [input.upstreamId, input.sessionId, input.messageJobId, input.leaseTtlMs],
      );
      if (!lease.rows[0]) {
        throw new Error('OpenWA safety lease changed while reserving a message permit');
      }
      for (const scope of scopes.filter(scope => scope.circuit_state === 'HALF_OPEN')) {
        const recovery = await client.query(
          `INSERT INTO openwa_safety_leases
             (scope_type, upstream_id, session_id, lane, lease_token, holder_type, holder_id,
              lease_expires_at)
           VALUES ($1, $2, $3, 'RECOVERY', $4, 'MESSAGE_JOB', $5,
             now() + ($6::double precision * interval '1 millisecond'))
           ON CONFLICT (scope_type, upstream_id, session_id, lane) DO UPDATE SET
             lease_token = EXCLUDED.lease_token, holder_type = EXCLUDED.holder_type,
             holder_id = EXCLUDED.holder_id, lease_expires_at = EXCLUDED.lease_expires_at,
             acquired_at = now(), updated_at = now()
           WHERE openwa_safety_leases.lease_expires_at <= now()
           RETURNING lease_token`,
          [scope.scope_type, scope.upstream_id, scope.session_id, lease.rows[0].lease_token,
            input.messageJobId, input.leaseTtlMs],
        );
        if (!recovery.rowCount) {
          throw new Error('OpenWA recovery lane changed while reserving a probe');
        }
      }
      for (const policy of policies) await this.consumeBucket(client, input, policy);
      const attached = await client.query(
        `UPDATE message_jobs SET safety_lease_token = $2, safety_policy_version = $3, updated_at = now()
         WHERE id = $1 AND status = 'PROCESSING' AND cancellation_requested_at IS NULL`,
        [input.messageJobId, lease.rows[0].lease_token, OPENWA_SAFETY_POLICY_VERSION],
      );
      if (!attached.rowCount) {
        throw new Error('Message job changed while attaching its OpenWA safety permit');
      }
      return {
        outcome: 'GRANTED',
        permit: {
          permitToken: lease.rows[0].lease_token,
          leaseToken: lease.rows[0].lease_token,
          upstreamId: input.upstreamId,
          sessionId: input.sessionId,
          messageJobId: input.messageJobId,
          recipientId: input.recipientId,
          operationClass: input.operationClass,
          policyProfile: profile,
          policyVersion: OPENWA_SAFETY_POLICY_VERSION,
          reservedAt: lease.rows[0].reserved_at,
          expiresAt: lease.rows[0].expires_at,
        },
      };
    });
  }

  async commitMessageStart(
    permit: OpenWAMessagePermit,
    connectorHealthRequired = false,
    connectorCommand?: OpenWAConnectorCommandCommit,
  ): Promise<CommittedOpenWAMessagePermit | null> {
    if (connectorHealthRequired && !connectorCommand) {
      throw new Error('Connector-required message commit requires a durable connector command');
    }
    return this.database.transaction(async client => {
      const result = await client.query<{
        attempt_id: string;
        command_id: string;
        binding_generation: string | null;
        started_at: Date;
        attempt_number: number;
      }>(
         `WITH connector AS (
           SELECT binding_generation
           FROM openwa_connector_sessions
           WHERE session_id = $3
             AND desired_webhook_id IS NOT NULL
             AND desired_connector_id IS NOT NULL
             AND binding_synced_at IS NOT NULL
             AND health_state = 'HEALTHY'
             AND health_lease_expires_at > now()
             AND ($11::bigint IS NULL OR binding_generation = $11)
         ), valid_lease AS (
           SELECT 1 FROM openwa_safety_leases
           WHERE scope_type = 'SESSION' AND upstream_id = $2 AND session_id = $3
             AND lane = 'ACTIVE_SESSION' AND lease_token = $4 AND lease_expires_at > now()
         ), eligible AS (
           SELECT jobs.id,
             CASE WHEN $8::boolean THEN (SELECT binding_generation FROM connector) ELSE NULL END
               AS binding_generation
           FROM message_jobs jobs
           WHERE jobs.id = $1 AND jobs.status = 'PROCESSING'
             AND jobs.safety_lease_token = $4 AND jobs.cancellation_requested_at IS NULL
             AND jobs.safety_policy_version = $6
             AND (($7 = 'MESSAGE_SEND_TEXT' AND jobs.message_type = 'text')
               OR ($7 = 'MESSAGE_SEND_IMAGE' AND jobs.message_type = 'image'))
             AND jobs.current_upstream_started_at IS NULL
             AND EXISTS (SELECT 1 FROM valid_lease)
             AND NOT EXISTS (
               SELECT 1 FROM openwa_safety_scopes scopes
               WHERE (
                 (scopes.scope_type = 'WORKSPACE' AND scopes.upstream_id = '' AND scopes.session_id = '')
                 OR (scopes.scope_type = 'UPSTREAM' AND scopes.upstream_id = $2 AND scopes.session_id = '')
                 OR (scopes.scope_type = 'SESSION' AND scopes.upstream_id = $2 AND scopes.session_id = $3)
               ) AND (
                 scopes.circuit_state IN ('OPEN', 'MANUAL_BLOCKED')
                 OR scopes.cooldown_until > now()
                 OR (scopes.circuit_state = 'HALF_OPEN' AND NOT EXISTS (
                   SELECT 1 FROM openwa_safety_leases recovery
                   WHERE recovery.scope_type = scopes.scope_type
                     AND recovery.upstream_id = scopes.upstream_id
                     AND recovery.session_id = scopes.session_id
                     AND recovery.lane = 'RECOVERY'
                     AND recovery.lease_token = $4
                     AND recovery.lease_expires_at > now()
                 ))
               )
             )
             AND (
               NOT $8::boolean
               OR EXISTS (SELECT 1 FROM connector)
             )
             AND EXISTS (
               SELECT 1 FROM gateway_sessions sessions
               WHERE sessions.id = jobs.session_id AND sessions.status = 'ready'
                 AND sessions.engine_loaded = true AND sessions.restriction IS NULL
             )
             AND EXISTS (
               SELECT 1 FROM gateway_groups groups
               WHERE groups.session_id = jobs.session_id AND groups.id = $5
                 AND groups.is_active = true AND groups.send_capability = 'ALLOWED'
                 AND groups.capability_invalidated_at IS NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM campaign_deliveries deliveries
               JOIN campaign_runs runs ON runs.id = deliveries.run_id
               WHERE deliveries.message_job_id = jobs.id AND runs.status <> 'RUNNING'
             )
         ), updated AS (
           UPDATE message_jobs jobs SET current_upstream_started_at = now(),
             attempt_count = attempt_count + 1,
             lease_expires_at = CASE WHEN $8::boolean THEN NULL ELSE jobs.lease_expires_at END,
             updated_at = now()
           FROM eligible WHERE jobs.id = eligible.id
           RETURNING jobs.id, jobs.current_upstream_started_at AS started_at,
             jobs.attempt_count AS attempt_number, jobs.safety_policy_version,
             eligible.binding_generation
         ), attempt AS (
           INSERT INTO message_attempts
             (message_job_id, attempt_number, outcome, upstream_started_at, safety_policy_version,
              attempt_id, command_id, transport_state, binding_generation, safety_permit_token,
              safety_upstream_id, safety_policy_profile, payload_sha256, command_body,
              command_expires_at, ingress_next_attempt_at, transport_started_at)
           SELECT id, attempt_number, 'PROCESSING', started_at, safety_policy_version,
             COALESCE($9::uuid, gen_random_uuid()), COALESCE($10::uuid, gen_random_uuid()),
             'DISPATCH_STARTED', binding_generation,
             CASE WHEN $13::bytea IS NULL THEN NULL ELSE $4::uuid END,
             CASE WHEN $13::bytea IS NULL THEN NULL ELSE $2 END,
             CASE WHEN $13::bytea IS NULL THEN NULL ELSE $15 END,
             $12, $13, $14,
             CASE WHEN $13::bytea IS NULL THEN NULL ELSE now() END, started_at
           FROM updated
           RETURNING attempt_id, command_id, message_job_id, binding_generation
         )
         SELECT attempt.attempt_id, attempt.command_id, attempt.binding_generation::text,
           updated.started_at, updated.attempt_number
         FROM updated JOIN attempt ON attempt.message_job_id = updated.id`,
        [permit.messageJobId, permit.upstreamId, permit.sessionId, permit.leaseToken,
          permit.recipientId, permit.policyVersion, permit.operationClass, connectorHealthRequired,
          connectorCommand?.attemptId ?? null,
          connectorCommand?.commandId ?? null,
          connectorCommand?.bindingGeneration ?? null,
          connectorCommand?.payloadSha256 ?? null,
          connectorCommand?.commandBody ?? null,
          connectorCommand?.expiresAt ?? null,
          connectorCommand ? permit.policyProfile : null],
      );
      const row = result.rows[0];
      return row ? {
        ...permit,
        attemptId: row.attempt_id,
        commandId: row.command_id,
        bindingGeneration: row.binding_generation === null ? null : Number(row.binding_generation),
        upstreamStartedAt: row.started_at,
        upstreamAttemptNumber: row.attempt_number,
      } as CommittedOpenWAMessagePermit : null;
    });
  }

  async healthyConnectorBindingGeneration(sessionId: string): Promise<number | null> {
    const result = await this.database.query<{ binding_generation: string }>(
      `SELECT binding_generation::text
       FROM openwa_connector_sessions
       WHERE session_id = $1
         AND desired_webhook_id IS NOT NULL
         AND desired_connector_id IS NOT NULL
         AND binding_synced_at IS NOT NULL
         AND health_state = 'HEALTHY'
         AND health_lease_expires_at > now()`,
      [sessionId],
    );
    return result.rows[0] ? Number(result.rows[0].binding_generation) : null;
  }

  async recordOutcome(permit: OpenWAOperationPermit, outcome: OpenWAOperationOutcome): Promise<void> {
    await this.database.transaction(client => this.recordOutcomeWithClient(client, permit, outcome));
  }

  async recordMessageAttemptOutcomeWithClient(
    client: PoolClient,
    attemptId: string,
    outcome: OpenWAOperationOutcome,
  ): Promise<boolean> {
    const result = await client.query<{
      message_job_id: string;
      upstream_id: string;
      session_id: string;
      recipient_id: string;
      message_type: 'text' | 'image';
      lease_token: string;
      reserved_at: Date;
      expires_at: Date;
      safety_policy_version: number;
      policy_profile: OpenWASafetyProfile;
    }>(
      `SELECT jobs.id::text AS message_job_id, attempts.safety_upstream_id AS upstream_id,
         jobs.session_id, jobs.recipient_id, jobs.message_type,
         attempts.safety_permit_token::text AS lease_token,
         attempts.upstream_started_at AS reserved_at,
         COALESCE(attempts.command_expires_at, attempts.upstream_started_at) AS expires_at,
         attempts.safety_policy_version, attempts.safety_policy_profile AS policy_profile
       FROM message_attempts attempts
       JOIN message_jobs jobs ON jobs.id = attempts.message_job_id
       WHERE attempts.attempt_id = $1
         AND attempts.safety_permit_token IS NOT NULL
         AND attempts.safety_upstream_id IS NOT NULL
         AND attempts.safety_policy_profile IS NOT NULL
       FOR UPDATE OF attempts, jobs`,
      [attemptId],
    );
    const row = result.rows[0];
    if (!row) return false;
    const permit: OpenWAMessagePermit = {
      permitToken: row.lease_token,
      leaseToken: row.lease_token,
      upstreamId: row.upstream_id,
      sessionId: row.session_id,
      operationClass: row.message_type === 'text' ? 'MESSAGE_SEND_TEXT' : 'MESSAGE_SEND_IMAGE',
      policyProfile: row.policy_profile,
      policyVersion: row.safety_policy_version,
      reservedAt: row.reserved_at,
      expiresAt: row.expires_at,
      messageJobId: row.message_job_id,
      recipientId: row.recipient_id,
    };
    await this.recordOutcomeWithClient(client, permit, outcome);
    return true;
  }

  private async recordOutcomeWithClient(
    client: PoolClient,
    permit: OpenWAOperationPermit,
    outcome: OpenWAOperationOutcome,
  ): Promise<void> {
    const recorded = await client.query(
        `INSERT INTO openwa_safety_outcome_receipts
           (permit_token, upstream_id, session_id, operation_class, outcome_kind, policy_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (permit_token) DO NOTHING`,
        [permit.permitToken, permit.upstreamId, permit.sessionId, permit.operationClass,
          outcome.kind, permit.policyVersion],
      );
    if (recorded.rowCount !== 1) {
      await this.releaseWithClient(client, permit);
      return;
    }
    if (outcome.kind === 'SUCCESS') {
      await this.recordSuccess(client, permit);
    } else if (outcome.kind === 'RATE_LIMITED') {
      await this.recordRateLimit(client, permit, outcome.retryAfterMs);
    } else if (outcome.kind === 'AMBIGUOUS' || outcome.kind === 'TRANSIENT_FAILURE') {
      await this.recordFailure(client, permit, outcome.kind);
    } else if (outcome.kind === 'SESSION_RESTRICTED') {
      await this.blockSession(client, permit, 'SESSION_RESTRICTED');
    }
    await this.releaseWithClient(client, permit);
  }

  async release(permit: OpenWAOperationPermit): Promise<void> {
    await this.database.transaction(client => this.releaseWithClient(client, permit));
  }

  async sessionSnapshot(upstreamId: string, sessionId: string): Promise<OpenWASafetyScopeSnapshot> {
    return this.database.transaction(async client => {
      await this.ensureScopes(client, upstreamId, sessionId);
      let scopes = await this.lockScopes(client, upstreamId, sessionId);
      scopes = await this.transitionExpiredCircuits(client, scopes);
      return mapEffectiveSession(scopes);
    });
  }

  async sessionQuiescence(
    upstreamId: string,
    sessionId: string,
  ): Promise<OpenWASafetyQuiescenceSnapshot> {
    const result = await this.database.query<{
      processing_message_jobs: number;
      unsettled_connector_commands: number;
      active_safety_leases: number;
      checked_at: Date;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM message_jobs
          WHERE session_id = $2 AND status = 'PROCESSING') AS processing_message_jobs,
         (SELECT count(*)::integer
          FROM message_attempts AS attempt
          JOIN message_jobs AS job ON job.id = attempt.message_job_id
          WHERE job.session_id = $2
            AND attempt.transport_state IN (
              'DISPATCH_STARTED', 'INGRESS_ACCEPTED', 'SEND_STARTED'
            )) AS unsettled_connector_commands,
         (SELECT count(*)::integer FROM openwa_safety_leases
          WHERE upstream_id = $1 AND session_id = $2
            AND lease_expires_at > now()) AS active_safety_leases,
         now() AS checked_at`,
      [upstreamId, sessionId],
    );
    const row = result.rows[0]!;
    return {
      drained: row.processing_message_jobs === 0
        && row.unsettled_connector_commands === 0
        && row.active_safety_leases === 0,
      processingMessageJobs: row.processing_message_jobs,
      unsettledConnectorCommands: row.unsettled_connector_commands,
      activeSafetyLeases: row.active_safety_leases,
      checkedAt: row.checked_at,
    };
  }

  async workspaceQuiescence(): Promise<OpenWASafetyQuiescenceSnapshot> {
    const result = await this.database.query<{
      processing_message_jobs: number;
      unsettled_connector_commands: number;
      active_safety_leases: number;
      checked_at: Date;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM message_jobs
          WHERE status = 'PROCESSING') AS processing_message_jobs,
         (SELECT count(*)::integer
          FROM message_attempts
          WHERE transport_state IN (
            'DISPATCH_STARTED', 'INGRESS_ACCEPTED', 'SEND_STARTED'
          )) AS unsettled_connector_commands,
         (SELECT count(*)::integer FROM openwa_safety_leases
          WHERE lease_expires_at > now()) AS active_safety_leases,
         now() AS checked_at`,
    );
    const row = result.rows[0]!;
    return {
      drained: row.processing_message_jobs === 0
        && row.unsettled_connector_commands === 0
        && row.active_safety_leases === 0,
      processingMessageJobs: row.processing_message_jobs,
      unsettledConnectorCommands: row.unsettled_connector_commands,
      activeSafetyLeases: row.active_safety_leases,
      checkedAt: row.checked_at,
    };
  }

  async mutateWorkspace(input: {
    upstreamId: string;
    sessionId: string;
    operationType: Extract<RuntimeMutationType,
      'OPENWA_WORKSPACE_BLOCK' | 'OPENWA_WORKSPACE_RESUME'>;
    idempotencyKey: string;
    requestHash: string;
    reason?: string;
  }): Promise<OpenWASafetyScopeSnapshot> {
    const subjectId = 'managed-runtime-workspace';
    return this.database.transaction(async client => {
      const receipt = await this.mutationReceipts.lockAndFind(
        client, input.operationType, input.idempotencyKey,
      );
      if (receipt && (receipt.requestHash !== input.requestHash
        || receipt.sessionId !== input.sessionId
        || receipt.subjectId !== subjectId)) {
        throw new OpenWASafetyMutationConflictError();
      }
      await this.ensureScopes(client, input.upstreamId, input.sessionId);
      if (!receipt) {
        const result = input.operationType === 'OPENWA_WORKSPACE_BLOCK'
          ? await client.query<ScopeRow>(
            `UPDATE openwa_safety_scopes SET circuit_state = 'MANUAL_BLOCKED',
               reason_code = $1, manual_blocked_at = now(), cooldown_until = NULL,
               success_streak = 0, revision = revision + 1, updated_at = now()
             WHERE scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = ''
             RETURNING *`,
            [input.reason ?? 'MANAGED_RUNTIME_MAINTENANCE'],
          )
          : await client.query<ScopeRow>(
            `UPDATE openwa_safety_scopes SET circuit_state = 'CLOSED', rate_mode = 'NORMAL',
               reason_code = NULL, cooldown_until = NULL, manual_blocked_at = NULL,
               consecutive_rate_limits = 0, consecutive_transient_failures = 0,
               consecutive_ambiguous_outcomes = 0, success_streak = 0,
               revision = revision + 1, updated_at = now()
             WHERE scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = ''
             RETURNING *`,
          );
        const updated = result.rows[0]!;
        const eventType = input.operationType === 'OPENWA_WORKSPACE_BLOCK'
          ? 'openwa_safety.workspace_blocked'
          : 'openwa_safety.workspace_resumed';
        await appendActivityEvent(client, {
          sessionId: input.sessionId,
          eventType,
          category: 'SESSION',
          severity: input.operationType === 'OPENWA_WORKSPACE_BLOCK' ? 'WARNING' : 'SUCCESS',
          origin: 'STUDIO',
          subjectType: 'OPENWA_SAFETY_SCOPE',
          subjectId,
          subjectLabelSnapshot: 'Managed Runtime workspace',
          metadata: {
            circuitState: updated.circuit_state,
            profile: updated.policy_profile,
            policyVersion: updated.policy_version,
            ...(input.reason ? { reason: input.reason } : {}),
          },
          dedupeKey: `openwa-safety:${input.operationType}:${input.idempotencyKey}`,
        });
        await this.mutationReceipts.record(client, {
          operationType: input.operationType,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          sessionId: input.sessionId,
          subjectId,
          resultId: subjectId,
          resultRevision: Number(updated.revision),
        });
      }
      let scopes = await this.lockScopes(client, input.upstreamId, input.sessionId);
      scopes = await this.transitionExpiredCircuits(client, scopes);
      return mapEffectiveSession(scopes);
    });
  }

  async mutateSession(input: {
    upstreamId: string;
    sessionId: string;
    operationType: Extract<RuntimeMutationType,
      'OPENWA_SESSION_BLOCK' | 'OPENWA_SESSION_RESUME' | 'OPENWA_SAFETY_PROFILE_CHANGE'>;
    idempotencyKey: string;
    requestHash: string;
    reason?: string;
    profile?: OpenWASafetyProfile;
  }): Promise<OpenWASafetyScopeSnapshot> {
    return this.database.transaction(async client => {
      const receipt = await this.mutationReceipts.lockAndFind(
        client, input.operationType, input.idempotencyKey,
      );
      if (receipt && (receipt.requestHash !== input.requestHash
        || receipt.sessionId !== input.sessionId
        || receipt.subjectId !== input.sessionId)) {
        throw new OpenWASafetyMutationConflictError();
      }
      await this.ensureScopes(client, input.upstreamId, input.sessionId);
      if (!receipt) {
        let result;
        if (input.operationType === 'OPENWA_SESSION_BLOCK') {
          result = await client.query<ScopeRow>(
            `UPDATE openwa_safety_scopes SET circuit_state = 'MANUAL_BLOCKED',
               reason_code = $3, manual_blocked_at = now(), cooldown_until = NULL,
               success_streak = 0, revision = revision + 1, updated_at = now()
             WHERE scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2
             RETURNING *`,
            [input.upstreamId, input.sessionId, input.reason ?? 'OPERATOR_BLOCKED'],
          );
        } else if (input.operationType === 'OPENWA_SESSION_RESUME') {
          result = await client.query<ScopeRow>(
            `UPDATE openwa_safety_scopes SET circuit_state = 'CLOSED', rate_mode = 'NORMAL',
               reason_code = NULL, cooldown_until = NULL, manual_blocked_at = NULL,
               consecutive_rate_limits = 0, consecutive_transient_failures = 0,
               consecutive_ambiguous_outcomes = 0, success_streak = 0,
               revision = revision + 1, updated_at = now()
             WHERE scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2
             RETURNING *`,
            [input.upstreamId, input.sessionId],
          );
          await client.query(
            `UPDATE openwa_safety_buckets SET theoretical_arrival_at = now(),
               emission_interval_ms = base_emission_interval_ms, updated_at = now()
             WHERE scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2`,
            [input.upstreamId, input.sessionId],
          );
        } else {
          result = await client.query<ScopeRow>(
            `UPDATE openwa_safety_scopes SET policy_profile = $3,
               policy_version = $4, revision = revision + 1, updated_at = now()
             WHERE scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2
             RETURNING *`,
            [input.upstreamId, input.sessionId, input.profile, OPENWA_SAFETY_POLICY_VERSION],
          );
        }
        const updated = result.rows[0]!;
        const session = await client.query<{ name: string }>(
          'SELECT name FROM gateway_sessions WHERE id = $1',
          [input.sessionId],
        );
        const eventType = input.operationType === 'OPENWA_SESSION_BLOCK'
          ? 'openwa_safety.session_blocked'
          : input.operationType === 'OPENWA_SESSION_RESUME'
            ? 'openwa_safety.session_resumed'
            : 'openwa_safety.profile_changed';
        await appendActivityEvent(client, {
          sessionId: input.sessionId,
          eventType,
          category: 'SESSION',
          severity: input.operationType === 'OPENWA_SESSION_BLOCK'
            ? 'WARNING'
            : input.operationType === 'OPENWA_SESSION_RESUME'
              ? 'SUCCESS'
              : 'INFO',
          origin: 'STUDIO',
          subjectType: 'OPENWA_SAFETY_SCOPE',
          subjectId: input.sessionId,
          subjectLabelSnapshot: session.rows[0]?.name ?? input.sessionId,
          metadata: {
            circuitState: updated.circuit_state,
            profile: updated.policy_profile,
            policyVersion: updated.policy_version,
            ...(input.reason ? { reason: input.reason } : {}),
          },
          dedupeKey: `openwa-safety:${input.operationType}:${input.idempotencyKey}`,
        });
        await this.mutationReceipts.record(client, {
          operationType: input.operationType,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          sessionId: input.sessionId,
          subjectId: input.sessionId,
          resultId: input.sessionId,
          resultRevision: Number(updated.revision),
        });
        const scopes = await this.lockScopes(client, input.upstreamId, input.sessionId);
        return mapEffectiveSession(scopes);
      }
      let scopes = await this.lockScopes(client, input.upstreamId, input.sessionId);
      scopes = await this.transitionExpiredCircuits(client, scopes);
      return mapEffectiveSession(scopes);
    });
  }

  private async ensureScopes(client: PoolClient, upstreamId: string, sessionId: string): Promise<void> {
    await client.query(
      `INSERT INTO openwa_safety_scopes (scope_type, upstream_id, session_id)
       VALUES ('WORKSPACE', '', ''), ('UPSTREAM', $1, '')
       ON CONFLICT DO NOTHING`,
      [upstreamId],
    );
    if (sessionId) {
      await client.query(
        `INSERT INTO openwa_safety_scopes (scope_type, upstream_id, session_id)
         VALUES ('SESSION', $1, $2) ON CONFLICT DO NOTHING`,
        [upstreamId, sessionId],
      );
    }
  }

  private async lockScopes(client: PoolClient, upstreamId: string, sessionId: string): Promise<ScopeRow[]> {
    const result = await client.query<ScopeRow>(
      `SELECT * FROM openwa_safety_scopes
       WHERE (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '')
          OR (scope_type = 'UPSTREAM' AND upstream_id = $1 AND session_id = '')
          OR (scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2)
       ORDER BY scope_type FOR UPDATE`,
      [upstreamId, sessionId],
    );
    return result.rows;
  }

  private async transitionExpiredCircuits(client: PoolClient, scopes: ScopeRow[]): Promise<ScopeRow[]> {
    const expired = scopes.filter(scope => scope.circuit_state === 'OPEN'
      && scope.cooldown_until !== null
      && scope.cooldown_until.valueOf() <= Date.now());
    if (!expired.length) return scopes;
    const updated = await client.query<ScopeRow>(
      `UPDATE openwa_safety_scopes SET circuit_state = 'HALF_OPEN', reason_code = 'RECOVERY_PROBE',
         cooldown_until = NULL, revision = revision + 1, updated_at = now()
       WHERE (scope_type, upstream_id, session_id) IN (
         SELECT * FROM unnest($1::openwa_safety_scope_type[], $2::text[], $3::text[])
       ) AND circuit_state = 'OPEN' AND cooldown_until <= now()
       RETURNING *`,
      [expired.map(scope => scope.scope_type), expired.map(scope => scope.upstream_id),
        expired.map(scope => scope.session_id)],
    );
    const replacements = new Map(updated.rows.map(scope => [
      `${scope.scope_type}:${scope.upstream_id}:${scope.session_id}`,
      scope,
    ]));
    return scopes.map(scope => replacements.get(
      `${scope.scope_type}:${scope.upstream_id}:${scope.session_id}`,
    ) ?? scope);
  }

  private circuitDecision(
    scopes: ScopeRow[],
  ): Extract<OpenWAPermitDecision, { outcome: 'BLOCKED' | 'DEFERRED' }> | null {
    const now = Date.now();
    let cooldown: { notBefore: Date; reason: string } | null = null;
    for (const scope of scopes) {
      if (scope.circuit_state === 'MANUAL_BLOCKED') {
        return { outcome: 'BLOCKED', reason: scope.reason_code ?? 'OPERATOR_BLOCKED' };
      }
      if (scope.circuit_state === 'OPEN' && !scope.cooldown_until) {
        return { outcome: 'BLOCKED', reason: scope.reason_code ?? 'CIRCUIT_OPEN' };
      }
      if (scope.cooldown_until && scope.cooldown_until.valueOf() > now
        && (!cooldown || scope.cooldown_until > cooldown.notBefore)) {
        cooldown = {
          notBefore: scope.cooldown_until,
          reason: scope.reason_code ?? (scope.circuit_state === 'OPEN' ? 'CIRCUIT_OPEN' : 'COOLDOWN'),
        };
      }
    }
    return cooldown ? { outcome: 'DEFERRED', ...cooldown } : null;
  }

  private async checkBuckets(
    client: PoolClient,
    input: { upstreamId: string; sessionId: string },
    policies: OpenWASafetyBucketPolicy[],
  ): Promise<Extract<OpenWAPermitDecision, { outcome: 'DEFERRED' }> | null> {
    let latest: Date | null = null;
    for (const policy of policies) {
      const keys = this.bucketScope(input, policy);
      const interval = emissionIntervalMs(policy);
      await client.query(
        `INSERT INTO openwa_safety_buckets
           (scope_type, upstream_id, session_id, operation_class, window_name,
            base_emission_interval_ms, emission_interval_ms, burst_capacity,
            effective_rate_numerator, effective_rate_period_ms, policy_version)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10)
         ON CONFLICT (scope_type, upstream_id, session_id, operation_class, window_name)
         DO UPDATE SET base_emission_interval_ms = EXCLUDED.base_emission_interval_ms,
           emission_interval_ms = GREATEST(openwa_safety_buckets.emission_interval_ms,
             EXCLUDED.base_emission_interval_ms),
           burst_capacity = EXCLUDED.burst_capacity,
           effective_rate_numerator = EXCLUDED.effective_rate_numerator,
           effective_rate_period_ms = EXCLUDED.effective_rate_period_ms,
           policy_version = EXCLUDED.policy_version`,
        [policy.scopeType, keys.upstreamId, keys.sessionId, policy.operationClass, policy.windowName,
          interval, policy.burst, policy.limit, policy.periodMs, OPENWA_SAFETY_POLICY_VERSION],
      );
      const bucket = await client.query<BucketRow>(
        `SELECT theoretical_arrival_at, emission_interval_ms, burst_capacity
         FROM openwa_safety_buckets
         WHERE scope_type = $1 AND upstream_id = $2 AND session_id = $3
           AND operation_class = $4 AND window_name = $5 FOR UPDATE`,
        [policy.scopeType, keys.upstreamId, keys.sessionId, policy.operationClass, policy.windowName],
      );
      const row = bucket.rows[0]!;
      const allowedAt = row.theoretical_arrival_at.valueOf()
        - (row.burst_capacity - 1) * row.emission_interval_ms;
      if (allowedAt > Date.now() && (!latest || allowedAt > latest.valueOf())) latest = new Date(allowedAt);
    }
    return latest ? { outcome: 'DEFERRED', notBefore: latest, reason: 'RATE_BUDGET' } : null;
  }

  private async consumeBucket(
    client: PoolClient,
    input: { upstreamId: string; sessionId: string },
    policy: OpenWASafetyBucketPolicy,
  ): Promise<void> {
    const keys = this.bucketScope(input, policy);
    await client.query(
      `UPDATE openwa_safety_buckets SET
         theoretical_arrival_at = GREATEST(theoretical_arrival_at, now())
           + ($6 * emission_interval_ms * interval '1 millisecond'),
         updated_at = now()
       WHERE scope_type = $1 AND upstream_id = $2 AND session_id = $3
         AND operation_class = $4 AND window_name = $5`,
      [policy.scopeType, keys.upstreamId, keys.sessionId, policy.operationClass, policy.windowName, policy.cost],
    );
  }

  private bucketScope(
    input: { upstreamId: string; sessionId: string },
    policy: OpenWASafetyBucketPolicy,
  ): { upstreamId: string; sessionId: string } {
    return policy.scopeType === 'UPSTREAM'
      ? { upstreamId: input.upstreamId, sessionId: '' }
      : { upstreamId: input.upstreamId, sessionId: input.sessionId };
  }

  private async recordSuccess(client: PoolClient, permit: OpenWAOperationPermit): Promise<void> {
    const successes = await client.query<{ scope_type: ScopeRow['scope_type']; success_streak: number }>(
      `UPDATE openwa_safety_scopes SET consecutive_rate_limits = 0,
         consecutive_transient_failures = 0, consecutive_ambiguous_outcomes = 0,
         success_streak = success_streak + 1, last_success_at = now(),
         circuit_state = CASE WHEN circuit_state = 'HALF_OPEN' THEN 'CLOSED' ELSE circuit_state END,
         cooldown_until = CASE WHEN circuit_state = 'HALF_OPEN' THEN NULL ELSE cooldown_until END,
         reason_code = CASE WHEN circuit_state = 'HALF_OPEN' THEN NULL ELSE reason_code END,
         revision = revision + 1, updated_at = now()
       WHERE (scope_type = 'UPSTREAM' AND upstream_id = $1 AND session_id = '')
          OR (scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2)
          OR (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '')
       RETURNING scope_type, success_streak`,
      [permit.upstreamId, permit.sessionId],
    );
    const upstreamReady = successes.rows.some(scope => (
      scope.scope_type === 'UPSTREAM' && scope.success_streak >= 20
    ));
    const sessionReady = successes.rows.some(scope => (
      scope.scope_type === 'SESSION' && scope.success_streak >= 20
    ));
    if (!successes.rows.some(scope => scope.success_streak >= 20)) return;
    if (upstreamReady || sessionReady) {
      await client.query(
        `UPDATE openwa_safety_buckets SET
           emission_interval_ms = GREATEST(base_emission_interval_ms,
             floor(emission_interval_ms * 0.9)::integer), updated_at = now()
         WHERE ($3 AND scope_type = 'UPSTREAM' AND upstream_id = $1 AND session_id = '')
           OR ($4 AND scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2)`,
        [permit.upstreamId, permit.sessionId, upstreamReady, sessionReady],
      );
    }
    await client.query(
      `UPDATE openwa_safety_scopes SET success_streak = success_streak - 20, updated_at = now()
       WHERE success_streak >= 20 AND (
         (scope_type = 'UPSTREAM' AND upstream_id = $1 AND session_id = '')
         OR (scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2)
         OR (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '')
       )`,
      [permit.upstreamId, permit.sessionId],
    );
    await client.query(
      `UPDATE openwa_safety_scopes scopes SET rate_mode = 'NORMAL', reason_code = NULL,
         cooldown_until = NULL, revision = revision + 1, updated_at = now()
       WHERE scopes.rate_mode = 'THROTTLED'
         AND (scopes.cooldown_until IS NULL OR scopes.cooldown_until <= now())
         AND ((scopes.scope_type = 'UPSTREAM' AND scopes.upstream_id = $1 AND scopes.session_id = '')
           OR (scopes.scope_type = 'SESSION' AND scopes.upstream_id = $1 AND scopes.session_id = $2)
           OR (scopes.scope_type = 'WORKSPACE' AND scopes.upstream_id = '' AND scopes.session_id = ''))
         AND NOT EXISTS (
           SELECT 1 FROM openwa_safety_buckets buckets
           WHERE buckets.scope_type = scopes.scope_type
             AND buckets.upstream_id = scopes.upstream_id AND buckets.session_id = scopes.session_id
             AND buckets.emission_interval_ms > buckets.base_emission_interval_ms
         )`,
      [permit.upstreamId, permit.sessionId],
    );
  }

  private async recordRateLimit(
    client: PoolClient,
    permit: OpenWAOperationPermit,
    retryAfterMs = 60_000,
  ): Promise<void> {
    await client.query(
      `UPDATE openwa_safety_scopes SET rate_mode = 'THROTTLED',
         reason_code = CASE WHEN circuit_state = 'MANUAL_BLOCKED'
           THEN reason_code ELSE 'UPSTREAM_RATE_LIMIT' END,
         cooldown_until = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN cooldown_until
           ELSE GREATEST(COALESCE(cooldown_until, '-infinity'::timestamptz),
             now() + ($3::double precision * interval '1 millisecond')) END,
         circuit_state = CASE WHEN circuit_state = 'HALF_OPEN' THEN 'OPEN' ELSE circuit_state END,
         consecutive_rate_limits = consecutive_rate_limits + 1, success_streak = 0,
         last_failure_at = now(), last_rate_pressure_at = now(), revision = revision + 1, updated_at = now()
       WHERE (scope_type = 'UPSTREAM' AND upstream_id = $1 AND session_id = '')
          OR (scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2)
          OR (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '')`,
      [permit.upstreamId, permit.sessionId, retryAfterMs],
    );
    await client.query(
      `UPDATE openwa_safety_buckets SET emission_interval_ms = LEAST(
         effective_rate_period_ms, emission_interval_ms * 2), updated_at = now()
       WHERE upstream_id = $1 AND (session_id = '' OR session_id = $2)`,
      [permit.upstreamId, permit.sessionId],
    );
  }

  private async recordFailure(
    client: PoolClient,
    permit: OpenWAOperationPermit,
    kind: 'AMBIGUOUS' | 'TRANSIENT_FAILURE',
  ): Promise<void> {
    const column = kind === 'AMBIGUOUS'
      ? 'consecutive_ambiguous_outcomes'
      : 'consecutive_transient_failures';
    const reason = kind === 'AMBIGUOUS' ? 'AMBIGUOUS_OUTCOME' : 'UPSTREAM_FAILURE_STREAK';
    await client.query(
      `UPDATE openwa_safety_scopes SET ${column} = ${column} + 1,
         success_streak = 0, last_failure_at = now(),
         circuit_state = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN circuit_state
           WHEN circuit_state = 'HALF_OPEN' OR ${column} + 1 >= 3 THEN 'OPEN'
           ELSE circuit_state END,
         cooldown_until = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN cooldown_until
           WHEN circuit_state = 'HALF_OPEN' OR ${column} + 1 >= 3
             THEN now() + interval '15 minutes'
           ELSE cooldown_until END,
         reason_code = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN reason_code
           WHEN circuit_state = 'HALF_OPEN' OR ${column} + 1 >= 3 THEN $3
           ELSE reason_code END,
         revision = revision + 1, updated_at = now()
       WHERE (scope_type = 'UPSTREAM' AND upstream_id = $1 AND session_id = '')
          OR (scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2)
          OR (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '')`,
      [permit.upstreamId, permit.sessionId, reason],
    );
  }

  private async blockSession(client: PoolClient, permit: OpenWAOperationPermit, reason: string): Promise<void> {
    await client.query(
      `UPDATE openwa_safety_scopes SET circuit_state = 'MANUAL_BLOCKED', reason_code = $3,
         manual_blocked_at = now(), cooldown_until = NULL, last_failure_at = now(),
         revision = revision + 1, updated_at = now()
       WHERE scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2`,
      [permit.upstreamId, permit.sessionId, reason],
    );
  }

  private async releaseWithClient(client: PoolClient, permit: OpenWAOperationPermit): Promise<void> {
    const leaseToken = 'leaseToken' in permit && typeof permit.leaseToken === 'string'
      ? permit.leaseToken
      : permit.permitToken;
    if (leaseToken) {
      await client.query(
        `DELETE FROM openwa_safety_leases WHERE lease_token = $3
           AND ((scope_type = 'UPSTREAM' AND upstream_id = $1 AND session_id = '')
             OR (scope_type = 'SESSION' AND upstream_id = $1 AND session_id = $2)
             OR (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = ''))`,
        [permit.upstreamId, permit.sessionId, leaseToken],
      );
    }
    if ('messageJobId' in permit && 'leaseToken' in permit) {
      await client.query(
        `UPDATE message_jobs SET safety_lease_token = NULL, updated_at = now()
         WHERE id = $1 AND safety_lease_token = $2`,
        [permit.messageJobId, permit.leaseToken],
      );
    }
  }
}
