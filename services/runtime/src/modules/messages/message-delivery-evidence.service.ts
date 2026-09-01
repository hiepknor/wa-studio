import { createHash } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  OpenWAConnectorEvidence,
  OpenWAConnectorEvidenceKind,
} from '../../contracts/openwa-connector';
import { DatabaseService } from '../../core/database/database.service';
import {
  nextProjectedMessageStatus,
  type MessageStatusProjectionResult,
} from './message-status-projection.service';
import type { MessageJobStatus } from './message-job.types';
import { OpenWASafetyRepository } from '../../integrations/openwa/safety/openwa-safety.repository';
import type { OpenWAOperationOutcome } from '../../integrations/openwa/safety/openwa-safety.types';

export const OPENWA_MESSAGE_TRANSPORT_STATES = [
  'DISPATCH_STARTED',
  'INGRESS_ACCEPTED',
  'SEND_STARTED',
  'SEND_ACCEPTED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED_DEFINITIVE',
  'INDETERMINATE',
] as const;

export type OpenWAMessageTransportState = (typeof OPENWA_MESSAGE_TRANSPORT_STATES)[number];

interface AttemptProjectionRow {
  command_id: string;
  attempt_id: string;
  binding_generation: string | null;
  payload_sha256: string | null;
  transport_state: OpenWAMessageTransportState | null;
  last_evidence_sequence: string;
  attempt_message_id: string | null;
  job_id: string;
  session_id: string;
  status: MessageJobStatus;
  job_message_id: string | null;
}

const transportRanks: Readonly<Record<Exclude<OpenWAMessageTransportState,
  'FAILED_DEFINITIVE' | 'INDETERMINATE'>, number>> = {
  DISPATCH_STARTED: 5,
  INGRESS_ACCEPTED: 10,
  SEND_STARTED: 15,
  SEND_ACCEPTED: 20,
  SENT: 30,
  DELIVERED: 40,
  READ: 50,
};

export class ConnectorEvidenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorEvidenceConflictError';
  }
}

export function transportStateFromEvidence(
  kind: OpenWAConnectorEvidenceKind,
): OpenWAMessageTransportState {
  return ({
    COMMAND_RECEIVED: 'INGRESS_ACCEPTED',
    SEND_STARTED: 'SEND_STARTED',
    SEND_ACCEPTED: 'SEND_ACCEPTED',
    SEND_REJECTED: 'FAILED_DEFINITIVE',
    SEND_INDETERMINATE: 'INDETERMINATE',
    ACK_SENT: 'SENT',
    ACK_DELIVERED: 'DELIVERED',
    ACK_READ: 'READ',
    ACK_FAILED: 'FAILED_DEFINITIVE',
  } as const)[kind];
}

export function nextTransportState(
  current: OpenWAMessageTransportState | null,
  incoming: OpenWAMessageTransportState,
): OpenWAMessageTransportState {
  if (!current || current === incoming) return incoming;
  if (current === 'READ' || current === 'FAILED_DEFINITIVE') return current;
  if (incoming === 'INDETERMINATE') {
    return ['DISPATCH_STARTED', 'INGRESS_ACCEPTED', 'SEND_STARTED'].includes(current)
      ? incoming
      : current;
  }
  if (current === 'INDETERMINATE') {
    return ['DISPATCH_STARTED', 'INGRESS_ACCEPTED', 'SEND_STARTED'].includes(incoming)
      ? current
      : incoming;
  }
  if (incoming === 'FAILED_DEFINITIVE') {
    return ['DISPATCH_STARTED', 'INGRESS_ACCEPTED', 'SEND_STARTED', 'SEND_ACCEPTED'].includes(current)
      ? incoming
      : current;
  }
  return transportRanks[incoming] > transportRanks[current] ? incoming : current;
}

export function connectorJobStatusTransitions(
  current: MessageJobStatus,
  kind: OpenWAConnectorEvidenceKind,
): MessageJobStatus[] {
  const statusByEvidence: Partial<Record<OpenWAConnectorEvidenceKind, MessageJobStatus>> = {
    SEND_ACCEPTED: 'ACCEPTED',
    SEND_REJECTED: 'FAILED',
    SEND_INDETERMINATE: 'UNKNOWN',
    ACK_SENT: 'SENT',
    ACK_DELIVERED: 'DELIVERED',
    ACK_READ: 'READ',
    ACK_FAILED: 'FAILED',
  };
  const incoming = statusByEvidence[kind];
  if (!incoming) return [];
  if (incoming === 'ACCEPTED') {
    const next = nextProjectedMessageStatus(current, incoming);
    return next === current ? [] : [next];
  }
  if (incoming === 'UNKNOWN') return current === 'PROCESSING' ? ['UNKNOWN'] : [];

  const transitions: MessageJobStatus[] = [];
  let cursor = current;
  if (['SENT', 'DELIVERED', 'READ'].includes(incoming) && cursor === 'PROCESSING') {
    transitions.push('ACCEPTED');
    cursor = 'ACCEPTED';
  }
  const next = nextProjectedMessageStatus(cursor, incoming);
  if (next !== cursor) transitions.push(next);
  return transitions;
}

