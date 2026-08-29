import type { PoolClient } from 'pg';
import type { CampaignExecutionMode, CampaignPreflightDto } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CampaignRunDto } from '../../contracts/campaigns/campaign-run.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';
import { DatabaseService } from '../../core/database/database.service';
import {
  RuntimeMutationReceiptRepository,
  type RuntimeMutationReceipt,
  type RuntimeMutationType,
} from '../../core/database/runtime-mutation-receipt.repository';
import {
  CampaignRunRow,
  campaignRunSelect,
  capabilitySnapshotChanged,
  mapCampaignRun,
} from './campaign-run.persistence';
import { appendCampaignRunActivity } from './campaign-run-activity';

export type CampaignRunActionType = Extract<RuntimeMutationType,
  'CAMPAIGN_RUN_PAUSE' | 'CAMPAIGN_RUN_RESUME' | 'CAMPAIGN_RUN_CANCEL'>;

export interface CampaignRunActionRequest {
  operationType: CampaignRunActionType;
  idempotencyKey: string;
  requestHash: string;
}

export type CampaignRunActionResult =
  | { outcome: 'SUCCEEDED'; run: CampaignRunDto; replayed: boolean }
  | {
      outcome: 'REJECTED';
      run: CampaignRunDto;
      replayed: boolean;
      errorCode: 'CAMPAIGN_RUN_STATE_CONFLICT';
      errorMessage: string;
      errorDetails: Record<string, unknown>;
    };

export type CampaignResumeResult = CampaignRunActionResult | 'STALE_INPUT' | null;

export class CampaignRunActionIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different campaign run action');
    this.name = 'CampaignRunActionIdempotencyConflictError';
  }
}

export class CampaignRunLifecycleRepository {
  private readonly mutationReceipts = new RuntimeMutationReceiptRepository();

  constructor(private readonly database: DatabaseService) {}

  async findActionResult(
    id: string,
    request: CampaignRunActionRequest,
  ): Promise<CampaignRunActionResult | null> {
    const receipt = await this.mutationReceipts.find(
      this.database,
      request.operationType,
      request.idempotencyKey,
    );
    if (!receipt) return null;
    this.assertReceipt(receipt, id, request);
    const result = await this.database.query<CampaignRunRow>(
      `${campaignRunSelect} WHERE cr.id = $1`,
      [id],
    );
    if (!result.rows[0]) throw new Error('Campaign run action receipt references a missing run');
    return this.actionResult(receipt, mapCampaignRun(result.rows[0]), true);
  }

  async activateDue(): Promise<number> {
    return this.database.transaction(async client => {
      const result = await client.query<{ id: string }>(
        `UPDATE campaign_runs SET status = 'RUNNING', status_reason = NULL,
           started_at = COALESCE(started_at, now()), updated_at = now()
         WHERE status = 'SCHEDULED' AND scheduled_at <= now()
         RETURNING id`,
      );
      for (const run of result.rows) {
        await appendCampaignRunActivity(client, {
          runId: run.id,
          eventType: 'campaign_run.started',
          severity: 'INFO',
          origin: 'RUNTIME',
        });
      }
      return result.rowCount ?? 0;
    });
  }

