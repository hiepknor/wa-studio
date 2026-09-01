# ADR 016: Revision-bound proof for reviewed LIVE launches

- Status: Accepted
- Date: 2026-08-23
- Applies to: Campaign preflight, LIVE run creation, and launch idempotency

## Context

Campaign run creation already snapshots campaign content and targets in one database transaction,
and preparation fences capability revisions before creating deliveries. The public launch request,
however, could omit its expected revisions. Its idempotency comparison also considered only
`executionMode`, so reusing one key with different reviewed revisions was not a conflict. Finally,
an API caller could skip the standalone LIVE preflight that Studio presents to the operator.

OpenWA `0.22.0` does not accept a Runtime idempotency token on `send-text`. A successful local launch
therefore cannot turn an ambiguous upstream POST into exactly-once delivery. The safe behavior after
an upstream request begins remains to quarantine an uncertain result as `UNKNOWN`, never retry it
automatically.

## Decision

1. A new LIVE run requires `expectedCampaignRevision`, `expectedTargetsRevision`, and the signed
   `preflightToken` returned by a recent passing LIVE preflight.
2. The proof is an HMAC-SHA-256 token with a domain-separated signature. It is bound to campaign ID,
   session ID, both revisions, policy version, issue time, expiry, and a random nonce. The Runtime
   API key is the signing secret; the proof default lifetime is 120 seconds and is bounded to
   30–900 seconds by `CAMPAIGN_LIVE_PREFLIGHT_TTL_SECONDS`.
3. Blocked LIVE and all DRY_RUN preflights return no launch proof. A token cannot be transferred to
   another campaign, session, or revision snapshot.
4. Run creation verifies the proof before entering the creation transaction. The transaction again
   locks the campaign, compares both revisions, snapshots targets, and enforces the one-LIVE-run
   database invariant. Preparation then reevaluates current session and group capability and fences
   capability revisions before any delivery is committed.
5. A run idempotency key represents the full business launch intent: execution mode plus every
   supplied campaign and target revision. Reuse with a different intent returns
   `CAMPAIGN_RUN_IDEMPOTENCY_CONFLICT`.
6. An exact replay still authenticates and matches the signed proof, but may use it after expiry
   because the replay returns an existing durable run and cannot create new outbound work.
7. A lost or ambiguous OpenWA send remains `UNKNOWN`. Runtime does not claim exactly-once delivery
   beyond an upstream boundary that offers no idempotency primitive.

## Consequences

- Studio launch confirmation is now cryptographically tied to the persisted snapshot it displayed.
- A stale or delayed confirmation fails closed and requires a new preflight; it never silently
  adopts newer revisions.
- Transport retry after a lost run-create response remains safe even after the short proof lifetime.
- Capability or session drift after review can create a `PREPARING` run, but preparation blocks it
  before deliveries. The worker repeats the sendability check immediately before calling OpenWA.
- DRY_RUN compatibility is unchanged; its revision fields remain optional at the public boundary.

## Required verification

- missing revisions or proof cannot create a LIVE run;
- tampered, expired, or cross-snapshot proof cannot create a LIVE run;
- exact replay returns the original run, including after proof expiry;
- one key with a changed revision returns an idempotency conflict;
- concurrent distinct LIVE intents still create at most one run;
- capability drift between review and preparation cannot create a sendable delivery;
- an ambiguous upstream POST remains `UNKNOWN` and is not automatically retried.
