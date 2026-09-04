# WA Event Inbox deployment

Event Inbox is the only WA Runtime component that remains on the VPS. It persists signed OpenWA
callbacks while a paired desktop is unavailable. It contains no campaigns, message sending,
business projections, Runtime API, or fallback Runtime.

WA Studio discovers it from GET https://openwa.onio.cc/.well-known/wa-studio.

Pairing validates the supplied OpenWA API key against the reviewed OpenWA release declared in
`release/components.json` and returns an expiring protocol-v2 bearer token, a derived webhook
signing secret, callback URL, and authorized session scope. The OpenWA API key is never persisted by
Event Inbox. PostgreSQL fences token generations and permits exactly one active device owner per
OpenWA session.

## Required environment

Build the image from the monorepo root so npm uses the shared workspace lockfile:

~~~bash
docker build -f services/runtime/Dockerfile -t registry.example/wa-event-inbox:<version> .
~~~

Release CI publishes the same Dockerfile and records its immutable digest. Production Compose must
reference that digest rather than a mutable tag.

Create a mode-0600 event-inbox.env with immutable image digests and independent secrets:

~~~dotenv
WA_EVENT_INBOX_IMAGE=registry.example/wa-event-inbox@sha256:<digest>
WA_EVENT_INBOX_POSTGRES_IMAGE=postgres:17.10-alpine@sha256:<digest>
POSTGRES_DB=wa_event_inbox
POSTGRES_USER=wa_event_inbox
POSTGRES_PASSWORD=<random-48+-character-secret>
EVENT_INBOX_DATABASE_URL=postgresql://wa_event_inbox:<url-encoded-password>@postgres:5432/wa_event_inbox
EVENT_INBOX_MASTER_SECRET=<random-48+-character-secret>
EVENT_INBOX_METRICS_TOKEN=<different-random-48+-character-secret>
EVENT_INBOX_HTTP_REQUEST_TIMEOUT_MS=30000
EVENT_INBOX_HTTP_HEADERS_TIMEOUT_MS=10000
EVENT_INBOX_MAX_STORED_EVENTS=500000
EVENT_INBOX_MAX_STORED_BYTES=2147483648
EVENT_INBOX_MAX_PAYLOAD_BYTES=262144
EVENT_INBOX_DEVICE_TOKEN_TTL_DAYS=365
# Set once during the v1 -> v2 rollout, then remove after this fixed UTC instant passes.
EVENT_INBOX_V1_ACCEPT_UNTIL=2026-09-30T00:00:00.000Z
EVENT_INBOX_PUBLIC_BASE_URL=https://wa-events.onio.cc
EVENT_INBOX_OPENWA_BASE_URL=https://openwa.onio.cc
EVENT_INBOX_OPENWA_RELEASE_TAG=<reviewed-tag-from-release/components.json>
EVENT_INBOX_OPENWA_REQUEST_TIMEOUT_MS=10000
EVENT_INBOX_OPENWA_RESPONSE_MAX_BYTES=4194304
EVENT_INBOX_ALLOWED_SESSION_IDS=<comma-separated-session-uuids>
EVENT_INBOX_PAIR_RATE_LIMIT_MAX_ATTEMPTS=5
EVENT_INBOX_PAIR_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS=100
EVENT_INBOX_PAIR_RATE_LIMIT_WINDOW_SECONDS=300
~~~

The master secret derives both OpenWA webhook signing material and device-token signatures.
Rotating it intentionally revokes all desktop pairings and requires reconnecting Studio. Normal
device rotation and revocation use the persisted generation fence and do not rotate this secret.
The credential probe never follows redirects and caps each OpenWA response at
`EVENT_INBOX_OPENWA_RESPONSE_MAX_BYTES`; keep the configured OpenWA URL origin-only.
Update `EVENT_INBOX_OPENWA_RELEASE_TAG` only as part of the coordinated OpenWA/WA Studio release
after `npm run openwa:server:verify` passes; never infer it from GitHub's latest release.
The HTTP listener replaces Nest's 100 KiB default parser with the explicit
`EVENT_INBOX_MAX_PAYLOAD_BYTES` cap, rejects oversized JSON with HTTP 413, strips the Express
fingerprint header, and applies the shared no-store/browser-hardening response headers.

