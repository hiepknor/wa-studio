# ADR 022: OpenWA connector command and evidence protocol

- Status: Accepted
- Date: 2026-08-31
- Applies to: every WA Runtime live message send routed through the OpenWA connector

## Context

WA Runtime owns campaign policy, rate limits, durable message jobs and the final send fence. OpenWA
remains an independently upgraded external gateway. Its ordinary send response proves only that a
message object was accepted by the gateway; the final WhatsApp state arrives asynchronously. A
timeout after dispatch therefore cannot prove whether a retry is safe.

OpenWA 0.23.3 exposes an Integration Ingress that persists and deduplicates a provider delivery ID
before acknowledging it, plus an installable plugin runtime. Those surfaces allow WA Studio to add a
connector without modifying or vendoring OpenWA. They do not make an effect already started inside
the WhatsApp engine transactional with Runtime's PostgreSQL database.

## Decision

1. OpenWA remains external and unmodified. The WA Studio connector is built, versioned and installed
   as an independent `.zip` artifact.
2. Runtime is the sole authority for business intent, safety admission and operator-visible message
   state. The connector cannot create campaigns, choose recipients, change rate policy or bypass the
   final send fence.
3. A live message is submitted to the connector through OpenWA Integration Ingress using one stable
   `commandId` as the provider delivery ID. Runtime may resubmit the same command only until ingress
   acknowledgement; it never substitutes a new identity for an uncertain submission.
4. Every execution has a distinct `attemptId`. The command carries the immutable content snapshot,
   its SHA-256 digest, the committed safety permit and the current connector binding generation.
   Image commands carry an expiring HTTPS media lease rather than inline bytes because the OpenWA
   0.23.3 plugin capability accepts `mediaUrl`, not base64 media.
5. The connector persists a journal transition before invoking an OpenWA send capability and emits
   append-only evidence through Event Inbox. Evidence is deduplicated by `eventId`, ordered by a
   monotonic sequence within an attempt and reduced monotonically by Runtime.
6. `SEND_STARTED` is the ambiguity boundary. Runtime may automatically retry only a command that has
   not crossed that boundary, or one with explicit `SEND_REJECTED` evidence classified as safe to
   retry. A crash, timeout or malformed response after that boundary becomes `SEND_INDETERMINATE`;
   recipient/time/content similarity is never sufficient evidence for an automatic retry.
7. Connector health is leased. Live send commit fails closed when the plugin is missing, stale,
   blocked, incompatible, bound to another webhook generation or above its storage threshold.
   Every binding generation is also pinned to one connector identity. Replacing a connector requires
   a new generation; a token from the old instance cannot write evidence into the replacement's
   generation, while its already-started commands may finish against retained historical bindings.
   Protocol v1 permits one active connector identity per session; token rotation keeps that identity,
   and plugin upgrades reuse its journal and credential instead of racing two active adapters.
8. The Event Inbox remains a separate bounded server component. It owns durable receipt, replay,
   connector credentials and heartbeat intake, but no campaign or send-policy decisions.
9. Protocol compatibility is negotiated independently from the OpenWA release. Protocol v1 schemas
   are generated from Runtime-owned Zod definitions and shipped with the connector artifact.
10. There is no automatic fallback to the direct OpenWA send endpoints. An operator can stop live
    work, repair or roll back the connector, and resume only after health recovery.
11. Desktop provisioning is resumable rather than response-dependent. WA Studio persists a
    connector UUID, 256-bit connector secret, credential generation, ingress instance ID and
    ingress HMAC secret in the operating-system credential store before it performs any remote
    mutation. Event Inbox stores only a versioned SHA-256 verifier for prepared credentials, and
    OpenWA receives the already-persisted ingress secret on instance creation. Replaying the same
    prepared generation is a no-op; different secret material at the same generation is a conflict.

Runtime records `DISPATCH_STARTED` before making the ingress request. `INGRESS_ACCEPTED` proves the
connector durably received the command, while `SEND_STARTED` is emitted immediately before invoking
the OpenWA send capability. These are separate states; a Runtime dispatch attempt is not evidence
that the WhatsApp send effect began.