  async finalize(limit: number): Promise<number> {
    return this.database.transaction(async client => {
      const result = await client.query<{
        id: string;
        status: 'COMPLETED' | 'PARTIAL_FAILED';
        previous_status: 'RUNNING' | 'COMPLETED' | 'PARTIAL_FAILED';
        campaign_id: string;
        execution_mode: CampaignExecutionMode;
      }>(
        `WITH finalizable AS (
         SELECT cr.id, cr.status AS previous_status,
           bool_or(cd.status IN ('FAILED','UNKNOWN','BLOCKED_CAPABILITY_CHANGED','CANCELLED')) AS has_failure,
           CASE WHEN bool_or(cd.status IN ('FAILED','UNKNOWN','BLOCKED_CAPABILITY_CHANGED','CANCELLED'))
             THEN 'PARTIAL_FAILED'::campaign_run_status
             ELSE 'COMPLETED'::campaign_run_status END AS desired_status
         FROM campaign_runs cr
         JOIN campaign_deliveries cd ON cd.run_id = cr.id
         WHERE cr.status IN ('RUNNING','COMPLETED','PARTIAL_FAILED')
         GROUP BY cr.id, cr.status
         HAVING bool_and(cd.status NOT IN ('PENDING','MATERIALIZED','PROCESSING'))
           AND (cr.status = 'RUNNING' OR cr.status IS DISTINCT FROM
             CASE WHEN bool_or(cd.status IN ('FAILED','UNKNOWN','BLOCKED_CAPABILITY_CHANGED','CANCELLED'))
               THEN 'PARTIAL_FAILED'::campaign_run_status
               ELSE 'COMPLETED'::campaign_run_status END)
         ORDER BY min(cr.started_at), cr.id
         LIMIT $1
       )
       UPDATE campaign_runs cr SET
         status = f.desired_status,
         status_reason = CASE WHEN f.has_failure THEN 'ONE_OR_MORE_DELIVERIES_FAILED' ELSE NULL END,
         completed_at = COALESCE(cr.completed_at, now()), updated_at = now()
       FROM finalizable f WHERE cr.id = f.id AND cr.status = f.previous_status
       RETURNING cr.id, cr.status, f.previous_status, cr.campaign_id, cr.execution_mode`,
        [limit],
      );
      const liveCampaignIds = result.rows
        .filter(row => row.execution_mode === 'LIVE')
        .map(row => row.campaign_id);
      if (liveCampaignIds.length) {
        await client.query(
          `UPDATE campaigns SET status = 'ARCHIVED', updated_at = now()
           WHERE id = ANY($1::uuid[]) AND status IN ('ACTIVE','PAUSED')`,
          [liveCampaignIds],
        );
      }
      for (const run of result.rows) {
        await appendCampaignRunActivity(client, {
          runId: run.id,
          eventType: run.status === 'COMPLETED'
            ? 'campaign_run.completed'
            : 'campaign_run.partial_failed',
          severity: run.status === 'COMPLETED' ? 'SUCCESS' : 'WARNING',
          origin: 'RUNTIME',
          metadata: run.previous_status !== 'RUNNING'
            ? {
                previousStatus: run.previous_status,
                reason: run.status === 'PARTIAL_FAILED'
                  ? 'LATE_DELIVERY_FAILURE'
                  : 'LATE_DELIVERY_RESOLUTION',
              }
            : undefined,
        });
      }
      return result.rowCount ?? 0;
    });
  }

  async pause(
    id: string,
    request: CampaignRunActionRequest,
  ): Promise<CampaignRunActionResult | null> {
    return this.database.transaction(async client => {
      const replay = await this.replayInTransaction(client, id, request);
      if (replay) return replay;
      const updated = await client.query<{
        campaign_id: string;
        execution_mode: CampaignExecutionMode;
        session_id: string;
      }>(
        `UPDATE campaign_runs SET status = 'PAUSED', status_reason = 'MANUAL_PAUSE', updated_at = now()
         WHERE id = $1 AND status IN ('SCHEDULED','RUNNING')
         RETURNING campaign_id, execution_mode, session_id`, [id],
      );
      const transition = updated.rows[0];
      if (!transition) return null;
      if (transition.execution_mode === 'LIVE') {
        await client.query(
          `UPDATE campaigns SET status = 'PAUSED', updated_at = now()
           WHERE id = $1 AND status = 'ACTIVE'`,
          [transition.campaign_id],
        );
      }
      await appendCampaignRunActivity(client, {
        runId: id,
        eventType: 'campaign_run.paused',
        severity: 'WARNING',
        origin: 'STUDIO',
        metadata: { reason: 'MANUAL_PAUSE' },
        dedupeKey: `campaign-run:${id}:pause:${request.idempotencyKey}`,
      });
      const receipt = await this.recordSuccess(client, id, transition.session_id, request);
      const result = await client.query<CampaignRunRow>(`${campaignRunSelect} WHERE cr.id = $1`, [id]);
      return this.actionResult(receipt, mapCampaignRun(result.rows[0]!), false);
    });
  }

  async rejectResume(
    id: string,
    report: CampaignPreflightDto,
    request: CampaignRunActionRequest,
  ): Promise<CampaignRunActionResult | null> {
    return this.database.transaction(async client => {
      const replay = await this.replayInTransaction(client, id, request);
      if (replay) return replay;
      const result = await client.query<{ session_id: string }>(
        `UPDATE campaign_runs SET status = 'BLOCKED', status_reason = 'PREFLIGHT_BLOCKED', preflight_status = $2,
           preflight_policy_version = $3, preflight_report = $4::jsonb, updated_at = now()
         WHERE id = $1 AND status IN ('PAUSED','BLOCKED')
         RETURNING session_id`,
        [id, report.status, report.policyVersion, JSON.stringify(report)],
      );
      const transition = result.rows[0];
      if (!transition) return null;
      await appendCampaignRunActivity(client, {
        runId: id,
        eventType: 'campaign_run.blocked',
        severity: 'WARNING',
        origin: 'STUDIO',
        metadata: { reason: 'PREFLIGHT_BLOCKED', policyVersion: report.policyVersion },
        dedupeKey: `campaign-run:${id}:resume-blocked:${request.idempotencyKey}`,
      });
      const receipt = await this.mutationReceipts.record(client, {
        operationType: request.operationType,
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        sessionId: transition.session_id,
        subjectId: id,
        resultId: id,
        resultRevision: null,
        outcome: 'REJECTED',
        errorCode: 'CAMPAIGN_RUN_STATE_CONFLICT',
        errorMessage: 'Campaign run is still blocked by preflight',
        errorDetails: { preflight: report },
      });
      const run = await client.query<CampaignRunRow>(`${campaignRunSelect} WHERE cr.id = $1`, [id]);
      return this.actionResult(receipt, mapCampaignRun(run.rows[0]!), false);
    });
  }