## Clean cutover

This deployment deliberately uses a new Compose project, database tables, and volume. Do not copy
or mount the legacy relay volume.

~~~bash
docker compose --env-file event-inbox.env -f compose.yaml config --quiet
docker compose --env-file event-inbox.env -f compose.yaml up -d
curl --fail https://wa-events.onio.cc/api/v1/health/live
curl --fail http://127.0.0.1:34200/api/v1/health/ready
curl --fail https://openwa.onio.cc/.well-known/wa-studio
~~~

Roll out a Studio build that accepts protocols 1 and 2 first. Then deploy Event Inbox v2 with one
fixed `EVENT_INBOX_V1_ACCEPT_UNTIL` timestamp, update discovery to protocol 2, and reconnect Studio
so it takes session ownership with a v2 token. Verify the old v1 token is rejected for that session
and a live callback drains to local PostgreSQL. Remove the grace setting after its deadline; do not
extend it on later restarts.

## Reversible Event Inbox canary

The `canary` Compose profile runs the candidate image on loopback port 34201 while the accepted
primary remains on 34200. Candidate migrations run from the candidate digest first. Every schema
change used during a canary must remain readable and writable by the primary image; destructive or
one-way migrations require a separate expand/migrate/contract release sequence.

Migration `011_legacy_primary_compatibility.sql` is the rollback fence for the connector rollout.
It makes retained receipt tombstones suppress inserts from the accepted primary binary and cascades
connector ownership when that binary expires a device. The integration release-upgrade test starts
from migrations 001–003, applies the complete candidate set, then exercises those legacy insert and
cleanup statements. Do not bypass that test or deploy a candidate whose migration floor differs
from the accepted primary.

Stage an attested candidate digest and confirm private readiness before changing public traffic:

~~~bash
export WA_EVENT_INBOX_CANARY_IMAGE='ghcr.io/hiepknor/wa-event-inbox@sha256:<digest>'
docker compose --env-file event-inbox.env --profile canary up -d event-inbox-canary
curl --fail http://127.0.0.1:34201/api/v1/health/ready
container="$(docker compose --env-file event-inbox.env --profile canary ps -q event-inbox-canary)"
npm run event-inbox:candidate:verify -- \
  --manifest ./wa-studio-server-deployment.json \
  --readiness-url http://127.0.0.1:34201 \
  --container "$container"
sudo env WA_EVENT_INBOX_UPSTREAM=127.0.0.1:34201 \
  WA_EVENT_INBOX_CONTROL_UPSTREAM=127.0.0.1:34201 \
  caddy validate --config /etc/caddy/Caddyfile
sudo env WA_EVENT_INBOX_UPSTREAM=127.0.0.1:34201 \
  WA_EVENT_INBOX_CONTROL_UPSTREAM=127.0.0.1:34201 \
  caddy reload --config /etc/caddy/Caddyfile
curl --fail https://wa-events.onio.cc/api/v1/health/live
~~~

Verify the downloaded deployment manifest's GitHub attestation before this command. The verifier is
read-only and refuses the cutover unless the container's configured digest, serving process release,
reviewed OpenWA tag, connector protocol/journal schema, and applied Event Inbox migration head/count
all match that one manifest. It also requires one free event slot and enough byte reserve to durably
accept a maximum-sized signed callback. A generic `ready` response is not sufficient release evidence.

The committed Caddy routes default to 34200, so an ordinary reload or restart without the explicit
environment values fails back to the accepted primary. For immediate rollback, reload Caddy with
both `WA_EVENT_INBOX_UPSTREAM=127.0.0.1:34200` and
`WA_EVENT_INBOX_CONTROL_UPSTREAM=127.0.0.1:34200`; do not stop either slot until liveness and a
callback round trip are green through the public endpoint. The independent control-plane upstream
keeps connector credentials, bindings, heartbeats, evidence, and media relay on one release during
a staged cutover.

