# ADR 024: Bind final promotion to machine-captured Runtime safety evidence

- Status: Accepted
- Date: 2026-09-04
- Applies to: Runtime private health surface, canary operational snapshot and production promotion

## Context

The production acceptance record observes a fixed candidate for 24 hours and requires operators to
record zero critical alerts, unknown deliveries and terminal callback failures. The final operational
snapshot previously proved Runtime, OpenWA and Connector health, but it did not capture the database
state behind the corresponding Runtime safety alerts. A manually entered zero could therefore
disagree with an unresolved `UNKNOWN` Message Job, retained `DEAD` webhook or active safety circuit
at the exact time the release was accepted.

Prometheus remains the source for alerting and observation-window history. Requiring its dedicated
credential in the desktop release tool would, however, couple product acceptance to an optional
telemetry deployment and introduce a second secret into the managed Runtime profile.

## Decision

1. Runtime exposes an authenticated, OpenAPI-excluded `GET /api/v1/health/release-evidence` endpoint.
   It uses the existing private Runtime credential and returns only bounded aggregate counts, ages,
   capacity and admission state; it never returns a session, group, message, webhook or credential.
2. The operational snapshot captures this endpoint in the same bounded request set as liveness,
   readiness and operational health. Snapshot schema 2 embeds the exact aggregate response and its
   generation time.
3. Capture and offline verification fail closed unless:
   - no safety scope is open, half-open, manually blocked or throttled;
   - no Message Job is safety-deferred or `UNKNOWN`;
   - no Runtime webhook is `DEAD`;
   - active webhook work is no older than five minutes;
   - spool utilization remains below the existing 75% production threshold; and
   - the spool can still admit one maximum-sized webhook.
4. The evidence must be generated within 30 seconds of the snapshot capture time. Its spool ledger
   counts and nullable ages must be internally consistent, so editing one field cannot create a
   valid artifact.
5. The endpoint is point-in-time evidence, not an alert-history replacement. The encrypted evidence
   archive and acceptance record still prove the full unchanged 24-hour observation window and the
   Event Inbox server's independent state.

## Consequences

- A signed promotion can no longer rely only on manually transcribed zero counters while Runtime has
  retained contradictory evidence.
- Managed desktop capture needs no new credential and does not enable or expose Prometheus.
- An unresolved ambiguity, callback failure, safety recovery state or lost spool reserve blocks the
  release until it is genuinely reconciled; deleting retained evidence is not an accepted remedy.
- The private endpoint intentionally remains outside the product API contract and UI. It may evolve
  only together with a new operational-snapshot schema and release verifier.

## Required verification

- endpoint authentication and aggregate-only response integration tests;
- release-evidence query tests for clean and unresolved state;
- operational capture tests for clean evidence plus fail-closed `UNKNOWN`, `DEAD`, admission and
  stale-processing cases;
- acceptance and signed-promotion tests against operational snapshot schema 2;
- full Runtime and release checks before creating a canary tag.
