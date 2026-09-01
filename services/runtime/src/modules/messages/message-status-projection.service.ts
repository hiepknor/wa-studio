import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import type { MessageJobStatus } from './message-job.types';

interface MessageEventProjectionRow {
  event_id: string;
  session_id: string;
  message_id: string;
  event_type: string;
  delivery_status: string | null;
  projection_state: 'PENDING' | 'APPLIED' | 'IGNORED';
}

interface MatchedMessageJobRow {
  id: string;
  status: MessageJobStatus;
}

export interface MessageStatusProjectionResult {
  state: 'MISSING' | 'PENDING' | 'APPLIED' | 'IGNORED';
  statusAdvanced: boolean;
  jobId?: string;
}

const deliveryRanks: Readonly<Partial<Record<MessageJobStatus, number>>> = {
  ACCEPTED: 10,
  SENT: 20,
  DELIVERED: 30,
  READ: 40,
};

export function messageStatusFromEvent(
  eventType: string,
  deliveryStatus: string | null,
): MessageJobStatus | null {
  if (eventType === 'message.sent') return 'SENT';
  if (eventType === 'message.failed') return 'FAILED';
  if (eventType !== 'message.ack') return null;
  const status = deliveryStatus?.toLowerCase() ?? '';
  return ({ sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' } as const)[status] ?? null;
}

export function nextProjectedMessageStatus(
  current: MessageJobStatus,
  incoming: MessageJobStatus,
): MessageJobStatus {
  if (['FAILED', 'CANCELLED', 'DRY_RUN_COMPLETED'].includes(current)) return current;
  if (incoming === 'FAILED') {
    return ['SCHEDULED', 'QUEUED', 'PROCESSING', 'ACCEPTED', 'UNKNOWN'].includes(current)
      ? 'FAILED'
      : current;
  }
  return (deliveryRanks[incoming] ?? 0) > (deliveryRanks[current] ?? 0) ? incoming : current;
}

@Injectable()
export class MessageStatusProjectionService {
  private readonly logger = new Logger(MessageStatusProjectionService.name);

  constructor(private readonly database: DatabaseService) {}

  async projectEventInTransaction(
    client: PoolClient,
    eventId: string,
  ): Promise<MessageStatusProjectionResult> {
    const eventResult = await client.query<MessageEventProjectionRow>(
      `SELECT event_id, session_id, message_id, event_type, delivery_status, projection_state
       FROM message_events WHERE event_id = $1 FOR UPDATE`,
      [eventId],
    );
    const event = eventResult.rows[0];
    if (!event) return { state: 'MISSING', statusAdvanced: false };
    if (event.projection_state !== 'PENDING') {
      return { state: event.projection_state, statusAdvanced: false };
    }

    const incoming = messageStatusFromEvent(event.event_type, event.delivery_status);
    if (!incoming) {
      await client.query(
        `UPDATE message_events SET projection_state = 'IGNORED',
           projection_attempt_count = projection_attempt_count + 1, projected_at = now()
         WHERE event_id = $1`,
        [event.event_id],
      );
      return { state: 'IGNORED', statusAdvanced: false };
    }

    const jobResult = await client.query<MatchedMessageJobRow>(
      `SELECT id, status FROM message_jobs
       WHERE session_id = $1 AND openwa_message_id = $2
       FOR UPDATE`,
      [event.session_id, event.message_id],
    );
    const job = jobResult.rows[0];
    if (!job) {
      await client.query(
        `UPDATE message_events
         SET projection_attempt_count = projection_attempt_count + 1
         WHERE event_id = $1`,
        [event.event_id],
      );
      return { state: 'PENDING', statusAdvanced: false };
    }

    const nextStatus = nextProjectedMessageStatus(job.status, incoming);
    const statusAdvanced = nextStatus !== job.status;
    if (statusAdvanced) {
      await client.query(
        `UPDATE message_jobs SET status = $2::message_job_status, updated_at = now()
         WHERE id = $1`,
        [job.id, nextStatus],
      );
    }
    await client.query(
      `UPDATE message_events SET projection_state = 'APPLIED',
         projection_attempt_count = projection_attempt_count + 1,
         projected_job_id = $2, projected_at = now()
       WHERE event_id = $1`,
      [event.event_id, job.id],
    );
    return { state: 'APPLIED', statusAdvanced, jobId: job.id };
  }

  async reconcilePendingForJobInTransaction(client: PoolClient, jobId: string): Promise<number> {
    const jobResult = await client.query<{ session_id: string; openwa_message_id: string | null }>(
      `SELECT session_id, openwa_message_id FROM message_jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    const job = jobResult.rows[0];
    if (!job?.openwa_message_id) return 0;

    const events = await client.query<{ event_id: string }>(
      `SELECT event_id FROM message_events
       WHERE session_id = $1 AND message_id = $2 AND projection_state = 'PENDING'
       ORDER BY occurred_at, event_id FOR UPDATE`,
      [job.session_id, job.openwa_message_id],
    );
    for (const event of events.rows) {
      await this.projectEventInTransaction(client, event.event_id);
    }
    return events.rowCount ?? 0;
  }

  async repairPending(limit = 100): Promise<number> {
    const candidates = await this.database.query<{ event_id: string }>(
      `SELECT event.event_id
       FROM message_events event
       WHERE event.projection_state = 'PENDING'
         AND EXISTS (
           SELECT 1 FROM message_jobs job
           WHERE job.session_id = event.session_id
             AND job.openwa_message_id = event.message_id
         )
       ORDER BY event.occurred_at, event.event_id
       LIMIT $1`,
      [limit],
    );
    let repaired = 0;
    const errors: Error[] = [];
    for (const candidate of candidates.rows) {
      try {
        const result = await this.database.transaction(client =>
          this.projectEventInTransaction(client, candidate.event_id));
        if (result.state === 'APPLIED' || result.state === 'IGNORED') repaired += 1;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        errors.push(failure);
        this.logger.error({
          event: 'messages.status_projection.repair_failed',
          messageEventId: candidate.event_id,
          error: failure,
        });
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to repair ${errors.length} message status projection(s)`);
    }
    return repaired;
  }
}