After the 24-hour acceptance window, keep traffic on 34201, replace `WA_EVENT_INBOX_IMAGE` in the
mode-0600 `event-inbox.env` with the exact accepted digest, converge `migrate` and `event-inbox`,
verify readiness on 34200, switch Caddy back to 34200, and only then stop the canary profile. This
restores the fail-safe default without an exposed service gap.

After Studio provisions the connector, verify the complete cross-system identity from the canary
Mac without exporting its credentials from Keychain:

~~~bash
npm run openwa:connector:verify -- --managed-profile
~~~

The verifier is read-only and fails unless the reviewed OpenWA release, one-session API scope,
release-pinned enabled plugin, exact single ingress, local connector identity, Event Inbox binding,
credential and binding generations, protocol and journal versions, heartbeat freshness, blocked
state, and storage pressure all agree. For non-Keychain automation, provide `OPENWA_BASE_URL`,
`OPENWA_API_KEY`, `EVENT_INBOX_DEVICE_TOKEN`, `WA_STUDIO_CONNECTOR_ID`,
`WA_STUDIO_CONNECTOR_INSTANCE_ID`, `WA_STUDIO_SESSION_ID`, and
`WA_STUDIO_CONNECTOR_TOKEN_GENERATION` through the secret runner environment; never place them in a
command argument, checked-in env file, or artifact.

## Bounded storage

The default profile enforces seven-day expiry, 500,000 stored events, 2 GiB aggregate payloads,
256 KiB per callback, 60-second claims, 20 delivery attempts, poison-event isolation, and bounded
container logs. The event-count ceiling can be configured up to 5,000,000 and the byte ceiling up to
8 GiB, but increasing either value is a capacity-planned release change, not an incident-time knob.

Before rollout, calculate the offline buffer from the highest observed callback rate and average
stored bytes per event. The lower of the event and byte ceilings must cover at least 24 hours at the
observed peak, while leaving enough disk for PostgreSQL, WAL, one local encrypted backup, and the
restore drill. Readiness reports stored, pending, leased, dead, oldest-pending, active-device,
legacy-device, and owned-session metrics. Private readiness returns HTTP 503 when either the event
slot reserve or maximum-callback byte reserve is exhausted; liveness remains independent so operators
can drain and diagnose the existing ledger. After the fixed v1 grace expires, maintenance removes
inactive ownership fences and expired device records without allowing token-generation reuse.

## Pairing abuse protection

Pairing consumes a durable global PostgreSQL bucket before a per-source-IP bucket. The defaults
permit 100 total attempts and five attempts per IP in each five-minute window. Source IPs are HMACed
with a domain-separated key before storage; neither readiness nor logs contain a raw address.
Exhausted buckets return HTTP 429 with `Retry-After` before OpenWA credential validation. Caddy is
the only public proxy and the application trusts exactly one proxy hop when resolving the source IP.

Readiness exposes `activeRateLimitBuckets` and `rateLimitedPairingAttempts`. Alert on any sustained
increase in blocked attempts and investigate before raising a limit. Expired buckets are removed by
the existing bounded maintenance loop.

Production also requires `EVENT_INBOX_METRICS_TOKEN`, distinct from the master secret. A private
Prometheus scrape at `/api/v1/metrics` converts readiness into aggregate event, byte, age, device,
ownership and rate-limit gauges. The public Caddy route set exposes only `/api/v1/health/live`; it
does not forward detailed readiness or metrics. Use the private scrape configuration and alert rules
in [deploy/observability](../observability/README.md).

## Encrypted off-host backups

The named PostgreSQL volume is not a disaster-recovery backup. Install `age`, `jq`, `rclone`, Docker
Compose and the checked-in backup scripts on the VPS. Configure an off-host object store with
versioning or object lock and a provider-side lifecycle that retains at least 35 days. Keep the age
identity outside the object store and escrow the current `EVENT_INBOX_MASTER_SECRET` independently;
both the database and that secret are required to verify retained callbacks after recovery.

