# Logs and health checks

## Runtime logs

API, scheduler and worker write newline-delimited JSON to stdout/stderr. The deployment intentionally
has no telemetry collector, trace store, metrics database, dashboard or alert engine.

Each API response includes `X-Request-ID`; a caller's value is preserved only when it contains
1–100 letters, digits, dots, underscores or hyphens. Worker log context can include `bullJobId`,
`messageJobId`, `webhookIdempotencyKey`, `syncRunId`, `campaignRunId`, `sessionId` and `groupId`.
Use these identifiers to correlate work across processes.

Structured fields named like credentials, tokens, secrets, message text, bodies, payloads or phone
numbers are redacted. Application code must still avoid placing sensitive values directly in log
message strings.

Every completed HTTP request emits `http.request.completed`. Scheduler recovery actions, queue
publication failures, worker job failures and OpenWA request failures emit structured events without
message contents or credentials.

Scheduler ticks emit `scheduler.tick.completed`, `scheduler.tick.failed`,
`scheduler.tick.timed_out`, `scheduler.tick.overlap_skipped` and
`scheduler.tick.telemetry_failed`. Redis also retains the last known non-sensitive state under
`wa-runtime:scheduler-tick:<name>` with timestamps, duration and consecutive-failure count. The keys
are diagnostic state, not work ownership or retry authority.

Contact projection emits `contacts.projection.completed` with aggregate `updated`, `completed`,
`pending`, `failed` and `oldestLagSeconds` values. Contact snapshot completion includes aggregate
legacy and shadow coverage by identity/name/phone source. These events never contain an identity,
name or phone value. Alert when projection failures are non-zero or oldest lag remains above the
rollout threshold; inspect PostgreSQL-owned work rather than replaying OpenWA events manually.

Campaign lifecycle auditing emits `campaign.lifecycle.drift_detected` only when drift exists. Its
fields are aggregate counts: `draftWithLive`, `activeWithoutNonTerminalLive`,
`pausedWithoutPausedOrBlockedLive`, `archivedWithNonTerminalLive` and `multipleLive`. It contains no
campaign/run IDs or target data. Treat any `multipleLive` value above zero as a blocker for the
single-LIVE unique-index rollout rather than trying to reconcile it automatically.

Useful commands:

```bash
docker compose logs --since=15m api worker scheduler
docker compose logs -f api worker scheduler
docker compose exec -T redis redis-cli --scan --pattern 'wa-runtime:scheduler-tick:*'
docker compose exec -T redis redis-cli get wa-runtime:scheduler-tick:messages
```

Set `LOG_LEVEL` to `verbose`, `debug`, `log`, `warn`, `error` or `fatal`. Production defaults to
`log`; other environments default to `debug`.

## Desktop supervisor logs and diagnostics

The WA Studio native supervisor also emits newline-delimited JSON. Its canonical envelope contains
`timestampMs`, `level`, `service: "wa-studio"`,
`component: "managed-runtime-supervisor"`, `event`, and a non-sensitive `details` object. Runtime
lines that already identify `service: "wa-runtime"` pass through unchanged; unstructured child
output is suppressed and rate-limited to the first occurrence and every hundredth occurrence per
role/stream, represented only by aggregate count and byte length. Do not add database URLs, filesystem
paths, API keys, tokens, passphrases, message content, or raw child output to supervisor events.

Lifecycle events include `managed_runtime.phase_changed`, `managed_runtime.restart_scheduled`,
`managed_runtime.stale_termination_ignored`, `managed_runtime.process_error`, and initialization or
cleanup failures. Protection events include `managed_postgres.backup_created`,
`managed_postgres.backup_restored`, `managed_postgres.integrity_check_succeeded`,
`managed_postgres.data_quarantined`, and orphan-process recovery. Backup events expose only the
archive file name and safety class, never its absolute path.

Settings reads a separate native diagnostics snapshot. It exposes component identifiers, Runtime
phase/version, supervisor generation, managed-PostgreSQL running state, retained recovery-point
count, and timestamps/freshness for the newest recovery point and integrity check. It exposes no
transport credential, database URL, secret-store value, or local path. Recovery freshness is
`fresh` through 24 hours, then `due`; integrity freshness is `fresh` through seven days, then `due`;
absence is `missing`. Treat `degraded`, missing protection, or three restart schedules inside the
five-minute supervisor budget as an operator-visible incident. A due signal requires maintenance at
the next safe opportunity and must not silently broaden the restart budget.

## Health checks

```text
GET /api/v1/health/live
GET /api/v1/health/ready
```

Liveness proves that the API process can answer. Readiness requires PostgreSQL and Redis, then
reports worker and scheduler heartbeat state independently as `healthy` or `degraded`, together with
the live-send interlock, pinned OpenWA release and allowlisted-session count. A missing background
heartbeat does not remove the API from routing because PostgreSQL still owns durable intent. The
probe does not prove that OpenWA is currently paired.

## Manual diagnosis

The repository emits alertable events but does not ship a collector or paging engine. Configure the
deployment platform to alert on repeated tick failure/timeout, webhook `DEAD`, delivery `UNKNOWN`,
queue failures and growing backlog. Never automatically retry an `UNKNOWN` live delivery; follow
[Failure model](failure-model.md).
