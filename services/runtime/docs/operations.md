# Operations

## Production principles

- Pin both WA Runtime and OpenWA to reviewed release tags.
- Use `prod-session` only in production and allowlist only its UUID.
- Keep PostgreSQL and Redis on private networks; expose only the Runtime API through TLS.
- Give the Runtime a session-scoped OpenWA operator key with only required permissions.
- Start every new production deployment with `ALLOW_LIVE_SENDS=false`.
- Treat PostgreSQL as irreplaceable business state; Redis queues are recoverable transport.

Development and production must not share credentials, databases, Redis instances, webhook secrets,
session IDs or Docker volumes.

The target production topology is the desktop-managed model in
[ADR 015](adr/015-event-inbox-discovery-and-pairing.md). WA Studio owns Runtime business
execution and PostgreSQL on the trusted desktop. The public VPS retains the reviewed OpenWA release
plus the bounded Event Inbox described in [its deployment guide](../deploy/event-inbox/README.md). The server topology
below remains a development and controlled rollback profile; it is not the steady-state target.

Desktop-managed PostgreSQL uses the layered recovery policy in
[ADR 017](adr/017-desktop-disaster-recovery.md): verified rolling and manual device-encrypted
backups, maintenance safety points, passphrase-encrypted portable archives, and quarantine-first
recovery from degraded startup. Follow the
[desktop disaster-recovery runbook](runbooks/desktop-disaster-recovery.md) before device or storage
maintenance. Keep `WA_DESKTOP_BACKUP_ROOT` outside `WA_DESKTOP_POSTGRES_ROOT` in developer and E2E
overrides.

Component identity and release naming follow
[ADR 018](adr/018-studio-runtime-component-identity.md): WA Studio is the desktop/release product,
WA Runtime is its reusable engine and public service contract, and existing Tauri identity/data
paths remain stable. Settings exposes a secret-free protection snapshot; investigate `missing`
immediately and schedule maintenance when backup or integrity freshness becomes `due`.

Set `WA_RUNTIME_DB_PASSWORD` to an independently generated staging/production secret and use the
same URL-encoded credential in `DATABASE_URL`. The Compose defaults are development-only.

Database waits are fail-closed and bounded. The defaults allow 10 pooled connections, five seconds
to acquire/connect, 30 seconds per SQL statement/query, 10 seconds waiting for a lock, 30 seconds
idle inside a transaction, and one hour per pooled connection. Tune `DATABASE_POOL_MAX` and the
`DATABASE_*_TIMEOUT_*` settings only from observed query latency and PostgreSQL capacity; never use
zero to turn a production timeout back into an unbounded wait. Idle-client socket failures are
logged as `runtime.database.idle_client_error` and the pool retires that client.

## Container topology

Production needs these Runtime services:

The temporary replication limits below implement the rollout guard from
[ADR 001](adr/001-postgresql-owned-durable-work-execution.md).

| Service | Replication guidance |
| --- | --- |
| PostgreSQL | One primary with tested backups. |
| Redis | One persistent private instance using `noeviction`. |
| migrate | One-shot before application processes start. |
| API | One initially; scale only with shared rate/auth policy. |
| scheduler | Exactly one until ADR 001 database-owned retries and fencing pass staging. |
| worker | Exactly one until the implemented PostgreSQL leases pass staging multi-process tests. |

OpenWA is a separate Gateway deployment with its own PostgreSQL, Redis, storage and release
lifecycle. Do not merge the two databases or Redis instances merely because both products use the
same technologies.

## Release deployment

A production release should follow this order:

1. create and push an immutable Runtime release tag;
2. verify the OpenAPI diff and migration files in that tag;
3. take and verify a PostgreSQL backup;
4. pull/checkout the exact Runtime tag on the VPS;
5. build/pull the tagged image;
6. run the one-shot migration and stop if it fails;
7. start API, worker and scheduler with live sends still disabled;
8. verify liveness, readiness, Swagger policy and logs;
9. run a production-session sync and a small `DRY_RUN`;
10. enable live sends only through a separate approved configuration release.

Do not deploy from an uncommitted working tree or a floating branch such as `main`.

### Campaign-deletion rollout floor

Migration 040 adds nullable Campaign tombstones. Deploy a tombstone-aware Runtime to every API,
worker and scheduler process before WA Studio exposes Campaign Delete. Verify active reads and every
Campaign mutation ignore `deleted_at`, then synchronize the generated Runtime contract and enable the
client action. After the first deletion is accepted, do not roll back below this Runtime release: an
older binary ignores the tombstone and can expose or mutate a deleted Campaign. Database rollback is
not required; use a compatible forward fix or this release as the rollback floor.

### Single-LIVE rollout gate

The campaign single-LIVE database invariant is a two-release change. Release A deploys the repository
launch guard, aggregate scheduler audit and reconciliation commands, but deliberately does not add the
unique index. Run `npm run campaign:lifecycle:audit`; if it reports only unambiguous campaign-status
drift, quiesce launches and run `npm run campaign:lifecycle:reconcile`. The apply command takes
write-blocking locks on `campaigns` and `campaign_runs` for its short transaction so its duplicate audit
and repair use one protected state. Duplicate LIVE runs are an incident and are never auto-selected,
deleted or rewritten.

Observe Release A long enough to establish that `multipleLive` stays zero and lifecycle drift does not
recur. Only then may Release B add the reviewed partial unique index. After that migration succeeds,
do not roll back to a Runtime revision that does not handle the constraint; forward-fix the application
while retaining the database invariant.

## Health and observability

Public liveness and authenticated readiness:

