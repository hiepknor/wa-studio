# WA Runtime

Durable control plane between **WA Studio** and the existing **OpenWA Gateway**. The Runtime contract
remains client-neutral for future trusted clients, but the product architecture is deliberately
named `WA Studio -> WA Runtime -> OpenWA`. No client calls OpenWA directly or receives an OpenWA
operator key.

Milestone 3 is complete. The Runtime currently provides:

- a durable OpenWA read model for sessions, groups and group messages;
- group send-capability evaluation and targeted refresh;
- campaign drafts, group targets and versioned preflight checks;
- durable campaign runs, per-group deliveries, progress and recovery after restart;
- pause, resume and cancel controls;
- PostgreSQL-backed state, Redis/BullMQ queues and HMAC-verified OpenWA webhooks;
- PostgreSQL-coordinated per-session outbound pacing and bounded PostgreSQL retention;
- correlated, redacted JSON logs across API, scheduler and worker;
- a disabled-by-default, dedicated-token Prometheus contract and reference alert rules.

Live delivery is disabled by default. A new `LIVE` run requires a recent passing signed preflight,
explicit campaign/target revisions, and `ALLOW_LIVE_SENDS=true`. Develop against `dev-session` with
this switch kept off.

## Architecture

The production target is local-first: WA Studio supervises the bundled Runtime roles, PostgreSQL and
PostgreSQL durable queue on the operator's device. The VPS keeps the reviewed OpenWA release
unchanged and runs only a bounded Event Inbox so an offline/NATed desktop does not lose acknowledged
callbacks.

```text
WA Studio desktop -> loopback Runtime API/worker/scheduler -> embedded PostgreSQL
                                              |
                                              v
                                      OpenWA Gateway (reviewed tag)
                                              |
                                              | signed webhook
                                              v
                            VPS Event Inbox + bounded PostgreSQL
                                              |
                                              | claim lease + receipt ACK/NACK
                                              v
                                    local Runtime ingress
```

The server profile remains available for development and staging only. New production installs use
the desktop-managed profile and do not require Redis. See [ADR 015](docs/adr/015-event-inbox-discovery-and-pairing.md)
for the target topology and failure analysis.

## Quick start with Docker

Prerequisites: Docker with Compose. Node.js 24.19.0 is needed only for running checks or processes
outside Docker. Start OpenWA from its own repository first so the shared `wa-dev-network` and
`openwa-dev-api` service exist; see [Development](docs/development.md).

```bash
cp services/runtime/.env.example services/runtime/.env
```

Replace every placeholder in `.env`, then start the stack:

```bash
set -a
source services/runtime/.env
set +a
docker compose --env-file services/runtime/.env -f services/runtime/docker-compose.yml up --build -d
docker compose --env-file services/runtime/.env -f services/runtime/docker-compose.yml ps
curl --header "X-Runtime-Key: $RUNTIME_API_KEY" \
  http://localhost:3100/api/v1/health/ready
```

Local endpoints:

- Runtime API: <http://localhost:3100/api/v1>
- Swagger UI: <http://localhost:3100/api/v1/docs>
- Public liveness: <http://localhost:3100/api/v1/health/live>
- Authenticated readiness: <http://localhost:3100/api/v1/health/ready>

Protected endpoints require:

```http
X-Runtime-Key: <RUNTIME_API_KEY>
```

The default Compose network expects `DATABASE_URL` to use host `postgres`, `REDIS_URL` to use host
`redis`, and the local OpenWA stack to be reachable as `openwa-dev-api`. Host-side commands instead
use `localhost:5433` and `localhost:6380`; see [Development](docs/development.md).

## Safe first run

The recommended first end-to-end flow for any management client is:

1. synchronize `dev-session`;
2. inspect groups and their send capabilities;
3. create a campaign and replace its group targets;
4. run preflight with `DRY_RUN`;
5. create a durable dry-run and watch progress until `COMPLETED`;
6. exercise pause, resume and cancel before considering live delivery.

The exact lifecycle and state meanings are documented in
[Campaign lifecycle](docs/campaign-lifecycle.md). The complete machine-readable contract is
[packages/runtime-contract/openapi.json](../../packages/runtime-contract/openapi.json).

## Documentation

- [Architecture](docs/architecture.md) — boundaries, components, data ownership and flows.
- [ADR 002](docs/adr/002-rename-to-wa-runtime.md) — product rename and operational compatibility identifiers.
- [ADR 016](docs/adr/016-reviewed-live-launch-proof.md) — signed revision-bound LIVE review proof and replay semantics.
- [Campaign lifecycle](docs/campaign-lifecycle.md) — capabilities, preflight, runs and deliveries.
- [Development](docs/development.md) — local OpenWA, configuration, tests and contract generation.
- [Operations](docs/operations.md) — production safety, deploy, recovery, backup and upgrade.
- [Event Inbox deployment](deploy/event-inbox/README.md) — immutable image, discovery, pairing, leases and disk bounds.
- [Desktop installation runbook](docs/runbooks/desktop-managed-cutover.md) — clean local initialization and direct retirement of the old Runtime.
- [Failure model](docs/failure-model.md) — durable dispatch, leases, retry and ambiguous delivery semantics.
- [Observability](docs/observability.md) — JSON logs, correlation IDs, health checks and manual diagnosis.
- [Metrics deployment](deploy/observability/README.md) — private scraping, credential handling and alert rules.
- [Latest local acceptance](docs/acceptance/2026-08-12-multiprocess-local.md) — two-worker concurrency, Redis recovery, dry-run load and group-member smoke evidence.
- [API contract](docs/api-contract.md) — authentication, idempotency, endpoint groups and versioning.

## Common commands

```bash
npm run check
npm run test:integration

set -a
source .env
set +a
npm run contract:check

docker compose logs -f api worker scheduler
docker compose down
```

Do not use `docker compose down -v` unless intentionally deleting all local Runtime data. Never
commit `.env`, OpenWA keys, webhook secrets, paired session credentials or production database
exports.
