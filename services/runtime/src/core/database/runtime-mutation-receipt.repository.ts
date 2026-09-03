import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

export const RUNTIME_MUTATION_TYPES = [
  'SESSION_SYNC',
  'GROUP_CAPABILITY_REFRESH',
  'CAMPAIGN_RUN_PAUSE',
  'CAMPAIGN_RUN_RESUME',
  'CAMPAIGN_RUN_CANCEL',
  'OPENWA_WORKSPACE_BLOCK',
  'OPENWA_WORKSPACE_RESUME',
  'OPENWA_SESSION_BLOCK',
  'OPENWA_SESSION_RESUME',
  'OPENWA_SAFETY_PROFILE_CHANGE',
  'OPENWA_OUTBOUND_PAUSE',
  'OPENWA_OUTBOUND_RESUME',
] as const;

export type RuntimeMutationType = (typeof RUNTIME_MUTATION_TYPES)[number];
export type RuntimeMutationOutcome = 'SUCCEEDED' | 'REJECTED';

interface RuntimeMutationQueryExecutor {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export interface RuntimeMutationReceipt {
  operationType: RuntimeMutationType;
  idempotencyKey: string;
  requestHash: string;
  sessionId: string;
  subjectId: string;
  resultId: string;
  resultRevision: number | null;
  acceptedAt: Date;
  outcome: RuntimeMutationOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
}

interface RuntimeMutationReceiptRow {
  operation_type: RuntimeMutationType;
  idempotency_key: string;
  request_hash: string;
  session_id: string;
  subject_id: string;
  result_id: string;
  result_revision: string | null;
  accepted_at: Date;
  outcome: RuntimeMutationOutcome;
  error_code: string | null;
  error_message: string | null;
  error_details: Record<string, unknown> | null;
}

const mapReceipt = (row: RuntimeMutationReceiptRow): RuntimeMutationReceipt => ({
  operationType: row.operation_type,
  idempotencyKey: row.idempotency_key,
  requestHash: row.request_hash,
  sessionId: row.session_id,
  subjectId: row.subject_id,
  resultId: row.result_id,
  resultRevision: row.result_revision === null ? null : Number(row.result_revision),
  acceptedAt: row.accepted_at,
  outcome: row.outcome,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  errorDetails: row.error_details,
});

/**
 * An immutable receipt for a committed mutation. Callers must use this repository from the same
 * database transaction that owns the domain mutation; it deliberately cannot open a transaction.
 */
export class RuntimeMutationReceiptRepository {
  async lockAndFind(
    client: PoolClient,
    operationType: RuntimeMutationType,
    idempotencyKey: string,
  ): Promise<RuntimeMutationReceipt | null> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`runtime-mutation:${operationType}:${idempotencyKey}`],
    );
    return this.find(client, operationType, idempotencyKey);
  }

  async find(
    executor: RuntimeMutationQueryExecutor,
    operationType: RuntimeMutationType,
    idempotencyKey: string,
  ): Promise<RuntimeMutationReceipt | null> {
    const result = await executor.query<RuntimeMutationReceiptRow>(
      `SELECT * FROM runtime_mutation_receipts
       WHERE operation_type = $1 AND idempotency_key = $2`,
      [operationType, idempotencyKey],
    );
    return result.rows[0] ? mapReceipt(result.rows[0]) : null;
  }

  async record(
    client: PoolClient,
    input: Omit<RuntimeMutationReceipt,
      'acceptedAt' | 'operationType' | 'outcome' | 'errorCode' | 'errorMessage' | 'errorDetails'> & {
      operationType: RuntimeMutationType;
      outcome?: RuntimeMutationOutcome;
      errorCode?: string;
      errorMessage?: string;
      errorDetails?: Record<string, unknown>;
    },
  ): Promise<RuntimeMutationReceipt> {
    const result = await client.query<RuntimeMutationReceiptRow>(
      `INSERT INTO runtime_mutation_receipts
         (operation_type, idempotency_key, request_hash, session_id, subject_id,
          result_id, result_revision, outcome, error_code, error_message, error_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING *`,
      [
        input.operationType,
        input.idempotencyKey,
        input.requestHash,
        input.sessionId,
        input.subjectId,
        input.resultId,
        input.resultRevision,
        input.outcome ?? 'SUCCEEDED',
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.errorDetails ? JSON.stringify(input.errorDetails) : null,
      ],
    );
    return mapReceipt(result.rows[0]!);
  }

  async findFirstForResult(
    client: PoolClient,
    input: {
      operationType: RuntimeMutationType;
      sessionId: string;
      subjectId: string;
      resultRevision: number;
    },
  ): Promise<RuntimeMutationReceipt | null> {
    const result = await client.query<RuntimeMutationReceiptRow>(
      `SELECT * FROM runtime_mutation_receipts
       WHERE operation_type = $1 AND session_id = $2 AND subject_id = $3
         AND result_revision = $4
       ORDER BY accepted_at, idempotency_key
       LIMIT 1`,
      [input.operationType, input.sessionId, input.subjectId, input.resultRevision],
    );
    return result.rows[0] ? mapReceipt(result.rows[0]) : null;
  }
}
