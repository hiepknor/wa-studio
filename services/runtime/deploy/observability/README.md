# WA Runtime metrics deployment

The server profile exposes a private Prometheus endpoint at `/api/v1/metrics` only when
`RUNTIME_METRICS_TOKEN` is configured. The token must be at least 32 characters and must differ from
`RUNTIME_API_KEY`. The endpoint is intentionally absent from OpenAPI, accepts only an exact Bearer
token and returns 404 while disabled.

Do not publish this endpoint through the product-facing reverse proxy. Place Prometheus on the same
private Docker network as `wa-runtime-api`, or bind a separate private route at the infrastructure
boundary. The reference scrape configuration expects the Runtime service alias
`wa-runtime-api:3100`.

The VPS Event Inbox exposes the same path with its own mandatory production credential,
`EVENT_INBOX_METRICS_TOKEN`. Its public Caddy allowlist intentionally routes only liveness—not
detailed readiness or metrics. Scrape `event-inbox:34200` from its private Docker network using the
separate `event-inbox-prometheus.yml` configuration.

The production Event Inbox deployment also includes `observability.compose.yaml` with private
Prometheus, Alertmanager, node-exporter and blackbox-exporter services. Install the overlay at
`/opt/wa-event-inbox/observability.compose.yaml`, copy this configuration directory to
`/opt/wa-event-inbox/observability`, and start it on the Event Inbox Compose project. None of these
services publishes a host port; use an SSH tunnel or `docker compose exec` for operator inspection.

Copy `observability.env.example` to `/etc/wa-event-inbox/observability.env`, retain mode 0600, and
review every digest before deployment. The checked-in set was resolved and configuration-tested
together; Alertmanager must remain at 0.31 or newer because the Telegram chat ID is file-backed.
Do not replace a digest with `latest` or another mutable tag.

## Provision the scrape credential

Create one random credential on the deployment host and keep it outside Git:

```bash
umask 077
openssl rand -hex 32 > services/runtime/deploy/observability/runtime-metrics-token
chmod 0600 services/runtime/deploy/observability/runtime-metrics-token
export RUNTIME_METRICS_TOKEN="$(tr -d '\r\n' < services/runtime/deploy/observability/runtime-metrics-token)"
```

Pass `RUNTIME_METRICS_TOKEN` only to the Runtime API process. Mount the same file read-only at
`/run/secrets/wa_runtime_metrics_token` in the Prometheus container. The committed
`prometheus.yml` reads the token from that file and never embeds it in configuration or labels.

Provision a different Event Inbox token in the same way, pass it as
`EVENT_INBOX_METRICS_TOKEN`, and mount its file at
`/run/secrets/wa_event_inbox_metrics_token`. Neither metrics token may reuse a general API or master
encryption secret.

Create mode-0400 `/etc/wa-event-inbox/telegram-bot-token` and
`/etc/wa-event-inbox/telegram-chat-id` files for the dedicated production alert bot. Alertmanager
reads both values from files and routes firing and resolved alerts without placing credentials in
the committed configuration. Send one synthetic firing/resolved alert pair before accepting the
deployment.

Create `/var/lib/node-exporter/textfile` mode 0755. The backup and restore-drill services atomically
publish their last-success timestamps there. Missing daily backups after 26 hours and missing monthly
restore drills after 40 days are critical alerts.

Validate configuration before rollout:

```bash
promtool check config services/runtime/deploy/observability/prometheus.yml
promtool check rules services/runtime/deploy/observability/runtime-alerts.yml
(
  cd services/runtime/deploy/observability
  promtool test rules runtime-alerts.test.yml
)
promtool check config services/runtime/deploy/observability/event-inbox-prometheus.yml
promtool check rules services/runtime/deploy/observability/event-inbox-alerts.yml
(
  cd services/runtime/deploy/observability
  promtool test rules event-inbox-alerts.test.yml
)
amtool check-config services/runtime/deploy/observability/alertmanager.yml
blackbox_exporter --config.file=services/runtime/deploy/observability/blackbox.yml --config.check
```

