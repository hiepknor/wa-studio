# ADR 023: Preserve unresolved delivery evidence outside routine retention

- Status: Accepted
- Date: 2026-09-04
- Applies to: Message Jobs, Campaign Runs, Runtime webhook spool, metrics and release evidence

## Context

An outbound `UNKNOWN` result means Runtime cannot prove whether WhatsApp accepted the effect. A
webhook in `DEAD` means authenticated input exhausted bounded processing retries. Both states require
operator reconciliation and both are production no-go evidence.

Routine retention previously treated `UNKNOWN` Message Jobs and `DEAD` webhooks like resolved
terminal history. It could also delete a terminal Campaign Run whose delivery graph still contained
an unknown result. Counts would then fall to zero because evidence had been erased, not reconciled.
Separately, a processed webhook retained for diagnostics did not release its active-spool quota when
payload compaction was disabled.

## Decision

1. Routine operational retention never deletes an `UNKNOWN` Message Job.
2. A Campaign Run is not a retention candidate while either its delivery or linked Message Job is
   `UNKNOWN`.
3. Routine raw-webhook retention deletes only `PROCESSED` rows. `DEAD` rows retain their authenticated
   envelope and continue consuming bounded spool quota until a reviewed recovery migration or future
   explicit operator reconciliation resolves them.
4. A webhook releases active-spool event and byte quota atomically when it becomes `PROCESSED`,
   whether the processed diagnostic payload is compacted or retained. The rollout migration rebuilds
   the ledger once from actual unresolved rows to remove quota leaked by earlier non-compact processing.
5. Runtime exports aggregate count and oldest-age metrics for unresolved outbound jobs and dead
   webhooks. Metrics never include session, group, message or event identifiers.
6. Any `UNKNOWN`, `DEAD`, unavailable webhook admission reserve, or unexplained disappearance of
   evidence blocks production promotion. Deleting database rows is not reconciliation.

## Consequences

- Critical evidence cannot age out and create a false-green release signal.
- Unresolved dead webhooks intentionally consume a finite spool budget. Alerts must fire before the
  budget is exhausted; operators must fix or explicitly reconcile the cause rather than delete rows.
- Normal resolved history remains bounded by existing retention windows.
- A future operator reconciliation API must be separately designed with authenticated intent,
  immutable receipts, reason codes and dual review. This ADR does not add an unsafe delete/redrive
  endpoint.

## Required verification

- processed webhooks release spool quota with compaction both enabled and disabled;
- old `UNKNOWN` jobs, their Campaign Run graphs and old `DEAD` webhooks survive routine retention;
- old resolved jobs, runs and processed webhooks remain eligible for bounded cleanup;
- Prometheus rule tests cover `UNKNOWN`, `DEAD`, spool pressure, lost admission reserve and stalled
  processing;
- production acceptance observes zero unresolved records for the unchanged release candidate.
