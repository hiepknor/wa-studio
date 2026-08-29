# ADR 019: Database-guarded execution state transitions

- Status: Accepted
- Date: 2026-08-29
- Applies to: Campaign Run, Campaign Delivery, and Message Job execution state

## Context

The Runtime already owns durable work in PostgreSQL, but its enum types only restrict status labels.
Campaign preparation, scheduling, operator controls, message processing, webhook projection, recovery,
and cancellation update the same aggregates through different repositories. A faulty or stale path
could therefore skip a required state, reopen terminal work, or leave a delivery status incompatible
with its message-job reference without violating the schema.

Delivery evidence can also become more definitive after dispatch completes. OpenWA may first accept a
message and later report failure, while an `UNKNOWN` outcome may later receive sent or failed evidence.
Treating the first aggregate Run label as immutable leaves `CampaignRun.status` inconsistent with its
durable delivery counts.

## Decision

1. PostgreSQL `BEFORE UPDATE` guards enforce the legal transition graph for `campaign_runs`,
   `campaign_deliveries`, and `message_jobs`. Repositories remain the transition owners, but the
   database rejects a skipped, reversed, or unsupported edge with SQLSTATE `23514`.
2. Terminal Campaign Runs require `completed_at`; non-terminal Runs prohibit it.
3. Pending and capability-blocked deliveries cannot reference a message job. Every materialized or
   observed message-backed delivery must reference one. Cancelled deliveries may have either shape
   because cancellation can occur before or after materialization.
4. Message Job `UNKNOWN` is ambiguous rather than immutable. It may resolve only to definitive sent,
   delivered, read, or failed evidence. Sent/delivered/read progression remains monotonic, and no
   terminal failure or cancellation can reopen sending.
5. `CampaignRun.status` is the aggregate of current durable delivery evidence after dispatch has no
   pending, materialized, or processing rows. The scheduler may correct `COMPLETED` to
   `PARTIAL_FAILED` after late failure evidence, or `PARTIAL_FAILED` to `COMPLETED` after an unknown
   outcome resolves successfully. These corrections preserve `completed_at`, emit an activity event,
   keep the Campaign archived, and never create or resend work.
6. The guards apply to updates rather than rewriting historical rows during migration. Existing
   drift is handled by audit/reconciliation and a compatible forward fix; the migration never invents
   delivery evidence.

## Consequences

- A code path cannot silently bypass the shared lifecycle merely because it issues SQL directly.
- Run summaries converge with their delivery counts instead of freezing the earliest dispatch-time
  classification.
- Aggregate labels may be corrected after completion, so consumers must treat Runtime responses and
  activity history as authoritative rather than caching one terminal label forever.
- No OpenWA change is required. The design consumes only the evidence already projected by Runtime.
- Adding a new status or transition requires a forward migration, repository tests, and contract/UI
  review where the public enum changes.

## Required verification

- valid preparation, scheduling, pause, resume, cancellation, recovery, and delivery flows pass the
  full integration suite;
- illegal direct Run, Delivery, and Message Job transitions fail with SQLSTATE `23514`;
- accepted-to-failed evidence corrects `COMPLETED` to `PARTIAL_FAILED` exactly once;
- unknown-to-sent evidence corrects `PARTIAL_FAILED` to `COMPLETED` exactly once;
- neither correction creates a Message Job or invokes OpenWA.