```text
GET /api/v1/health/live   (public)
GET /api/v1/health/ready  (X-Runtime-Key required)
```

Readiness requires PostgreSQL and Redis. It reports fresh worker/scheduler heartbeats separately as
`healthy` or `degraded`, so a background-plane outage remains alertable without removing the API
from routing while durable intent can still be stored. It also reports the live-send interlock,
pinned OpenWA release and number of allowlisted sessions. It does not prove that OpenWA is currently
paired; session sendability is visible through the session API and campaign preflight. Do not expose
the Runtime key through a public load balancer or probe configuration; keep this endpoint on the
trusted Runtime network.

All processes emit correlated JSON logs. The server profile can additionally expose a dedicated-
token Prometheus endpoint with low-cardinality HTTP, dependency, heartbeat and process metrics.
Reference scrape and alert rules are shipped without collector credentials or paging destinations.
See [Observability](observability.md) and the
[metrics deployment runbook](../deploy/observability/README.md).

Useful container checks:

```bash
docker compose ps
docker compose logs --since=15m api worker scheduler migrate
docker compose exec -T postgres pg_isready -U wa_runtime -d wa_runtime
docker compose exec -T redis redis-cli ping
docker compose exec -T redis redis-cli --scan --pattern 'wa-runtime:scheduler-tick:*'
```

Regularly inspect repeated worker failures, runs stuck in `PREPARING`, unexpected `UNKNOWN`
deliveries, dead or increasingly old webhook events, expired processing leases, session
restrictions, capability refresh failures, database storage pressure and Redis `noeviction` write
failures.

The scheduler audits campaign/run lifecycle consistency every 60 seconds. A
`campaign.lifecycle.drift_detected` event contains aggregate category counts only. Any non-zero
`multipleLive` blocks the Release B unique-index migration and requires incident review; never add
campaign or run identifiers to this periodic event.

After [ADR 001](adr/001-postgresql-owned-durable-work-execution.md) is implemented, also alert on
lost-ownership transitions, exhausted durable retry budgets, sync epoch rejections, expired
outbound-session leases and scheduler lag. These events must not include message text, member search
values, phone numbers or secrets.

Page on repeated `scheduler.tick.failed` or any `scheduler.tick.timed_out`. A timed-out tick remains
non-overlapping until its underlying operation settles; do not restart a second scheduler as a
workaround. Compare its Redis `lastStartedAt`, `lastSuccessAt`, `lastFailureAt`, `nextRunAt` and
`consecutiveFailures` fields, then inspect PostgreSQL/Redis latency for that tick's dependency.

Treat `OpenWAResponseValidationError` as an integration compatibility incident. Its log message
contains only the operation and issue count; do not add raw response payloads while diagnosing it.
Repeated group-pagination validation failures require checking the pinned OpenWA release and its
pagination behavior before retrying full synchronization.

## Outbound pacing and retention

All OpenWA-bound work is additionally governed by the durable, cross-process safety boundary in
[ADR 021](adr/021-openwa-safety-governor.md). Follow the
[OpenWA Safety Governor runbook](runbooks/openwa-safety-governor.md) for canary activation, `429`,
cooldown, ambiguous outcomes, restrictions, manual block/resume, profile promotion, and rollback.
The governor supersedes process-local delay as the authoritative admission decision; the delay
settings below remain a lower-level scheduling jitter and lease constraint.

`OUTBOUND_MIN_DELAY_MS` and `OUTBOUND_MAX_DELAY_MS` apply inside a token-owned PostgreSQL
per-session lease. `MESSAGE_WORKER_CONCURRENCY`, `WEBHOOK_WORKER_CONCURRENCY`,
`GATEWAY_WORKER_CONCURRENCY` and `CAMPAIGN_WORKER_CONCURRENCY` set per-process BullMQ concurrency
within the validated range 1–100. For a 500-group campaign on one session, messages are intentionally
serialized; raising concurrency helps independent sessions and queues but does not increase that
session's send rate. Increase one step at a time from the defaults while observing PostgreSQL pool
pressure, queue age and OpenWA 429/5xx responses. Keep the outbound maximum delay at or below 60
seconds so the session and message processing leases remain bounded.

Campaign media V1 accepts one JPEG, PNG, or WebP image up to
`CAMPAIGN_MEDIA_IMAGE_MAX_BYTES` (8 MiB by default). Image bytes live in PostgreSQL, are included in
database backups, and must be covered by the same encryption-at-rest and restore controls as other
Runtime data. `CAMPAIGN_MEDIA_STORAGE_MAX_BYTES` is a workspace-wide database quota that counts
completed assets plus the declared size of active, unexpired uploads. Monitor database and backup
growth before increasing its 512 MiB default.

Incomplete uploads expire after `CAMPAIGN_MEDIA_UPLOAD_TTL_SECONDS`; completed/cancelled upload
records and unreferenced assets are removed after `CAMPAIGN_MEDIA_ORPHAN_RETENTION_HOURS` by the
regular retention tick. The live worker loads an image only immediately before the OpenWA call.
`CAMPAIGN_MEDIA_SEND_MEMORY_BUDGET_BYTES` uses a conservative 4x raw-byte weight to cover the
database buffer, base64 value, and serialized request; its 32 MiB default admits one maximum-size
image per Runtime process. OpenWA 409 and 429 responses are the only image-send failures retried
automatically, up to `MESSAGE_SAFE_RETRY_MAX_ATTEMPTS`. Timeouts, malformed success responses, and
5xx responses remain `UNKNOWN` after the request starts because retrying could duplicate a send.

