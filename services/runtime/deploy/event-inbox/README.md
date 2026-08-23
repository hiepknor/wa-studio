# WA Event Inbox deployment

Event Inbox is the only WA Runtime component that remains on the VPS. It persists signed OpenWA
callbacks while a paired desktop is unavailable. It contains no campaigns, message sending,
business projections, Runtime API, or fallback Runtime.

WA Studio discovers it from GET https://openwa.onio.cc/.well-known/wa-studio.

Pairing validates the supplied OpenWA API key against the pinned OpenWA 0.22.0 gateway and returns
a per-device bearer token, a derived webhook signing secret, callback URL, and authorized session
scope. The OpenWA API key is never persisted by Event Inbox.

## Required environment

Build the image from the monorepo root so npm uses the shared workspace lockfile:

~~~bash
docker build -f services/runtime/Dockerfile -t registry.example/wa-event-inbox:<version> .
~~~

Release CI publishes the same Dockerfile and records its immutable digest. Production Compose must
reference that digest rather than a mutable tag.

Create a mode-0600 event-inbox.env with immutable image digests and independent secrets:

~~~dotenv
WA_EVENT_INBOX_IMAGE=registry.example/wa-runtime@sha256:<digest>
WA_EVENT_INBOX_POSTGRES_IMAGE=postgres:17.10-alpine@sha256:<digest>
POSTGRES_DB=wa_event_inbox
POSTGRES_USER=wa_event_inbox
POSTGRES_PASSWORD=<random-48+-character-secret>
EVENT_INBOX_DATABASE_URL=postgresql://wa_event_inbox:<url-encoded-password>@postgres:5432/wa_event_inbox
EVENT_INBOX_MASTER_SECRET=<random-48+-character-secret>
EVENT_INBOX_PUBLIC_BASE_URL=https://wa-events.onio.cc
EVENT_INBOX_OPENWA_BASE_URL=https://openwa.onio.cc
EVENT_INBOX_OPENWA_RELEASE_TAG=0.22.0
EVENT_INBOX_ALLOWED_SESSION_IDS=<comma-separated-session-uuids>
~~~

The master secret derives both OpenWA webhook signing material and stateless device-token
signatures. Rotating it intentionally revokes all desktop pairings and requires reconnecting Studio.

## Clean cutover

This deployment deliberately uses a new Compose project, database tables, and volume. Do not copy
or mount the legacy relay volume.

~~~bash
docker compose --env-file event-inbox.env -f compose.yaml config --quiet
docker compose --env-file event-inbox.env -f compose.yaml up -d
curl --fail https://wa-events.onio.cc/api/v1/health/ready
curl --fail https://openwa.onio.cc/.well-known/wa-studio
~~~

Only after both checks pass, reconnect WA Studio so it obtains schema-v2 local credentials and
Runtime reconciles the existing OpenWA webhook to the derived secret. Verify a live callback drains
to local PostgreSQL before removing the exact legacy wa-webhook-relay project and volume.

## Bounded storage

The default profile enforces seven-day expiry, 100,000 stored events, 256 MiB aggregate payloads,
256 KiB per callback, 60-second claims, 20 delivery attempts, poison-event isolation, and bounded
container logs. Readiness reports stored, pending, leased, dead, and oldest-pending metrics.
