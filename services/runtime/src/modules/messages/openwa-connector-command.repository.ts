import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import type { OpenWAConnectorIngressFailureKind } from '../../integrations/openwa/openwa-connector-ingress.client';
import { OpenWASafetyRepository } from '../../integrations/openwa/safety/openwa-safety.repository';

export interface ClaimedOpenWAConnectorCommand {
  attemptId: string;
  commandId: string;
  messageJobId: string;
  leaseId: string;
  body: Buffer;
  payloadSha256: string;
  expiresAt: Date;
  deliveryAttempt: number;
}

interface CommandRow {
  attempt_id: string;
  command_id: string;
  message_job_id: string;
  ingress_lease_id: string;
  command_body: Buffer;
  payload_sha256: string;
  command_expires_at: Date;
  ingress_delivery_attempts: number;
}

@Injectable()
export class OpenWAConnectorCommandRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly safety: OpenWASafetyRepository,
  ) {}

  async claimDue(input: {
    limit: number;
    leaseMs: number;
    maximumAttempts: number;
    attemptId?: string;
  }): Promise<ClaimedOpenWAConnectorCommand[]> {
    const result = await this.database.query<CommandRow>(
      `WITH candidates AS (
         SELECT attempt_id
         FROM message_attempts
         WHERE command_body IS NOT NULL
           AND transport_state = 'DISPATCH_STARTED'
           AND command_expires_at > now()
           AND ingress_delivery_attempts < $3
           AND ingress_next_attempt_at <= now()
           AND (ingress_lease_id IS NULL OR ingress_lease_expires_at <= now())
           AND ($4::uuid IS NULL OR attempt_id = $4)
         ORDER BY ingress_next_attempt_at, command_expires_at, attempt_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE message_attempts AS attempt SET
         ingress_lease_id = gen_random_uuid(),
         ingress_lease_expires_at = now() + $2 * interval '1 millisecond',
         ingress_delivery_attempts = attempt.ingress_delivery_attempts + 1
       FROM candidates
       WHERE attempt.attempt_id = candidates.attempt_id
       RETURNING attempt.attempt_id::text, attempt.command_id::text,
         attempt.message_job_id::text, attempt.ingress_lease_id::text,
         attempt.command_body, attempt.payload_sha256, attempt.command_expires_at,
         attempt.ingress_delivery_attempts`,
      [input.limit, input.leaseMs, input.maximumAttempts, input.attemptId ?? null],
    );
    return result.rows.map(row => ({
      attemptId: row.attempt_id,
      commandId: row.command_id,
      messageJobId: row.message_job_id,
      leaseId: row.ingress_lease_id,
      body: row.command_body,
      payloadSha256: row.payload_sha256,
      expiresAt: row.command_expires_at,
      deliveryAttempt: row.ingress_delivery_attempts,
    }));
  }

  async markAccepted(command: ClaimedOpenWAConnectorCommand): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE message_attempts SET
         transport_state = 'INGRESS_ACCEPTED',
         ingress_accepted_at = now(),
         ingress_lease_id = NULL,
         ingress_lease_expires_at = NULL,
         ingress_last_error = NULL,
         ingress_last_failure_kind = NULL
       WHERE attempt_id = $1 AND ingress_lease_id = $2
         AND transport_state = 'DISPATCH_STARTED'`,
      [command.attemptId, command.leaseId],
    );
    return result.rowCount === 1;
  }

  async reschedule(
    command: ClaimedOpenWAConnectorCommand,
    error: string,
    kind: Exclude<OpenWAConnectorIngressFailureKind, 'DEFINITIVE'>,
    delayMs: number,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE message_attempts SET
         ingress_next_attempt_at = LEAST(
           command_expires_at,
           now() + $4 * interval '1 millisecond'
         ),
         ingress_last_error = left($3, 1024),
         ingress_last_failure_kind = $5,
         ingress_lease_id = NULL,
         ingress_lease_expires_at = NULL
       WHERE attempt_id = $1 AND ingress_lease_id = $2
         AND transport_state = 'DISPATCH_STARTED'`,
      [command.attemptId, command.leaseId, error, delayMs, kind],
    );
    return result.rowCount === 1;
  }

  async deferForDispatchReadiness(
    command: ClaimedOpenWAConnectorCommand,
    delayMs: number,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE message_attempts SET
         ingress_next_attempt_at = LEAST(
           command_expires_at,
           now() + $3 * interval '1 millisecond'
         ),
         ingress_delivery_attempts = GREATEST(0, ingress_delivery_attempts - 1),
         ingress_lease_id = NULL,
         ingress_lease_expires_at = NULL
       WHERE attempt_id = $1 AND ingress_lease_id = $2
         AND transport_state = 'DISPATCH_STARTED'`,
      [command.attemptId, command.leaseId, delayMs],
    );
    return result.rowCount === 1;
  }

  settleDefinitive(
    command: ClaimedOpenWAConnectorCommand,
    error: string,
  ): Promise<boolean> {
    return this.settle(command.attemptId, command.leaseId, 'FAILED', 'FAILED_DEFINITIVE', error);
  }

  settleIndeterminate(
    command: ClaimedOpenWAConnectorCommand,
    error: string,
  ): Promise<boolean> {
    return this.settle(command.attemptId, command.leaseId, 'UNKNOWN', 'INDETERMINATE', error);
  }

  async rescheduleSafeRejection(
    command: ClaimedOpenWAConnectorCommand,
    error: string,
    delayMs: number,
  ): Promise<boolean> {
    return this.database.transaction(async client => {
      const attempt = await client.query<{ message_job_id: string }>(
        `UPDATE message_attempts SET outcome = 'RETRY',
           transport_state = 'FAILED_DEFINITIVE',
           error = left($3, 1024),
           ingress_last_error = left($3, 1024),
           ingress_last_failure_kind = 'RATE_LIMITED_SAFE',
           ingress_lease_id = NULL,
           ingress_lease_expires_at = NULL
         WHERE attempt_id = $1 AND ingress_lease_id = $2
           AND transport_state = 'DISPATCH_STARTED'
         RETURNING message_job_id::text`,
        [command.attemptId, command.leaseId, error],
      );
      const messageJobId = attempt.rows[0]?.message_job_id;
      if (!messageJobId) return false;
      await this.safety.recordMessageAttemptOutcomeWithClient(client, command.attemptId, {
        kind: 'RATE_LIMITED',
        retryAfterMs: delayMs,
      });
      const job = await client.query(
        `UPDATE message_jobs SET status = 'SCHEDULED',
           scheduled_at = now() + $2 * interval '1 millisecond',
           last_error = left($3, 1024), lease_expires_at = NULL,
           current_upstream_started_at = NULL, safety_lease_token = NULL, updated_at = now()
         WHERE id = $1 AND status = 'PROCESSING'`,
        [messageJobId, delayMs, error],
      );
      return job.rowCount === 1;
    });
  }

  async settleExpired(limit: number): Promise<{ failed: number; indeterminate: number }> {
    return this.database.transaction(async client => {
      const result = await client.query<{
        attempt_id: string;
        message_job_id: string;
        outcome: 'FAILED' | 'UNKNOWN';
      }>(
        `WITH expired AS (
           SELECT attempt_id, message_job_id,
             CASE WHEN ingress_delivery_attempts = 0
                    OR ingress_last_failure_kind = 'RATE_LIMITED_SAFE'
               THEN 'FAILED' ELSE 'UNKNOWN' END AS outcome
           FROM message_attempts
           WHERE command_body IS NOT NULL
             AND transport_state = 'DISPATCH_STARTED'
             AND command_expires_at <= now()
             AND (ingress_lease_id IS NULL OR ingress_lease_expires_at <= now())
           ORDER BY command_expires_at, attempt_id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         ), updated_attempts AS (
           UPDATE message_attempts AS attempt SET
             outcome = expired.outcome,
             transport_state = CASE expired.outcome
               WHEN 'FAILED' THEN 'FAILED_DEFINITIVE'::openwa_message_transport_state
               ELSE 'INDETERMINATE'::openwa_message_transport_state
             END,
             error = CASE expired.outcome
               WHEN 'FAILED' THEN 'Connector command expired before ingress accepted it'
               ELSE 'Connector command expired without an authoritative ingress outcome'
             END,
             ingress_lease_id = NULL,
             ingress_lease_expires_at = NULL
           FROM expired WHERE attempt.attempt_id = expired.attempt_id
           RETURNING attempt.attempt_id, attempt.message_job_id, expired.outcome
         ), updated_jobs AS (
           UPDATE message_jobs AS job SET
             status = updated_attempts.outcome::message_job_status,
             last_error = CASE updated_attempts.outcome
               WHEN 'FAILED' THEN 'Connector command expired before ingress accepted it'
               ELSE 'Connector command expired without an authoritative ingress outcome'
             END,
             updated_at = now()
           FROM updated_attempts
           WHERE job.id = updated_attempts.message_job_id AND job.status = 'PROCESSING'
           RETURNING job.id
         ) SELECT attempt_id::text, message_job_id::text, outcome
           FROM updated_attempts`,
        [limit],
      );
      for (const row of result.rows) {
        await this.safety.recordMessageAttemptOutcomeWithClient(
          client,
          row.attempt_id,
          row.outcome === 'FAILED' ? { kind: 'SAFE_REJECTION' } : { kind: 'AMBIGUOUS' },
        );
      }
      return {
        failed: result.rows.filter(row => row.outcome === 'FAILED').length,
        indeterminate: result.rows.filter(row => row.outcome === 'UNKNOWN').length,
      };
    });
  }

  async settleEvidenceTimeout(limit: number, timeoutMs: number): Promise<number> {
    return this.database.transaction(async client => {
      const result = await client.query<{
        attempt_id: string;
        message_job_id: string;
      }>(
        `WITH timed_out AS (
           SELECT attempt_id, message_job_id
           FROM message_attempts
           WHERE command_body IS NOT NULL
             AND transport_state IN ('INGRESS_ACCEPTED', 'SEND_STARTED')
             AND COALESCE(last_evidence_at, ingress_accepted_at, transport_started_at)
               <= now() - ($2::double precision * interval '1 millisecond')
           ORDER BY COALESCE(last_evidence_at, ingress_accepted_at, transport_started_at), attempt_id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         ), updated_attempts AS (
           UPDATE message_attempts AS attempt SET
             outcome = 'UNKNOWN',
             transport_state = 'INDETERMINATE',
             error = 'Connector evidence deadline elapsed after durable ingress acceptance',
             ingress_lease_id = NULL,
             ingress_lease_expires_at = NULL
           FROM timed_out WHERE attempt.attempt_id = timed_out.attempt_id
           RETURNING attempt.attempt_id, attempt.message_job_id
         ), updated_jobs AS (
           UPDATE message_jobs AS job SET
             status = 'UNKNOWN',
             last_error = 'Connector evidence deadline elapsed after durable ingress acceptance',
             updated_at = now()
           FROM updated_attempts
           WHERE job.id = updated_attempts.message_job_id AND job.status = 'PROCESSING'
           RETURNING job.id
         ) SELECT attempt_id::text, message_job_id::text FROM updated_attempts`,
        [limit, timeoutMs],
      );
      for (const row of result.rows) {
        await this.safety.recordMessageAttemptOutcomeWithClient(
          client,
          row.attempt_id,
          { kind: 'AMBIGUOUS' },
        );
      }
      return result.rowCount ?? 0;
    });
  }

  private async settle(
    attemptId: string,
    leaseId: string,
    jobStatus: 'FAILED' | 'UNKNOWN',
    transportState: 'FAILED_DEFINITIVE' | 'INDETERMINATE',
    error: string,
  ): Promise<boolean> {
    return this.database.transaction(async client => {
      const attempt = await client.query<{ message_job_id: string }>(
        `UPDATE message_attempts SET outcome = $3,
           transport_state = $4::openwa_message_transport_state,
           error = left($5, 1024),
           ingress_last_error = left($5, 1024),
           ingress_last_failure_kind = CASE WHEN $3 = 'FAILED' THEN 'DEFINITIVE' ELSE 'AMBIGUOUS_RETRYABLE' END,
           ingress_lease_id = NULL,
           ingress_lease_expires_at = NULL
         WHERE attempt_id = $1 AND ingress_lease_id = $2
           AND transport_state = 'DISPATCH_STARTED'
         RETURNING message_job_id::text`,
        [attemptId, leaseId, jobStatus, transportState, error],
      );
      const messageJobId = attempt.rows[0]?.message_job_id;
      if (!messageJobId) return false;
      await client.query(
        `UPDATE message_jobs SET status = $2::message_job_status,
           last_error = left($3, 1024), updated_at = now()
         WHERE id = $1 AND status = 'PROCESSING'`,
        [messageJobId, jobStatus, error],
      );
      await this.safety.recordMessageAttemptOutcomeWithClient(
        client,
        attemptId,
        jobStatus === 'FAILED' ? { kind: 'SAFE_REJECTION' } : { kind: 'AMBIGUOUS' },
      );
      return true;
    });
  }
}
