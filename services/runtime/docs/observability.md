# Logs and health checks

## Runtime logs

API, scheduler and worker write newline-delimited JSON to stdout/stderr. The repository also ships a
private Prometheus scrape contract and reference alert rules for the server profile. It does not
embed a telemetry backend, paging destination or credentials, and the local-first desktop profile
keeps metrics disabled unless an operator explicitly provisions them.

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

## Prometheus metrics

Set a dedicated `RUNTIME_METRICS_TOKEN` to enable `GET /api/v1/metrics`. The route accepts
`Authorization: Bearer <token>`, is excluded from OpenAPI and returns 404 when disabled. It must stay
on a private network and must not reuse `RUNTIME_API_KEY`.

HTTP metrics label only a bounded method, the matched route template and response status. Unknown
routes collapse to `<unmatched>` so an attacker-controlled path, session/group ID, search term or
message value cannot create a series or enter the completion log. Dependency and current-instance
background heartbeat gauges refresh on every scrape; a failed probe is represented as zero while
the metrics response remains available for diagnosis.

Reference Prometheus configuration, alert rules, credential setup and rollout checks live in
[deploy/observability](../deploy/observability/README.md). The default rules cover scrape loss,
PostgreSQL/queue loss, stale worker/scheduler heartbeats, repeated snapshot failures, sustained HTTP
5xx ratio and aggregate p95 latency.

Event Inbox has an independent production metrics token and a private scrape configuration. Its
aggregate gauges cover hard event/byte capacity, pending/leased/dead events, oldest pending age,
device protocol migration, session ownership and active pairing rate limits. Public Caddy routing
does not expose detailed readiness or metrics.

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
GET /api/v1/health/live   (public liveness only)
GET /api/v1/health/ready  (X-Runtime-Key required)
```

Liveness proves that the API process can answer. Readiness requires PostgreSQL and Redis, then
reports worker and scheduler heartbeat state independently as `healthy` or `degraded`, together with
the live-send interlock, pinned OpenWA release and allowlisted-session count. A missing background
heartbeat does not remove the API from routing because PostgreSQL still owns durable intent. The
probe does not prove that OpenWA is currently paired. Because that response exposes deployment
state, probes and operator diagnostics must supply the Runtime credential; only liveness is public.

## Manual diagnosis

The repository ships scrape and rule configuration, but the deployment still owns Prometheus,
Alertmanager, log collection and paging destinations. Configure log-derived alerts for repeated tick
failure/timeout, webhook `DEAD`, delivery `UNKNOWN`, queue failures and growing backlog. Never
automatically retry an `UNKNOWN` live delivery; follow [Failure model](failure-model.md).