export function safetyOutcomeFromConnectorEvidence(
  evidence: Pick<OpenWAConnectorEvidence, 'kind' | 'errorClass'>,
): OpenWAOperationOutcome | null {
  if (['SEND_ACCEPTED', 'ACK_SENT', 'ACK_DELIVERED', 'ACK_READ'].includes(evidence.kind)) {
    return { kind: 'SUCCESS' };
  }
  if (evidence.kind === 'SEND_INDETERMINATE') return { kind: 'AMBIGUOUS' };
  if (evidence.kind !== 'SEND_REJECTED' && evidence.kind !== 'ACK_FAILED') return null;
  if (evidence.errorClass === 'RATE_LIMITED') return { kind: 'RATE_LIMITED' };
  if (evidence.errorClass === 'SESSION_RESTRICTED') return { kind: 'SESSION_RESTRICTED' };
  if (evidence.errorClass === 'AMBIGUOUS') return { kind: 'AMBIGUOUS' };
  if (evidence.errorClass === 'TRANSIENT_FAILURE' || evidence.kind === 'ACK_FAILED') {
    return { kind: 'TRANSIENT_FAILURE' };
  }
  return { kind: 'SAFE_REJECTION' };
}

@Injectable()
export class MessageDeliveryEvidenceService {
  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly safety?: OpenWASafetyRepository,
  ) {}

  project(
    evidence: OpenWAConnectorEvidence,
  ): Promise<MessageStatusProjectionResult> {
    return this.database.transaction(client => this.projectInTransaction(client, evidence));
  }

  async projectInTransaction(
    client: PoolClient,
    evidence: OpenWAConnectorEvidence,
  ): Promise<MessageStatusProjectionResult> {
    const attemptResult = await client.query<AttemptProjectionRow>(
      `SELECT attempts.command_id::text, attempts.attempt_id::text,
         attempts.binding_generation::text, attempts.payload_sha256,
         attempts.transport_state, attempts.last_evidence_sequence::text,
         attempts.openwa_message_id AS attempt_message_id,
         jobs.id::text AS job_id, jobs.session_id, jobs.status,
         jobs.openwa_message_id AS job_message_id
       FROM message_attempts attempts
       JOIN message_jobs jobs ON jobs.id = attempts.message_job_id
       WHERE attempts.attempt_id = $1 AND attempts.command_id = $2
       FOR UPDATE OF attempts, jobs`,
      [evidence.attemptId, evidence.commandId],
    );
    const attempt = attemptResult.rows[0];
    if (!attempt) throw new ConnectorEvidenceConflictError('Connector evidence attempt is unknown');
    if (attempt.session_id !== evidence.sessionId) {
      throw new ConnectorEvidenceConflictError('Connector evidence session does not own the attempt');
    }
    if (!attempt.binding_generation
      || Number(attempt.binding_generation) !== evidence.bindingGeneration) {
      throw new ConnectorEvidenceConflictError('Connector evidence binding generation does not match the attempt');
    }
    if (!attempt.payload_sha256 || attempt.payload_sha256 !== evidence.payloadSha256) {
      throw new ConnectorEvidenceConflictError('Connector evidence payload digest does not match the command');
    }

    const recordHash = createHash('sha256').update(JSON.stringify(evidence)).digest();
    const duplicate = await client.query<{
      record_hash: Buffer;
      projection_state: 'APPLIED' | 'IGNORED';
    }>(
      `SELECT record_hash, projection_state FROM message_delivery_evidence WHERE event_id = $1`,
      [evidence.eventId],
    );
    if (duplicate.rows[0]) {
      if (!duplicate.rows[0].record_hash.equals(recordHash)) {
        throw new ConnectorEvidenceConflictError('Connector evidence event id has conflicting content');
      }
      return { state: duplicate.rows[0].projection_state, statusAdvanced: false, jobId: attempt.job_id };
    }

    const sequenceCollision = await client.query<{ event_id: string }>(
      `SELECT event_id::text FROM message_delivery_evidence
       WHERE attempt_id = $1 AND sequence = $2`,
      [evidence.attemptId, evidence.sequence],
    );
    if (sequenceCollision.rows[0]) {
      throw new ConnectorEvidenceConflictError('Connector evidence sequence has conflicting content');
    }

    const currentMessageId = attempt.job_message_id ?? attempt.attempt_message_id;
    if (currentMessageId && evidence.openwaMessageId
      && currentMessageId !== evidence.openwaMessageId) {
      throw new ConnectorEvidenceConflictError('Connector evidence OpenWA message identity changed');
    }

    const fresh = evidence.sequence > Number(attempt.last_evidence_sequence);
    const incomingTransport = transportStateFromEvidence(evidence.kind);
    const nextTransport = fresh
      ? nextTransportState(attempt.transport_state, incomingTransport)
      : attempt.transport_state ?? incomingTransport;
    const statusTransitions = fresh
      ? connectorJobStatusTransitions(attempt.status, evidence.kind)
      : [];
    let currentStatus = attempt.status;
    const projectedError = connectorEvidenceError(evidence);
    for (const status of statusTransitions) {
      await client.query(
        `UPDATE message_jobs SET status = $2::message_job_status,
           openwa_message_id = COALESCE($3, openwa_message_id),
           last_error = CASE WHEN $4::text IS NULL THEN last_error ELSE $4 END,
           updated_at = now()
         WHERE id = $1`,
        [attempt.job_id, status, evidence.openwaMessageId, projectedError],
      );
      currentStatus = status;
    }
    if (statusTransitions.length === 0 && evidence.openwaMessageId && !currentMessageId) {
      await client.query(
        `UPDATE message_jobs SET openwa_message_id = $2, updated_at = now() WHERE id = $1`,
        [attempt.job_id, evidence.openwaMessageId],
      );
    }

    const transportChanged = nextTransport !== attempt.transport_state;
    const messageIdentityBound = Boolean(evidence.openwaMessageId && !currentMessageId);
    const projectionState = fresh
      && (transportChanged || statusTransitions.length > 0 || messageIdentityBound)
      ? 'APPLIED'
      : 'IGNORED';
    if (fresh) {
      await client.query(
        `UPDATE message_attempts SET
           transport_state = $2::openwa_message_transport_state,
           last_evidence_sequence = $3,
           last_evidence_at = $4,
           transport_accepted_at = CASE
             WHEN $5::boolean AND transport_accepted_at IS NULL THEN $4
             ELSE transport_accepted_at
           END,
           openwa_message_id = COALESCE($6, openwa_message_id),
           outcome = $7
         WHERE attempt_id = $1`,
        [
          evidence.attemptId,
          nextTransport,
          evidence.sequence,
          new Date(evidence.occurredAt),
          ['SEND_ACCEPTED', 'ACK_SENT', 'ACK_DELIVERED', 'ACK_READ'].includes(evidence.kind),
          evidence.openwaMessageId,
          currentStatus,
        ],
      );
      const safetyOutcome = safetyOutcomeFromConnectorEvidence(evidence);
      if (safetyOutcome && this.safety) {
        await this.safety.recordMessageAttemptOutcomeWithClient(
          client,
          evidence.attemptId,
          safetyOutcome,
        );
      }
    }

    await client.query(
      `INSERT INTO message_delivery_evidence
         (event_id, command_id, attempt_id, sequence, kind, openwa_message_id,
          delivery_status, error_class, error_code, binding_generation, plugin_version,
          occurred_at, payload_sha256, record_hash, projection_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        evidence.eventId,
        evidence.commandId,
        evidence.attemptId,
        evidence.sequence,
        evidence.kind,
        evidence.openwaMessageId,
        evidence.deliveryStatus,
        evidence.errorClass,
        evidence.errorCode,
        evidence.bindingGeneration,
        evidence.pluginVersion,
        new Date(evidence.occurredAt),
        evidence.payloadSha256,
        recordHash,
        projectionState,
      ],
    );
    return {
      state: projectionState,
      statusAdvanced: statusTransitions.length > 0,
      jobId: attempt.job_id,
    };
  }
}

function connectorEvidenceError(evidence: OpenWAConnectorEvidence): string | null {
  if (!['SEND_REJECTED', 'SEND_INDETERMINATE', 'ACK_FAILED'].includes(evidence.kind)) return null;
  return [
    `Connector ${evidence.kind.toLowerCase().replaceAll('_', ' ')}`,
    evidence.errorClass,
    evidence.errorCode,
  ].filter(Boolean).join(': ').slice(0, 1024);
}
