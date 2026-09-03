import { Pool } from 'pg';

export const INTEGRATION_SESSION_ID = '00000000-0000-4000-8000-000000000001';
export const DISALLOWED_SESSION_ID = '00000000-0000-4000-8000-000000000002';
export const INTEGRATION_GROUP_ID = '120363000000000000@g.us';

export function integrationPool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
}

export async function dropIsolatedDatabase(pool: Pool, databaseName: string): Promise<void> {
  if (!/^[a-z0-9_]+$/u.test(databaseName)) {
    throw new Error(`Unsafe isolated database name: ${databaseName}`);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ connections: string }>(
      `SELECT count(*)::text AS connections
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    if (result.rows[0]?.connections === '0') {
      await pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for isolated database connections to close: ${databaseName}`);
}

export async function resetIntegrationDatabase(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE openwa_safety_leases, openwa_safety_buckets, openwa_safety_scopes,
       runtime_mutation_receipts, activity_events, runtime_queue_jobs,
       runtime_process_heartbeats, runtime_scheduler_tick_states,
       webhook_event_receipts, webhook_events, runtime_events, outbound_session_leases,
       message_dispatch_session_lanes, message_jobs,
       gateway_sync_items, sync_runs, gateway_sync_rate_limits, gateway_sync_fences,
       campaigns, gateway_sessions
     RESTART IDENTITY CASCADE`,
  );
  await pool.query(
    `UPDATE runtime_webhook_spool_usage
     SET stored_events = 0, stored_bytes = 0, updated_at = now()
     WHERE singleton = true`,
  );
}

export async function seedSendableGroup(pool: Pool, sessionId = INTEGRATION_SESSION_ID): Promise<void> {
  await pool.query(
    `INSERT INTO gateway_sessions
       (id, name, status, engine_loaded, restriction, gateway_created_at, gateway_updated_at)
     VALUES ($1, 'Integration session', 'ready', true, NULL, now(), now())`,
    [sessionId],
  );
  await pool.query(
    `INSERT INTO gateway_groups
       (session_id, id, name, is_admin, is_read_only, is_announce, details_synced_at,
        send_capability, send_capability_reason, capability_checked_at)
     VALUES ($1, $2, 'Integration group', true, false, false, now(), 'ALLOWED', 'SEND_ALLOWED', now())`,
    [sessionId, INTEGRATION_GROUP_ID],
  );
}