## Protocol v1

The generated public JSON Schemas live under
`packages/runtime-contract/openwa-connector/v1`.

### Command invariants

- IDs are UUIDs and remain stable across network resubmission.
- `sessionId` and `recipientId` are explicit; v1 live recipients are synchronized WhatsApp groups.
- Text and image are the only operations. Image bytes are capped at 8 MiB and uploaded once to the
  Event Inbox media relay. A command carries the stable lease URL, filename, MIME type, byte size
  and SHA-256 metadata. The exact URL remains unchanged across retransmission of that command.
- A media lease is scoped to the device, session and attempt, expires no earlier than the command,
  and is invalidated by device revocation or ownership loss. Its opaque bearer token is never put in
  logs or evidence. The plugin accepts media only from its configured Event Inbox HTTPS origin.
- `createdAt` and `expiresAt` bound replay. Expired commands are rejected before `SEND_STARTED`.
- `bindingGeneration` and `connectorId` fence a connector whose OpenWA/Event Inbox registration or
  installed plugin identity drifted.

### Evidence invariants

- Evidence kinds are finite and versioned. Unknown kinds are rejected rather than guessed.
- `sequence` is positive and monotonic per attempt. Duplicate event IDs must have identical bytes.
- The OpenWA message ID is attached as soon as it is known and is then immutable.
- ACK evidence can advance `SENT` to `DELIVERED` to `READ`; late or reordered evidence cannot move a
  projection backwards.
- `SEND_REJECTED` means the connector has evidence the send did not start or was explicitly rejected.
  `SEND_INDETERMINATE` is terminal for automatic execution and requires evidence or operator review.

## Compatibility and release

The pinned OpenWA contract must keep the following reviewed surfaces before a connector-enabled
release is promoted:

- signed Integration Ingress with duplicate `200`, accepted `202`, and bounded `401`/`413`/`429`
  outcomes;
- integration-instance creation with an operator-supplied secret, so a lost HTTP response can be
  recovered without regenerating an unknown credential;
- plugin install, enable, disable, health and staged update operations;
- text and image send capabilities and message lifecycle hooks exercised by the real-host E2E.

The release manifest will record the plugin version, artifact digest, protocol version and journal
schema version. OpenWA, Runtime and plugin upgrades are tested together, but can be rolled back
independently because their persistence domains and artifacts remain separate.

## Consequences and limits

- A duplicate submission before ingress acknowledgement is safe because it keeps the same command
  identity. This is not a claim of distributed exactly-once delivery.
- An ambiguous post-start effect is retained and surfaced instead of retried. This favors avoiding a
  duplicate WhatsApp message over silently maximizing delivery.
- Connector storage and Event Inbox availability become part of live-send readiness. Buffered
  evidence is allowed within a bounded threshold; exhausted storage blocks new live sends.
- Event Inbox stores image blobs as bounded, deduplicated, expiring transport objects. It does not
  become the campaign media source of truth; Runtime retains that responsibility.
- A direct send compatibility path may remain in code for reviewed diagnostics and migration, but it
  is not eligible as a production fallback while connector-required mode is enabled.

## Required verification

- generated schemas exactly match their Runtime definitions and reject cross-operation payloads;
- the pinned OpenWA contract exposes every reviewed connector management and ingress operation;
- duplicate ingress, crash-before-start, crash-after-start, Event Inbox outage, stale heartbeat,
  binding mismatch, token rotation and journal pressure paths are covered;
- text and an 8 MiB image retain their immutable digest from Runtime command through evidence;
- no automated path requeues a `SEND_STARTED` or `SEND_INDETERMINATE` attempt without definitive
  rejection evidence;
- fresh install, connector update, OpenWA upgrade and connector rollback pass packaged E2E before
  unattended live operation is enabled.
- provisioning can be terminated after each remote mutation and resume with the same connector,
  credential generation and ingress instance instead of creating an orphan identity.