Install the files using these fixed paths:

- deployment, `event-inbox.env`, and the attested coordinated
  `wa-studio-deployment.json`: `/opt/wa-event-inbox/`;
- scripts: `/opt/wa-event-inbox/scripts/`;
- mode-0600 rclone config: `/etc/wa-event-inbox/rclone.conf`;
- mode-0400 age identity: `/etc/wa-event-inbox/backup.agekey`;
- mode-0600 backup environment: `/etc/wa-event-inbox/backup.env`.
- node-exporter textfile metrics: `/var/lib/node-exporter/textfile/`.

Example `backup.env`:

~~~dotenv
EVENT_INBOX_DEPLOY_DIR=/opt/wa-event-inbox
EVENT_INBOX_BACKUP_METRICS_DIR=/var/lib/node-exporter/textfile
EVENT_INBOX_BACKUP_REMOTE=offsite:wa-event-inbox/production
EVENT_INBOX_BACKUP_STAGING_REMOTE=offsite:wa-event-inbox/staging
EVENT_INBOX_BACKUP_AGE_RECIPIENT=age1...
EVENT_INBOX_BACKUP_AGE_IDENTITY_FILE=/etc/wa-event-inbox/backup.agekey
EVENT_INBOX_DEPLOYMENT_MANIFEST=/opt/wa-event-inbox/wa-studio-deployment.json
EVENT_INBOX_RESTORE_EVIDENCE_DIR=/var/lib/wa-event-inbox-backup/evidence
RCLONE_CONFIG=/etc/wa-event-inbox/rclone.conf
~~~

The staging prefix must not have an object lock because the verified `.partial` object is moved out
of it. Apply a 35-day bucket lock to the production prefix, expire production objects after 90 days,
and expire abandoned staging objects after one day.

For Cloudflare R2, create one private bucket and an Object Read & Write S3 token scoped only to that
bucket. Configure the rclone endpoint as `https://<account-id>.r2.cloudflarestorage.com`, add a
35-day bucket-lock rule for the `production/` prefix, a 90-day lifecycle expiration for
`production/`, and a one-day lifecycle expiration for `staging/`. R2 lock rules take precedence over
lifecycle deletion, so the 90-day rule cannot remove a still-locked object. Verify the effective
lock and lifecycle rules in Cloudflare before enabling either systemd timer.

Install and enable `wa-event-inbox-backup.service/.timer` for daily backups. The backup takes a
consistent custom-format `pg_dump`, checks it with `pg_restore --list`, encrypts it with the public
age recipient, uploads it to the unlocked staging prefix, reads it back to verify SHA-256, moves the
verified object to the locked production prefix, and writes the checksum marker last.

Install `wa-event-inbox-restore-drill.service/.timer` only where the age identity is intentionally
available. The monthly drill downloads the latest complete backup, verifies its checksum, decrypts
it, restores into a uniquely named temporary database, validates migrations and the usage ledger,
then drops only that drill database. It does not stop or modify the production database. A passing
drill also creates an owner-only JSON evidence record under
`/var/lib/wa-event-inbox-backup/evidence/`. That record binds the restored archive and migration
head to the exact coordinated deployment-manifest digest; a manifest/schema mismatch fails the
drill instead of emitting success evidence. Copy the JSON record—not the decrypted dump—into the
private release evidence set and verify it with `npm run release:recovery:verify`.

~~~bash
systemctl enable --now wa-event-inbox-backup.timer
systemctl enable --now wa-event-inbox-restore-drill.timer
systemctl start wa-event-inbox-backup.service
systemctl start wa-event-inbox-restore-drill.service
journalctl -u wa-event-inbox-backup.service -u wa-event-inbox-restore-drill.service
~~~

Treat a missing daily backup, a remote checksum mismatch, or a failed monthly restore drill as a
production incident. Do not delete the PostgreSQL volume or rotate the master secret while recovery
evidence is incomplete.