Terminal operational rows are retained for `RUNTIME_RETENTION_DAYS` (90 days by default), the
sanitized Activity ledger for `RUNTIME_ACTIVITY_RETENTION_DAYS` (90 days), normalized events for
`RUNTIME_EVENT_RETENTION_DAYS` (30 days), inbox message bodies for
`RUNTIME_INBOX_RETENTION_DAYS` (equal to event retention when omitted; 7 days in the staging
template), and raw webhook envelopes for `RUNTIME_RAW_WEBHOOK_RETENTION_DAYS` (7 days). The event
retention is the effective webhook idempotency window. Backups remain governed by their own
retention policy.

Mutation receipts use the operational retention window and are deleted before the terminal object
they can replay. Historical group-reconciliation operation rows use the same cutoff: the current
revision is retained, active revisions are never candidates, and a terminal historical revision is
preserved while any non-expired capability-refresh receipt still references it. Retention logs expose
their deletion counts as `mutationReceipts` and `groupReconciliationOperations`.

The scheduler runs cleanup every `RUNTIME_RETENTION_INTERVAL_MS`. Each transaction deletes at most
`RUNTIME_RETENTION_BATCH_SIZE` rows per family, then the tick repeats until all families drain below
one batch, `RUNTIME_RETENTION_MAX_BATCHES_PER_RUN` is reached, or
`RUNTIME_RETENTION_TIME_BUDGET_MS` expires. Keep the time budget below the five-minute scheduler tick
timeout. Page on `capacityExhausted` in two consecutive completion logs: configured cleanup capacity
may not be keeping up with ingest. Monitor inserted/deleted rows and disk utilization; use 70/80/90
percent as warning/escalation/critical thresholds. The partitioning trigger and Contacts evidence
exception are defined in [ADR 012](adr/012-event-ownership-and-bounded-storage.md).

Do not apply storage migrations while disk utilization is at or above the 90% critical threshold.
Restore at least 30 days of projected headroom first, including WAL, backup and index-build working
space. Migration `041_runtime_storage_ownership.sql` builds the inbox retention index and must be
scheduled in a staging maintenance window; do not attempt to reclaim filesystem space with
`VACUUM FULL` or `REINDEX` on a nearly full volume. PostgreSQL may retain deleted space inside its
relations for reuse, so a flat filesystem graph after cleanup is not evidence that retention failed.

Migration `042_high_churn_autovacuum.sql` lowers only the vacuum/analyze scale factors for
`webhook_events`, `runtime_events` and `inbound_messages`. At roughly 2.5 million live rows, the
cluster-wide 20-percent vacuum default permits about 500,000 dead tuples before starting; compact
webhook updates and retention deletes make that burst unnecessarily large. The table-local
five-percent vacuum threshold starts near 135,000 rows while retaining PostgreSQL's global worker,
cost and timing controls. Roll it back with `ALTER TABLE ... RESET` for the four reviewed
autovacuum options only if staging shows sustained I/O pressure; never disable autovacuum.

Migration `044_contact_observation_autovacuum.sql` applies the same reviewed table-local settings to
`contact_observations` when its message-observation retention is enabled. Migration
`043_contact_retention_guard_indexes.sql` supplies the two small partial indexes used to exclude
active projection work and cluster-owned name evidence without scanning their full histories.

After deployment, verify that terminal `webhook_events.payload` values contain only the compact
receipt, `message.received` runtime events use `event_version = 2` without a `body` key, Contact
observation intent retries are draining, and the `inboundMessages` retention count eventually exceeds
the corresponding ingest rate once its cutoff becomes active.

For the required seven-day staging observation, install `scripts/runtime-storage-observation.sh` at
`/opt/wa-runtime/scripts/runtime-storage-observation.sh` with mode `0755`, and install the matching
service and timer from `deploy/systemd/` under `/etc/systemd/system/`. Run and enable them with:

```bash
sudo systemctl daemon-reload
sudo systemctl start wa-runtime-storage-observation.service
sudo systemctl enable --now wa-runtime-storage-observation.timer
sudo systemctl status wa-runtime-storage-observation.timer
```

The timer writes one aggregate, pipe-delimited sample per hour to
`/opt/wa-runtime/shared/runtime-storage-observations.tsv`, and copies the most recent aggregate
`data.retention.completed` event to `runtime-retention-observations.jsonl`. It reads PostgreSQL
statistics, relation sizes, Contact intent counts and root-filesystem usage; it never selects an
identity, message body or webhook payload. Compare counter deltas rather than absolute
`pg_stat_user_tables` counters, because PostgreSQL resets them after a statistics reset. Restarting
the timer does not truncate either file, and its file lock prevents overlapping samples.

After at least seven complete days, calculate daily database/filesystem growth and per-table insert,
delete and autovacuum deltas. Keep the current design only when retention has not reported two
consecutive `capacityExhausted` runs, delete capacity is keeping up after each cutoff, active Contact
intent age remains bounded, cleanup remains below 25 percent of its configured time budget, and the
expanded filesystem retains at least 30 days of projected headroom. Otherwise schedule the
partitioning migration defined by ADR 012; do not compensate by shortening the event idempotency
window or deleting Contact evidence indiscriminately.

Run the versioned evaluator against the two observer outputs instead of judging the gate from two
endpoint samples:

```bash
npm run storage:acceptance -- \
  --observations /opt/wa-runtime/shared/runtime-storage-observations.tsv \
  --retention-log /opt/wa-runtime/shared/runtime-retention-observations.jsonl \
  --minimum-days 7 \
  --target-disk-gib 150 \
  --retention-time-budget-ms 240000
```

