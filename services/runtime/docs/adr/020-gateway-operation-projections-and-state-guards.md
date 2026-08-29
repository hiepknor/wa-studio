# ADR 020: Revision-stable gateway operations and database-guarded sync state

- Status: Accepted
- Date: 2026-08-29
- Applies to: Session sync, group reconciliation, and capability-refresh observation

## Context

`gateway_group_reconciliation_intents` is a mutable scheduling aggregate. New events can coalesce
while an attempt is running, increment its requested revision, reset retry state, and replace terminal
timestamps. Serving a historical capability-refresh request from that one row can therefore attach a
newer revision's status, attempt count, timestamp, or error to an older idempotency receipt.

Gateway sync enums also restricted labels without restricting edges. Direct SQL could skip claims,
reopen terminal work, retain a lease after completion, or leave a terminal sync run in the
`DISCOVERING` phase.

## Decision

1. `gateway_group_reconciliation_operations` is the revision-stable read projection. It stores one
   row per requested intent revision, including source, status, attempts, retry time, terminal time,
   and error code.
2. A PostgreSQL projection trigger creates one row for each newer intent revision. Pure event
   coalescing touches only the newly created revision and the current operation; claim, retry,
   failure, and authoritative-sync completion may advance the non-terminal operations covered by
   that lifecycle transition. Completed and failed historical operations are immutable; a later
   intent cannot rewrite their result. This keeps event ingestion bounded instead of repeatedly
   rewriting the full revision history.
3. Mutation receipts continue to own idempotent request identity. A receipt points to one operation
   revision, and replay reads that revision's projection rather than reconstructing it from the latest
   intent.
4. PostgreSQL guards enforce legal transitions and lifecycle-field consistency for `sync_runs`,
   `gateway_sync_items`, and `gateway_group_reconciliation_intents`. Invalid edges fail with SQLSTATE
   `23514`.
5. A terminal sync run always has phase `COMPLETED`, a completion time, and no lease. A running
   discovery owns a lease; a running reconciliation delegates ownership to sync items and therefore
   does not retain the discovery lease.
6. No OpenWA endpoint, payload, or upstream behavior changes. These are local Runtime durability and
   projection rules.

## Consequences

- Polling an older capability-refresh revision remains stable while later events are pending or fail.
- Multiple idempotency keys may still join the same active revision without creating duplicate work.
- Every automatic group event creates a lightweight operation projection row. Retention deletes
  terminal historical rows in bounded batches while preserving the latest revision and every
  revision still referenced by a retained mutation receipt.
- Adding a gateway status or legal edge requires a forward migration and integration coverage.

## Required verification

- valid full/incremental sync, snapshot deferral, item retry/recovery, targeted reconciliation, and
  authoritative-sync completion pass the full integration suite;
- direct skipped transitions for Run, Item, and Intent fail with SQLSTATE `23514`;
- revision N remains terminal and unchanged while revision N+1 runs or fails;
- idempotent replay reads the operation referenced by its receipt;
- terminal Session Sync responses always report phase `COMPLETED`.
