# ADR 015: Event Inbox discovery, pairing and leased delivery

## Status

Accepted and implemented on 2026-08-22. Replaces the discarded shared-token relay design.

## Decision

WA Studio, WA Runtime and the business PostgreSQL database ship as one local desktop product.
OpenWA remains an unchanged service pinned to release 0.22.0. The VPS runs only Event Inbox and its
small dedicated PostgreSQL database.

Connect asks for two values: OpenWA Base URL and API key. Native code verifies the release, reads
`/.well-known/wa-studio`, and sends a one-time pairing request to the discovered Event Inbox. Event
Inbox validates the API key directly against the configured OpenWA origin without storing it, then
returns a protocol-v2 device bearer token, derived webhook secret, callback URL and authorized
session IDs. Studio stores them in the operating system secure credential store.

Protocol v2 signs an expiry and monotonically increasing token generation. PostgreSQL is
authoritative for that generation and for the single active device owner of each OpenWA session.
Re-pairing the same device rotates its generation; pairing another device transfers session
ownership. Both operations release stale leases, while generation checks fence stale ACK/NACK
receipts. A device can revoke its current generation explicitly.

Protocol-v1 tokens may be admitted only until the fixed UTC timestamp configured by
`EVENT_INBOX_V1_ACCEPT_UNTIL`. During that bounded window a v1 device can adopt only an unowned
session and can never take it back from v2. New Studio accepts discovery/pairing protocols 1 and 2
so the desktop can roll out before the server; the v2 server issues only v2 tokens.

OpenWA sends signed callbacks to Event Inbox. Runtime claims an ordered batch under a 60-second
lease. Each event carries an opaque receipt bound to the claim lease and device. Runtime ACKs only
after local durable ingress succeeds. It NACKs transient failures for exponential retry and marks
deterministic malformed/session-invalid events dead. Stale receipts cannot delete a re-leased row.

## Rejected alternatives

- Direct desktop callbacks fail behind NAT and while the Mac sleeps.
- Polling OpenWA is not an equivalent event stream and increases gateway load.
- A tunnel makes desktop availability part of ingress availability.
- A full VPS Runtime duplicates business execution and returns the server resource problem.
- A shared permanent pull token cannot identify a device or support fenced delivery.
- Reusing OpenWA PostgreSQL couples independent failure, storage and upgrade domains.
- Migrating legacy relay rows preserves no required business authority and complicates cutover.

## Consequences

The server footprint is bounded and contains no business logic. Event delivery is at-least-once;
local idempotency remains authoritative. Pairing rotates independently from Runtime API credentials.
Pairing rotation, ownership transfer and explicit revocation invalidate device access without
rotating the webhook secret. Master-secret rotation still revokes every signature and changes the
derived webhook secret, so it requires an explicit Studio reconnect and OpenWA webhook
reconciliation. Capacity exhaustion returns HTTP 503 so OpenWA retries rather than accepting data
that was not persisted.
