# Desktop-managed Event Inbox cutover

This is a clean cutover. OpenWA code and release stay unchanged. No VPS Runtime data or legacy relay
event is migrated, and there is no dual delivery or fallback mode.

## 1. Release gates

1. Pin OpenWA to 0.22.0 and record its immutable image.
2. Run Runtime check, Event Inbox E2E, Studio check, and packaged managed-runtime E2E.
3. Build immutable amd64 Event Inbox and signed universal Studio artifacts.
4. Record both image/app digests and verify no generated secret is in source control.

## 2. Stage the new server boundary

Follow the Event Inbox deployment guide. Use a new Compose project, tables and PostgreSQL volume.
Validate Compose and Caddy before changing the active listener. Add exact discovery JSON at
https://openwa.onio.cc/.well-known/wa-studio.

Required pre-cutover checks:

- Event Inbox local readiness returns protocolVersion 2 and zero stored events.
- Public discovery names exactly https://wa-events.onio.cc.
- Legacy GET /api/v1/relay/events returns 404.
- GET on pairing and delivery endpoints returns 404.
- OpenWA remains healthy on image/tag 0.22.0.

## 3. Atomic callback cutover

1. Stop only the old relay listener to release loopback port 34200.
2. Start Event Inbox and its fresh PostgreSQL volume.
3. Pair the desktop with OpenWA Base URL and API key.
4. Update the existing OpenWA webhook through the supported API with the pairing callback and
   derived secret, keeping the reviewed nine events, active=true and retryCount=3.
5. Start Studio so local Runtime begins claim/lease consumption.

The callback URL remains /api/v1/webhooks/openwa on wa-events.onio.cc; the security and delivery
protocol behind it changes atomically.

## 4. Acceptance

Require all of the following before deleting legacy resources:

- Studio status is connected to the OpenWA origin and Runtime readiness is healthy.
- Event Inbox pending/stored counts drain toward zero under live traffic.
- A controlled callback is stored, claimed, committed locally and receipt-ACKed.
- Reposting its idempotency key leaves one local row.
- A stale receipt ACK returns zero.
- A transient NACK redelivers with a new receipt.
- A deterministic poison NACK increments deadEvents without blocking a following callback.
- OpenWA restart count remains stable and its webhook test returns success.
- Closing Studio leaves Event Inbox accumulating; reopening drains it.

## 5. Irreversible cleanup

After acceptance, remove exactly the wa-webhook-relay Compose project, directory, stopped
containers, network and wa-webhook-relay_postgres-data volume. Delete any obsolete schema-v1 local
secret file before pairing the final schema-v2 profile.
after schema v2 has started successfully. Remove only the staged image archive and explicitly
identified unreferenced legacy image. Do not run broad Docker prune commands.

Rollback is not part of this design. A failure before acceptance is fixed forward while Event Inbox
continues to buffer signed callbacks.