On a host where the compiled evaluator has been installed under
`/opt/wa-runtime/tools/storage-acceptance/current`, run the equivalent root-readable wrapper with
`sudo /opt/wa-runtime/scripts/runtime-storage-acceptance.sh`. Extra CLI threshold arguments may be
appended to either form.

Install and enable `deploy/systemd/wa-runtime-storage-acceptance.{service,timer}` to evaluate the gate
daily. The monitor atomically replaces the root-only
`/opt/wa-runtime/shared/runtime-storage-acceptance.json`; exit 2 (`PENDING`) is an accepted oneshot
result, while a real `FAIL` leaves the report available and marks the service failed for alerting.

For the staging Tencent CVM, create and verify a provider snapshot, then expand the system disk to
150 GiB in the CVM console. Tencent documents this under
[Expanding Cloud Disks](https://intl.cloud.tencent.com/document/product/213/82048) and recommends a
snapshot before changing partitions or filesystems. Check guest readiness first; this command exits
2 without mutation until `/dev/vda` exposes the provider-side capacity:

```bash
sudo /opt/wa-runtime/scripts/runtime-root-filesystem-expand.sh --minimum-disk-gib 150
```

If it reports `READY`, apply the guarded online ext4 expansion with:

```bash
sudo /opt/wa-runtime/scripts/runtime-root-filesystem-expand.sh \
  --minimum-disk-gib 150 --apply --snapshot-verified
sudo systemctl start wa-runtime-storage-observation.service
sudo /opt/wa-runtime/scripts/runtime-storage-acceptance.sh
```

The expansion guard verifies that `/` is a read-write ext4 filesystem on the last direct partition
of its parent disk, refuses disks smaller than the target, and requires explicit snapshot
acknowledgement before invoking `growpart` and `resize2fs`. A successful observer sample detects the
new filesystem size and resets the seven-day acceptance window.

It exits zero only on `PASS`, one on `FAIL`, and two while the gate is `PENDING`. The evaluator
validates the exact TSV schema, requires at least 80-percent hourly coverage with no gap above three
hours, uses robust median-pair slopes for filesystem and database growth, and handles PostgreSQL
statistics resets when calculating counter deltas. Deletion catch-up permits ten percent for window
boundary skew but also requires an observed peak delete rate above the average ingest rate. The other
checks cover consecutive capacity exhaustion, p95 cleanup duration, Contact intent age, disk
escalation and sustained autovacuum backlog. Only the latest complete window is evaluated, and a
filesystem size change starts it again, so pre-expansion samples cannot satisfy the post-expansion
seven-day gate or make a recovered historical incident fail forever.

Enable `RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED` first on staging. After its event-version and inbox
checks pass, enable `RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED`; rollback disables either
flag without a schema downgrade or historical rewrite. Never enable raw compaction before every
deployed worker contains the fenced atomic processor and durable Contact intent consumer.

Contacts snapshot generations use `CONTACT_SNAPSHOT_RETENTION_DAYS`, preserving both the latest
publication and the generation owned by the latest completed resolution. Derived resolution rows
cascade with their generation. Redundant message push-name observations use
`CONTACT_MESSAGE_OBSERVATION_RETENTION_DAYS`; cleanup always preserves the newest observation per
session-scoped identity and pauses for any session with active resolution or projection work.
Pending projection work for a session outside `OPENWA_ALLOWED_SESSION_IDS` is intentionally retained:
removing it could leave stale projected names if that session is later re-allowlisted. Either
re-allow the session and drain the work, or remove the durable session explicitly so foreign-key
cascades delete its Contacts state; do not purge those rows as generic queue debris.

## Backup and restore

Store backup scripts and archives outside the OpenWA project. A suitable separation is:

```text
/opt/wa-runtime/              deployment
/opt/wa-runtime/scripts/      Runtime maintenance scripts
/var/backups/wa-runtime/      backup archives
```

Installations use the `wa_runtime` PostgreSQL database and role together with the
`wa-runtime_postgres-data` and `wa-runtime_redis-data` volumes. A previously named installation must
take a logical PostgreSQL backup, record row-count baselines, stop the old project, and follow the
reviewed [storage namespace migration runbook](runbooks/storage-namespace-migration.md). The active
Compose configuration has no legacy-volume override.

Use `wa-runtime-postgres` and `wa-runtime-redis` in container connection URLs. Runtime processes also
join the OpenWA gateway network, where generic `postgres` and `redis` DNS names may resolve to the
gateway's dependencies instead of WA Runtime storage.

The minimum Runtime backup is a PostgreSQL logical dump plus the exact application release tag and
environment inventory. Never put secrets into the backup filename or command output.

Example logical backup:

```bash
umask 077
docker compose exec -T postgres \
  pg_dump -U wa_runtime -d wa_runtime -Fc \
  > /var/backups/wa-runtime/runtime-$(date -u +%Y%m%dT%H%M%SZ).dump
```

For an installation still on older database identifiers, substitute its current database and role
in the source backup command. PostgreSQL database/role creation runs only when the data directory is
empty, so existing storage requires the explicit migration procedure.

Test restoration periodically into an isolated database. A restore replaces or merges durable
business data and must be performed during a declared maintenance window with API, scheduler and
worker stopped. Document and rehearse the exact restore command for the chosen PostgreSQL hosting
model before production launch.

Redis AOF is useful for short outages but is not a substitute for PostgreSQL backup. After Redis
loss, start Redis, then scheduler and worker; durable pending rows will be enqueued again.
Webhook retries, pending syncs, campaign preparation and scheduled message jobs are rediscovered
from PostgreSQL. A live message left in `PROCESSING` past its lease becomes `UNKNOWN` and is never
resent automatically.

## Restart and recovery

A normal restart is safe:

```bash
docker compose restart api worker scheduler
```

After restart:

1. confirm readiness;
2. confirm scheduler and worker are running;
3. inspect non-terminal campaign runs;
4. verify `PREPARING` runs advance and stale queued jobs recover;
5. do not manually duplicate a run to make it move.

Before ADR 001 is fully implemented, do not start a second scheduler or worker as a recovery
shortcut. Restart the single process and let PostgreSQL-backed discovery republish the durable rows.

### Graceful shutdown and cleanup failures

API, worker, scheduler, Event Inbox and managed Desktop processes own their shutdown sequence. A
normal signal stops queue intake and runner loops before closing the Nest application context and
database pool. Event Inbox also cancels its maintenance timer and waits for any active, single-flight
expiry cleanup before repository pools close. Independent workers and queue resources are all given
a chance to close; one cleanup failure does not skip the remaining cleanup tasks.

If the process operation and cleanup both fail, Runtime preserves both errors in its terminal log
instead of replacing the original failure with the cleanup failure. A failed transaction rollback
is logged as `runtime.database.transaction_rollback_failed`, and that PostgreSQL client is evicted
from the pool. Treat either event as an abnormal shutdown: confirm the process exited, inspect any
leased work through the normal recovery flow above, and restart the single owning process only.

## OpenWA webhook registration gate

Runtime validates and processes OpenWA webhooks. When
`OPENWA_WEBHOOK_RECONCILIATION_ENABLED=true`, the single scheduler also owns one registration at the
exact `OPENWA_WEBHOOK_CALLBACK_URL` for every allowlisted session. It refreshes the signing secret
and reviewed event set, repairs missing state and removes only duplicate registrations for that same
URL. Callbacks at other URLs remain outside Runtime ownership. Keep reconciliation disabled until
the externally reachable HTTPS callback is reviewed.

After creating, restoring, re-pairing or replacing an OpenWA session, verify that exactly one active
callback targets the Runtime HTTPS webhook endpoint and subscribes to the reviewed message, session
and group event set. An empty registration list means inbound activity cannot reach Runtime even
when both services are healthy. Repeated `webhook-registration` scheduler failures indicate a bad
URL, missing OpenWA permission or upstream control-plane failure; they do not make API readiness
fail.

Use the same `OPENWA_WEBHOOK_SECRET` on both sides. Do not print the callback secret, callback URL,
session identifier or webhook payload while checking registration. OpenWA's destination policy may
reject Docker-internal callback names; staging and production use the TLS Runtime endpoint. After
registration, send a controlled inbound message and require a processed webhook with no retry/dead
transition before enabling event-driven contact enrichment.

Do not enable a second scheduler replica as a reconciliation workaround. The initial implementation
uses the deployment's single-scheduler invariant; multi-scheduler ownership requires a separately
reviewed distributed lease.

Pause a run before planned intervention when possible. Cancel stops only pending/queued work; it
cannot recall a message already processing or accepted by OpenWA.

## Live-send enablement

Live sending requires all of the following:

- reviewed and paired production session;
- production UUID as the only allowlisted session;
- valid current group capability;
- preflight without blocking checks;
- LIVE confirmation within the signed preflight proof lifetime;
- tested webhook acknowledgements and delivery reconciliation;
- acceptable outbound delay configuration;
- explicit `ALLOW_LIVE_SENDS=true` deployment approval;
- a tested kill switch that can restore the value to `false` and restart worker/scheduler.

Begin with a campaign containing a very small controlled set of groups. Never use the 500-group
session as the first live validation.

## Session restrictions and group permission changes

`session.restriction` webhooks are persisted in the PostgreSQL session projection. Preflight and
live-send policy read that durable state directly. A live run encountering an unsendable session
pauses new materialization with
`SESSION_NOT_SENDABLE`. Resolve the OpenWA/session condition, refresh state, then resume so preflight
runs again.

Group metadata events invalidate only the affected group. A send returning HTTP 403 marks capability
unknown with `GATEWAY_PERMISSION_DENIED`; HTTP 404 uses `GROUP_CHANGED`. Let targeted refresh resolve
the group before resuming live work.

## OpenWA upgrade

The OpenWA server selected by the operator is the source of truth for the observed release. The
workspace never uses the latest GitHub tag to decide compatibility. `release/components.json` pins
the last reviewed server tag and the SHA-256 of its exact Swagger snapshot under
`contracts/openwa/<tag>/openapi.json`.

Load the server origin and API key into the current secure operator shell, then compare that server
with the reviewed pin:

```bash
export OPENWA_BASE_URL=https://openwa.example.com
export OPENWA_API_KEY=<operator-key>
npm run openwa:server:status
```

`status` calls `/api/health` on that origin. It reports `current`, `upgrade_available`, or
`server_behind` and never prints the API key. An upgrade is available only when this live server
reports a newer stable tag than `release/components.json`.

After deliberately upgrading a non-production server, import the contract exposed by that same
server:

```bash
npm run openwa:server:sync
```

The sync command probes `/api/health` first, then downloads `/api/docs-json` from the same origin. It
stages the immutable snapshot without changing the reviewed Runtime/Studio pin. If Swagger is
disabled on the server, export its exact OpenAPI document and keep live tag discovery anchored to
the server:

```bash
npm run openwa:server:sync -- --contract /secure/path/openapi.json
```

Sync refuses a downgrade, a version mismatch between health and OpenAPI, an unencrypted remote
origin, redirects, oversized responses, and replacement of a different snapshot already stored
under the same tag. The running compatibility pin remains unchanged until a developer has:

1. diffed the old and new sessions, groups, send, health, and webhook schemas;
2. adapted Runtime only where the server contract changed;
3. updated `REVIEWED_OPENWA_RELEASE` in the contract-upgrade test after that review;
4. run the adapter and unit checks against the staged snapshot;
5. promoted the reviewed tag while the same server still reports it:

```bash
npm run openwa:server:promote
```

Promotion re-probes `/api/health`, requires the matching staged snapshot and review marker, then
recoverably advances the component pin, snapshot digest, and generated Runtime constants. After
promotion, run `npm run check`, Runtime integration tests, and packaged managed-Runtime E2E, then
update `EVENT_INBOX_OPENWA_RELEASE_TAG` during the coordinated deployment.

Run `npm run openwa:server:verify` in every release checkout. This offline gate verifies the pin,
snapshot hash, generated constants, and adapter-review marker without contacting production.

If the live Gateway reports another version, Runtime group synchronization and desktop startup fail
closed. Do not bypass the check during an upgrade.

## Outbound HTTP boundaries

Runtime accepts `OPENWA_BASE_URL` only as an origin without credentials, path, query or fragment,
never follows redirects, and sends the operator key only to URLs constructed under that origin.
`OPENWA_REQUEST_TIMEOUT_MS` bounds one attempt while `OPENWA_REQUEST_DEADLINE_MS` bounds the entire
retry sequence, including rate-limit backoff. Keep the deadline greater than or equal to the attempt
timeout. Shutdown aborts both active requests and backoff immediately.

Successful OpenWA bodies are capped by `OPENWA_RESPONSE_MAX_BYTES`; error bodies use a fixed 64 KiB
cap. The Event Inbox credential probe has independent timeout and response limits. Runtime claim
responses use `EVENT_INBOX_REQUEST_TIMEOUT_MS` and `EVENT_INBOX_RESPONSE_MAX_BYTES`; the timeout must
remain above the protocol's 20-second long poll. The default 40 MiB response cap covers 100 events
at the default 256 KiB raw-payload limit after base64 expansion. If the Event Inbox payload limit is
raised, either reduce `EVENT_INBOX_BATCH_SIZE` or raise the response cap from measured staging data.
Malformed or oversized upstream bodies fail before schema validation and are never included in logs.

## Inbound HTTP boundaries

API and desktop-managed Runtime disable Nest's implicit parser and register one explicit strict JSON
parser capped by `RUNTIME_HTTP_BODY_MAX_BYTES` (1 MiB by default). Event Inbox uses its own
`EVENT_INBOX_MAX_PAYLOAD_BYTES` cap, so signed webhooks between 100 KiB and the configured limit are
accepted instead of being rejected by Nest's hidden default. Bodies above either limit return HTTP
413 before controller code runs.

All HTTP entrypoints remove `X-Powered-By`, emit no-store, nosniff, frame-denial, no-referrer,
same-origin resource and disabled camera/microphone/geolocation headers, and explicitly bound header
and full-request receive time. Keep the header timeout at or below the request timeout. CORS remains
disabled; do not enable a browser origin without a separate threat review because the Runtime key is
an operator credential, not a browser session token.

## Group reconciliation

`POST /api/v1/sessions/{id}/sync` accepts an optional mode. Omission remains `FULL` for API v1
compatibility; operator clients should send `INCREMENTAL` for routine synchronization and reserve
`FULL` for bootstrap or deliberate reconciliation of every active group.

Discovery publishes group summaries first. The run then remains `RUNNING` in phase `RECONCILING`
while PostgreSQL-owned `gateway_sync_items` update `groupsSynced`, `groupsFailed`, `groupsSkipped`
and `membersSynced`. `membersSynced` means members observed in successfully reconciled snapshots,
not rows changed. A duplicate request with the same mode returns the active run; a different mode
returns HTTP 409 rather than silently changing operator intent.

Group-detail calls share a session-scoped pacing lease with targeted capability refreshes. Initial
defaults are 40 calls per minute, five durable attempts and a 24-hour incremental freshness window.
Tune `GATEWAY_SYNC_GROUPS_PER_MINUTE` only from staging evidence. A sustained OpenWA 5xx sequence can
represent an underlying WhatsApp `rate-overlimit`; increasing worker concurrency or adapter retries
amplifies it.

An established session also guards destructive discovery changes. With the default configuration,
a snapshot below 25 percent of a baseline of at least 20 groups must be observed identically twice
before Runtime marks missing groups inactive. The first observation leaves the read model unchanged
and retries discovery durably. Only 429, upstream 5xx and network failures extend the shared session
cooldown; validation and persistence errors retain independent item retry semantics.

OpenWA group events now create one durable targeted intent per `(session, group)`. The default
three-second debounce coalesces bursts and a ten-second maximum wait prevents continuous activity
from postponing reconciliation indefinitely. PostgreSQL `NOTIFY` wakes the gateway dispatcher, but
the notification contains no identity and is not durable work; the configurable ten-second scan is
the recovery fallback. A listener reconnect performs an immediate catch-up scan.

Adaptive pacing is disabled by default. When `GATEWAY_SYNC_ADAPTIVE_PACING=true`, an explicit 429
halves the persisted effective per-session rate down to
`GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE`; every configured successful-read streak restores one request
per minute up to `GATEWAY_SYNC_GROUPS_PER_MINUTE`. Disable the flag to immediately use the fixed
configured maximum without deleting pacing state.

Useful database inspection queries:

```sql
SELECT id, sync_type, status, phase, groups_discovered, groups_scheduled,
       groups_synced, groups_failed, groups_skipped, members_synced, error
FROM sync_runs ORDER BY requested_at DESC LIMIT 10;

SELECT status, count(*) FROM gateway_sync_items
WHERE sync_run_id = '<run-id>' GROUP BY status ORDER BY status;

SELECT session_id, next_request_at, consecutive_failures, cooldown_until,
       effective_requests_per_minute, success_streak, last_rate_pressure_at,
       active_lease_expires_at
FROM gateway_sync_rate_limits;

SELECT status, count(*), sum(coalesced_count) AS coalesced_events,
       min(now() - first_requested_at) AS oldest_age
FROM gateway_group_reconciliation_intents GROUP BY status ORDER BY status;
```

After a worker crash, the scheduler returns expired items to `RETRY` and clears expired pacing
leases. Do not manually change item status while a valid item or pacing lease exists. A terminal
failed item makes the parent run `FAILED` without discarding successful sibling results; a group
that disappears during reconciliation is `SKIPPED` and does not fail the parent.

## Observed contact synchronization

[ADR 005](adr/005-session-scoped-observed-contacts.md) adds a session-scoped contact identity read
model. Group reconciliation always seeds member identities. OpenWA contact snapshots remain disabled
by default and can be enabled with `CONTACT_SNAPSHOT_SYNC_ENABLED=true` after migrations 018–020 are
applied.

Migration 023 adds a feature-gated, generation-scoped staging area. Enable
`CONTACT_SNAPSHOT_STAGING_ENABLED=true` only after migration 023 is applied. Pages remain in
`RECEIVING` state while OpenWA streams them; only a lease-owning completion can atomically mark the
generation `PUBLISHED`. Failed or contradictory generations remain non-authoritative and retain only
normalized observations for diagnosis. Enable staging before any v2 resolver or projection shadow
flag; disabling it rolls back this producer without changing the legacy contact read model. Terminal
generations older than `CONTACT_SNAPSHOT_RETENTION_DAYS` are removed when the next generation starts,
while the newest published generation is always retained. A superseded `RECEIVING` generation is
marked `FAILED` with the bounded `LEASE_EXPIRED` code.

Migration 024 adds immutable exact-identity, name-observation and identity-link evidence. Keep
`CONTACT_EVIDENCE_DUAL_WRITE_ENABLED=false` until migration 024 is applied and snapshot staging is
enabled. With the flag on, group, inbound-message and published-snapshot producers dual-write evidence
in their existing PostgreSQL transaction; legacy Contacts and `group_members` remain authoritative.
Snapshot evidence is committed only with a `PUBLISHED` generation. Disable the flag to stop new
evidence without changing current API reads or deleting collected evidence.

Migration 025 adds immutable, versioned resolver outputs. Enable
`CONTACT_RESOLUTION_SHADOW_ENABLED=true` only while evidence dual-write is enabled. The scheduler
claims at most `CONTACT_RESOLUTION_MAX_RUNS_PER_TICK` published generations per minute with a fenced
five-minute lease. A run uses the publication timestamp as an evidence cutoff, quarantines ambiguous
LID-to-phone edges, and writes clusters/assignments without touching legacy Contacts or member rows.
Logs contain aggregate identity/cluster/conflict counts only. Disable the shadow flag to stop new runs;
completed results remain available for comparison and rollback analysis.

Migration 026 adds the durable shadow projection queue and additive `group_members` shadow columns.
Enable `CONTACT_PROJECTION_SHADOW_ENABLED=true` only after snapshot staging, evidence dual-write and
shadow resolution are enabled. Dirty work is coalesced by the latest resolved cluster (or exact
identity before resolution), claimed with a fenced five-minute lease and applied in bounded keyset
batches. A monotonic projection revision prevents delayed alias work from overwriting newer output.
The scheduler runs every five seconds and processes at most
`CONTACT_PROJECTION_MAX_JOBS_PER_TICK * CONTACT_PROJECTION_MAX_BATCHES_PER_JOB` batches; tune the batch
size with `CONTACT_PROJECTION_BATCH_SIZE`. Disabling the flag stops producers and workers while the
legacy member API remains authoritative. Logs expose only aggregate updated/completed counts.

Migration 027 adds a durable keyset bootstrap for member identities that existed before the projection
queue. Cutover uses two independent flags: `CONTACT_PROJECTION_READ_ENABLED` selects completed shadow
rows in member data/search/order/count, while `CONTACT_LEGACY_MEMBER_FANOUT_ENABLED=false` removes
synchronous membership fan-out from contact and message producers. With fan-out disabled, the
projection worker mirrors v2 output into legacy columns asynchronously so reverting the read flag does
not expose a stale fallback.

Migration 028 adds the prerequisite bounded evidence backfill for memberships created before evidence
dual-write. Enable `CONTACT_EVIDENCE_BACKFILL_ENABLED=true` with dual-write and shadow projection. The
scheduler processes at most `CONTACT_EVIDENCE_BACKFILL_BATCH_SIZE` member rows per tick, records a
durable keyset cursor and enqueues affected exact identities. It derives phones only from phone JIDs;
LID user-parts remain unresolved. Do not assume an unchanged full group sync will recreate evidence,
because member fingerprints intentionally skip unchanged membership writes.

Migration 030 indexes the remaining missing-evidence set. While shadow projection is enabled, an
allowlist-scoped late-evidence catch-up processes at most
`CONTACT_PROJECTION_BOOTSTRAP_BATCH_SIZE` rows for one session per tick. It uses the same per-session
member-write lock as group replacement and projection, then enqueues the repaired exact identities.
This closes rows created or retained after the one-shot migration-028 cursor passed them without
re-enabling the historical backfill flag.

Migration 031 indexes projected memberships whose additive identity type was not materialized by an
older backfill. The normal unprojected catch-up requeues those exact identities and the projection
worker repairs the type from the session-scoped evidence identity. Read cutover requires this set to
be empty as well as the revision-zero set.

Use this order for a staged cutover:

1. Enable snapshot staging, evidence dual-write, shadow resolution and shadow projection; leave reads
   on legacy and legacy fan-out enabled.
2. Wait for `contact_evidence_backfill_state.status = 'COMPLETED'`, then complete a new contact
   snapshot/resolution generation. Wait for `contact_projection_bootstrap_state.status = 'COMPLETED'`,
   no projection work in
   `PENDING`, `RUNNING`, `RETRY` or `FAILED`, and zero member rows with a non-null
   `evidence_identity_id` but `shadow_projection_revision = 0`. Also require zero eligible member
   rows with a null `evidence_identity_id`; the late-evidence catch-up must finish before read cutover.
   Every evidence-linked row must also have a non-null materialized `identity_type`.
3. Compare aggregate null/name/source/phone coverage and mismatch counts; do not emit values.
4. Enable `CONTACT_PROJECTION_READ_ENABLED=true` while retaining legacy fan-out for the canary window.
5. After API/search/order checks pass, set `CONTACT_LEGACY_MEMBER_FANOUT_ENABLED=false`. Confirm queue
   lag stays within the acceptance threshold and inbound webhook completion does not depend on member
   updates.

Rollback the reader by setting `CONTACT_PROJECTION_READ_ENABLED=false` while leaving shadow projection
enabled and legacy fan-out disabled; the worker continues mirroring current v2 results into the legacy
columns. Drain projection work before optionally re-enabling synchronous legacy fan-out. Never disable
the shadow worker while legacy fan-out is disabled.

Identity evidence from an inbound message's bounded `contact.pushName` field is independently gated by
`CONTACT_MESSAGE_ENRICHMENT_ENABLED`. Runtime extracts only sender identity and push name, then discards
the upstream contact object; a contact write failure never retries or dead-letters the message webhook.
This producer does not infer a phone from a LID and does not merge identities.

Periodic contact-only refresh is independently gated by `CONTACT_PERIODIC_SYNC_ENABLED`. The scheduler
checks due, ready, allowlisted sessions every five minutes and refreshes at most ten per tick. A successful
refresh sets the next due time using `CONTACT_PERIODIC_SYNC_INTERVAL_MS` (24 hours by default); failures
use bounded exponential backoff. PostgreSQL generation/lease fencing prevents a periodic refresh and a
full-sync-triggered refresh from owning the same session concurrently. This job never lists groups or
members from OpenWA.

Migration 021 adds the internal member identity projection without changing the member API contract.
New group writes populate `identity_type` and nullable `resolved_phone_number` transactionally. Existing
rows are processed by the fenced, resumable backfill only when
`CONTACT_MEMBER_IDENTITY_BACKFILL_ENABLED=true`. Each scheduler pass handles at most
`CONTACT_MEMBER_IDENTITY_BACKFILL_BATCH_SIZE * CONTACT_MEMBER_IDENTITY_BACKFILL_MAX_BATCHES` rows and
records only aggregate progress. Enable it after migration 021, require zero null identity types, then
disable it after an observation window. A LID user-part is never written to `resolved_phone_number`.

Snapshot completion logs only aggregate counters: observed/enriched/merged/conflicts and member coverage
by identity type and name source. Do not add session IDs, raw names, phone numbers or WhatsApp identifiers
to these events. Before enabling either legacy producer, apply migrations 018–020. Disable its flag to roll back
new writes while retaining already observed data.

A full sync then streams OpenWA contacts in pages of at most 1,000 and materializes observed names
without making contact availability a group-sync dependency. Incremental sync, targeted group
reconciliation and capability refresh never request the contact collection. Snapshot absence is not
deletion evidence; do not truncate contact tables to reconcile the bounded Baileys cache.

These aggregate checks contain no contact PII:

```sql
SELECT count(*) AS members,
       count(contact_id) AS linked_members,
       count(display_name) AS named_members
FROM group_members WHERE session_id = $1;

SELECT identity_type, count(*)
FROM contact_identifiers WHERE session_id = $1
GROUP BY identity_type ORDER BY identity_type;

SELECT sync_generation, snapshot_completeness, last_started_at, last_completed_at,
       last_successful_record_count, last_error_code
FROM contact_sync_state WHERE session_id = $1;
```

Disable the flag to stop new snapshots while preserving already observed contacts and materialized
member names. Never log result rows from contacts, identifiers or names during incident handling.

## Rollback

Application rollback means returning to a previous immutable Runtime tag. Database rollback is not
automatically safe: migrations are forward-only and an older binary may not understand new schema
or enum values. Before every release, classify migrations as backward-compatible or require a
restore/forward-fix plan.

Migrations implementing ADR 001 and ADR 003 are additive but change execution semantics. ADR 003's
one-active-sync index can reject duplicate sync inserts from an older binary, so quiesce sync
requests during rollback and prefer a forward fix. Deploy with live sends disabled, verify
stale-attempt fencing and retry exhaustion in staging, then load test the PostgreSQL leases before
enabling multiple workers or live sends.

Prefer a forward corrective release for additive migrations. Restore a database backup only after
explicitly accepting that post-backup campaign and delivery state will be lost.