  async resume(
    id: string,
    report: CampaignPreflightDto,
    observedTargets: CampaignTargetDto[],
    request: CampaignRunActionRequest,
  ): Promise<CampaignResumeResult> {
    return this.database.transaction(async client => {
      const replay = await this.replayInTransaction(client, id, request);
      if (replay) return replay;
      const locked = await client.query<{
        status: string;
        scheduled_at: Date;
        campaign_id: string;
        execution_mode: CampaignExecutionMode;
        session_id: string;
      }>(
        `SELECT status, scheduled_at, campaign_id, execution_mode, session_id
         FROM campaign_runs WHERE id = $1 FOR UPDATE`, [id],
      );
      const run = locked.rows[0];
      if (!run || !['PAUSED', 'BLOCKED'].includes(run.status)) return null;
      if (await capabilitySnapshotChanged(client, id, observedTargets)) return 'STALE_INPUT';
      await client.query(
        `UPDATE campaign_run_targets crt SET
           capability = g.send_capability, capability_reason = g.send_capability_reason,
           capability_revision = g.capability_revision, capability_checked_at = g.capability_checked_at
         FROM gateway_groups g
         WHERE crt.run_id = $1 AND g.session_id = crt.session_id AND g.id = crt.group_id
           AND NOT EXISTS (
             SELECT 1 FROM campaign_deliveries cd WHERE cd.run_id = crt.run_id
               AND cd.group_id = crt.group_id AND cd.status <> 'PENDING'
           )`,
        [id],
      );
      await client.query(
        `INSERT INTO campaign_deliveries (run_id, group_id)
         SELECT run_id, group_id FROM campaign_run_targets WHERE run_id = $1
         ON CONFLICT (run_id, group_id) DO NOTHING`, [id],
      );
      const status = run.scheduled_at > new Date() ? 'SCHEDULED' : 'RUNNING';
      await client.query(
        `UPDATE campaign_runs SET status = $2::campaign_run_status, status_reason = NULL, preflight_status = $3,
           preflight_policy_version = $4, preflight_report = $5::jsonb,
           started_at = CASE WHEN $2::campaign_run_status = 'RUNNING' THEN COALESCE(started_at, now()) ELSE started_at END,
           completed_at = NULL, updated_at = now() WHERE id = $1`,
        [id, status, report.status, report.policyVersion, JSON.stringify(report)],
      );
      if (run.execution_mode === 'LIVE') {
        await client.query(
          `UPDATE campaigns SET status = 'ACTIVE', updated_at = now()
           WHERE id = $1 AND status = 'PAUSED'`,
          [run.campaign_id],
        );
      }
      await appendCampaignRunActivity(client, {
        runId: id,
        eventType: 'campaign_run.resumed',
        severity: 'INFO',
        origin: 'STUDIO',
        metadata: { resumedStatus: status },
        dedupeKey: `campaign-run:${id}:resume:${request.idempotencyKey}`,
      });
      const receipt = await this.recordSuccess(client, id, run.session_id, request);
      const result = await client.query<CampaignRunRow>(`${campaignRunSelect} WHERE cr.id = $1`, [id]);
      return this.actionResult(receipt, mapCampaignRun(result.rows[0]!), false);
    });
  }

