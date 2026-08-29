# OpenWA Safety Governor runbook

Use this runbook for first activation, rate pressure, ambiguous message outcomes, session restriction,
or a safety scope that does not return to `READY`. It applies to the Runtime-owned governor in
[ADR 021](../adr/021-openwa-safety-governor.md). Do not change OpenWA source code or bypass Runtime by
calling message endpoints directly.

## Before release

1. Verify the reviewed OpenWA tag and contract with `npm run openwa:server:verify`.
2. Generate and review the Runtime contract with `npm run contract:generate`.
3. Before migration, verify that the query below returns no rows. Runtime intentionally refuses to
   guess which existing LIVE run should survive when a session has more than one active run.

   ```sql
   SELECT session_id, count(*) AS active_runs
   FROM campaign_runs
   WHERE execution_mode = 'LIVE'
     AND status::text IN ('PREPARING','BLOCKED','SCHEDULED','RUNNING','PAUSED','CANCELLING')
   GROUP BY session_id
   HAVING count(*) > 1;
   ```

4. Take a verified database backup. Run migrations once and stop the release if any migration fails.
5. Run `npm run check`, `npm run test:integration`, a debug desktop build, and the packaged managed-
   Runtime E2E required by the repository release process.
6. Confirm every production session is allowlisted and starts with the `CANARY` profile. Keep live
   sends disabled until the normal production-readiness gates are satisfied.

Never deploy from an uncommitted tree or reuse a development database, API key, webhook secret, or
session ID in production.

## Operator surface

WA Studio Settings shows the selected session's effective scope, state, profile, policy version,
cooldown, latest success, and latest failure. The authenticated Runtime endpoints are:

```text
GET  /api/v1/openwa-safety/sessions/:sessionId
POST /api/v1/openwa-safety/sessions/:sessionId/control
PUT  /api/v1/openwa-safety/sessions/:sessionId/profile
```

Mutations require a fresh UUID `Idempotency-Key`. Retrying the exact same intent may reuse that key;
never reuse it for a different action or profile.

Monitor these private metrics:

```text
wa_runtime_openwa_safety_scopes{circuit_state,rate_mode}
wa_runtime_openwa_safety_leases{lane}
wa_runtime_openwa_safety_deferred_message_jobs
wa_runtime_openwa_unknown_message_jobs
wa_runtime_metrics_snapshot_failures_total{dependency="openwa_safety"}
```

Correlate them with sanitized Activity events `openwa_safety.session_blocked`,
`openwa_safety.session_resumed`, and `openwa_safety.profile_changed`, plus Runtime logs. Do not copy
message text, phone numbers, group names, raw OpenWA responses, or credentials into incident records.

## First canary

1. Confirm the session is `READY`, profile `CANARY`, the expected policy version is visible, and no
   `RECOVERY` lease exists.
2. Complete one current group/capability sync and run campaign preflight.
3. Run a dry-run first. Then send one live campaign only to a dedicated consented test group.
4. Reconcile Message Job, Campaign Delivery, Campaign Run, Activity, and OpenWA evidence. Any
   duplicate, unexplained `UNKNOWN`, or mismatched terminal state is a no-go.
5. Keep the unchanged candidate and `CANARY` profile through the production observation window.

Promote to `STANDARD` only when there is no unexplained `429`, restriction, ambiguous result,
duplicate effect, growing deferred queue, or safety metric snapshot failure. Promotion is deliberate;
Runtime never promotes a session automatically.

## Incident procedures

### `THROTTLED` or `COOLDOWN`

- Stop launching new campaigns. Do not increase worker concurrency or edit bucket rows.
- Inspect the effective scope and `cooldownUntil`; a parent upstream intervention may affect several
  sessions even when the selected session row is closed.
- Let Runtime perform the bounded half-open probe. Do not repeatedly press Resume: Resume is for an
  explicit operator decision and resets session-local pacing state, not an upstream capacity fix.
- If `429` recurs, leave the profile at `CANARY`, preserve metrics/log timestamps, and investigate
  other clients using the same OpenWA deployment or WhatsApp session.

### `UNKNOWN` message outcome

- Immediately pause the Campaign Run or block the session if further sends could compound impact.
- Never clone, requeue, or manually retry the Message Job. The upstream effect may already exist.
- Reconcile later webhook/message-status evidence. Only the normal projection path may resolve
  `UNKNOWN` to a definitive sent/delivered/read/failed state.
- If no definitive evidence arrives, retain `UNKNOWN` and include it in the no-go record.

### `MANUAL_BLOCKED` or session restriction

- Treat a WhatsApp/OpenWA restriction as an incident, not a transient retry condition.
- Preserve the reason, last failure time, affected session, campaign/run identifiers, and aggregate
  counts. Do not resume until the external restriction and recipient/content policy are reviewed.
- Resume in WA Studio only after approval, then keep or return the profile to `CANARY` and use one
  dedicated test target before normal work.

### Stale lease or deferred queue growth

- An expired lease may be replaced automatically; a currently valid lease must not be deleted by an
  operator. Check process health and PostgreSQL time before assuming it is stale.
- A growing deferred count is expected during cooldown but must drain afterward. If it does not,
  inspect the effective scope, scheduled `notBefore` values, scheduler heartbeat, and database clock.
- Restarting workers does not bypass durable buckets or leases and is not a rate-pressure remedy.

## Rollback and recovery

Use the emergency block or Campaign pause before stopping Runtime. A block cannot recall an already
committed upstream request, so allow status reconciliation to preserve evidence. Take a backup before
changing the deployed binary.

Migrations are forward-only. Do not drop safety tables, delete receipts, reset theoretical-arrival
timestamps, or downgrade the database. Roll back to a migration-compatible binary only when it
understands the persisted policy version; otherwise fix forward. Preserve `UNKNOWN` outcomes and
Activity history through recovery.

The governor does not close the separate upstream terminal-webhook redrive limitation recorded in
the production-readiness document. If that gate remains unresolved, unattended production is still
a no-go even when every safety metric is healthy.