Validate and start the complete private overlay from `/opt/wa-event-inbox`:

```bash
docker compose \
  --env-file event-inbox.env \
  --env-file /etc/wa-event-inbox/observability.env \
  -f compose.yaml \
  -f observability.compose.yaml \
  config --quiet
docker compose \
  --env-file event-inbox.env \
  --env-file /etc/wa-event-inbox/observability.env \
  -f compose.yaml \
  -f observability.compose.yaml \
  up -d
```

Then verify one scrape from the private network:

```bash
curl --fail --show-error \
  --header "Authorization: Bearer ${RUNTIME_METRICS_TOKEN}" \
  http://wa-runtime-api:3100/api/v1/metrics
```

An unset token must return 404. A missing, reused or incorrect credential must not expose metrics.
Rotate the token as a coordinated Runtime API restart and Prometheus secret update; a brief scrape
gap is preferable to accepting two credentials indefinitely.

## Metric contract

- `wa_runtime_http_requests_total` and `wa_runtime_http_request_duration_seconds` use only a bounded
  HTTP method, a matched route template and status code. Unmatched paths collapse to `<unmatched>`;
  request URLs, query strings, session IDs, group IDs and message data never become labels.
- `wa_runtime_dependency_up` probes PostgreSQL and the selected queue backend on each scrape.
- `wa_runtime_background_process_up` reports the current instance's worker and scheduler heartbeat.
- `wa_runtime_database_pool_connections` reports total and idle connections, while
  `wa_runtime_database_pool_waiting_requests` exposes sustained acquisition pressure without query
  or caller labels.
- `wa_runtime_metrics_snapshot_failures_total` records failed dependency probes while the scrape
  itself remains available for diagnosis.
- `wa_runtime_build_info` exposes only version, deployment profile and queue backend.
- `wa_runtime_openwa_safety_scopes`, safety leases, deferred Message Jobs and `UNKNOWN` Message Jobs
  expose bounded aggregate safety state without business identifiers. The oldest unresolved age is
  exported separately as `wa_runtime_openwa_oldest_unknown_message_job_age_seconds`.
- `wa_runtime_webhook_spool_events`, storage/limit gauges, admission reserve, and oldest active/dead
  ages expose durable callback pressure without event identifiers. `UNKNOWN`, `DEAD`, or lost
  admission reserve pages immediately; stalled processing, capacity pressure, recovery, throttling
  and deferred work warn only after their bounded grace period.
- `wa_runtime_process_*` and `wa_runtime_nodejs_*` contain the standard process and Node.js
  collectors from the official Prometheus JavaScript client.

Event Inbox exports only aggregate queue, storage-ledger, pending-age, device, ownership and pairing
rate-limit gauges plus standard process metrics. No device ID, session ID, source IP, event key or
payload becomes a label.

`wa_event_inbox_webhook_admission_available` is one only while the durable ledger has both an event
slot and enough byte headroom for a maximum-sized signed callback. Loss of that reserve is critical,
causes private readiness to return HTTP 503, and must block candidate promotion.

Prometheus adds `job` and `instance` at scrape time. Do not add business identifiers to application
metrics. Use correlated JSON logs and retained Activity data for per-operation diagnosis.

## Alerts and ownership

The Runtime rules page on a missing scrape, required dependency loss or stale worker/scheduler
heartbeat. Sustained pool waiting, HTTP 5xx ratio, p95 latency and snapshot failures are warnings.
Route alerts to the Runtime operator through the deployment's Alertmanager; the repository
deliberately contains no paging destination or credentials.

Event Inbox rules additionally page on snapshot failure, dead events, or unavailable webhook
admission and warn on aged pending events, capacity above 80 percent and sustained pairing throttling.

After an availability alert, check `health/operational`, then PostgreSQL/queue reachability and the
worker/scheduler logs. Never restart an extra scheduler to compensate for a timed-out tick, and
never automatically retry an `UNKNOWN` delivery.