  async cancel(
    id: string,
    request: CampaignRunActionRequest,
  ): Promise<CampaignRunActionResult | null> {
    return this.database.transaction(async client => {
      const replay = await this.replayInTransaction(client, id, request);
      if (replay) return replay;
      const locked = await client.query<{
        status: string;
        campaign_id: string;
        execution_mode: CampaignExecutionMode;
        session_id: string;
      }>(
        `SELECT status, campaign_id, execution_mode, session_id
         FROM campaign_runs WHERE id = $1 FOR UPDATE`, [id],
      );
      const run = locked.rows[0];
      if (!run || !['PREPARING', 'BLOCKED', 'SCHEDULED', 'RUNNING', 'PAUSED'].includes(run.status)) return null;
      await client.query(
        `INSERT INTO campaign_deliveries (run_id, group_id)
         SELECT run_id, group_id FROM campaign_run_targets WHERE run_id = $1
         ON CONFLICT (run_id, group_id) DO NOTHING`, [id],
      );
      await client.query(
        `UPDATE message_jobs SET status = 'CANCELLED', updated_at = now()
         WHERE id IN (SELECT message_job_id FROM campaign_deliveries WHERE run_id = $1)
           AND status IN ('SCHEDULED','QUEUED')`, [id],
      );
      await client.query(
        `UPDATE campaign_deliveries cd SET status = 'CANCELLED',
           failure_reason = 'Campaign run cancelled', updated_at = now()
         WHERE run_id = $1 AND (
           status = 'PENDING' OR EXISTS (
             SELECT 1 FROM message_jobs mj WHERE mj.id = cd.message_job_id AND mj.status = 'CANCELLED'
           )
         )`, [id],
      );
      await client.query(
        `UPDATE campaign_runs SET status = 'CANCELLED', status_reason = 'CANCELLED_BY_OPERATOR',
           completed_at = now(), updated_at = now() WHERE id = $1`, [id],
      );
      if (run.execution_mode === 'LIVE') {
        await client.query(
          `UPDATE campaigns SET status = 'ARCHIVED', updated_at = now()
           WHERE id = $1 AND status IN ('ACTIVE','PAUSED')`,
          [run.campaign_id],
        );
      }
      await appendCampaignRunActivity(client, {
        runId: id,
        eventType: 'campaign_run.cancelled',
        severity: 'WARNING',
        origin: 'STUDIO',
        metadata: { reason: 'CANCELLED_BY_OPERATOR' },
        dedupeKey: `campaign-run:${id}:cancel:${request.idempotencyKey}`,
      });
      const receipt = await this.recordSuccess(client, id, run.session_id, request);
      const result = await client.query<CampaignRunRow>(`${campaignRunSelect} WHERE cr.id = $1`, [id]);
      return this.actionResult(receipt, mapCampaignRun(result.rows[0]!), false);
    });
  }

  private async replayInTransaction(
    client: PoolClient,
    id: string,
    request: CampaignRunActionRequest,
  ): Promise<CampaignRunActionResult | null> {
    const receipt = await this.mutationReceipts.lockAndFind(
      client,
      request.operationType,
      request.idempotencyKey,
    );
    if (!receipt) return null;
    this.assertReceipt(receipt, id, request);
    const result = await client.query<CampaignRunRow>(
      `${campaignRunSelect} WHERE cr.id = $1`,
      [id],
    );
    if (!result.rows[0]) throw new Error('Campaign run action receipt references a missing run');
    return this.actionResult(receipt, mapCampaignRun(result.rows[0]), true);
  }

  private recordSuccess(
    client: PoolClient,
    id: string,
    sessionId: string,
    request: CampaignRunActionRequest,
  ): Promise<RuntimeMutationReceipt> {
    return this.mutationReceipts.record(client, {
      operationType: request.operationType,
      idempotencyKey: request.idempotencyKey,
      requestHash: request.requestHash,
      sessionId,
      subjectId: id,
      resultId: id,
      resultRevision: null,
    });
  }

  private assertReceipt(
    receipt: RuntimeMutationReceipt,
    id: string,
    request: CampaignRunActionRequest,
  ): void {
    if (receipt.requestHash !== request.requestHash
      || receipt.subjectId !== id
      || receipt.resultId !== id) {
      throw new CampaignRunActionIdempotencyConflictError();
    }
  }

  private actionResult(
    receipt: RuntimeMutationReceipt,
    run: CampaignRunDto,
    replayed: boolean,
  ): CampaignRunActionResult {
    if (receipt.outcome === 'SUCCEEDED') return { outcome: 'SUCCEEDED', run, replayed };
    if (receipt.errorCode !== 'CAMPAIGN_RUN_STATE_CONFLICT' || !receipt.errorMessage) {
      throw new Error('Rejected campaign run action receipt is incomplete');
    }
    return {
      outcome: 'REJECTED',
      run,
      replayed,
      errorCode: receipt.errorCode,
      errorMessage: receipt.errorMessage,
      errorDetails: receipt.errorDetails ?? {},
    };
  }

  async listRunningIds(limit: number): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM campaign_runs WHERE status = 'RUNNING' ORDER BY started_at, id LIMIT $1`, [limit],
    );
    return result.rows.map(row => row.id);
  }
}
