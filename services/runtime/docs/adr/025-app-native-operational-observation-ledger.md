# ADR 025: Prove desktop operability with an app-native observation ledger

- Status: Accepted
- Date: 2026-09-04
- Applies to: desktop-managed Runtime, production operational evidence, canary promotion
- Supersedes: ADR 024's point-in-time-only observation boundary

## Context

WA Studio is a local desktop application, not a headless service. Its managed PostgreSQL, Runtime
worker, and scheduler intentionally stop when the app closes. The server Prometheus profile cannot
observe that lifecycle and managed Runtime does not expose a metrics credential. Requiring a 24-hour
alert history while providing no durable desktop observation source made production acceptance
dependent on an undeclared external topology.

Point-in-time release evidence also could not prove that an earlier `UNKNOWN` delivery, open safety
circuit, throttled scope, stalled webhook, or full spool had not occurred during the canary window.
Wall-clock timestamps entered by an operator were not sufficient to prove continuous app runtime or
an unchanged candidate.

## Decision

1. The scheduler records an aggregate operational sample once per minute while the app-managed
   Runtime is running. Samples contain no session, group, message, webhook payload, or credential
   identifiers.
2. Every sample is bound to Runtime version, Runtime profile, stable Connector-managed instance ID, WA Studio version,
   and the pinned OpenWA release. Live-send-disabled or unsafe current state is a violating sample.
3. Samples retain only seven days. The fixed-size ledger is local PostgreSQL state and follows the
   existing encrypted backup and retention boundary.
4. The authenticated, OpenAPI-excluded release-evidence endpoint returns both current aggregate
   state and a closed-schema summary of the exact candidate's last 24 hours.
5. Production operational capture fails closed unless the summary covers at least 24 hours, the
   newest sample is current, no internal or boundary gap exceeds five minutes, and no sample is a
   violation. An app shutdown longer than the allowance is evidence of missing supervision, not time
   that can count toward acceptance.
6. Prometheus remains the server-side alert source for Event Inbox. It is optional supplemental
   telemetry for Runtime server profiles, not a hidden dependency of desktop promotion.

## Consequences

- The canary Mac must keep the exact candidate open and operational throughout the acceptance
  window. This matches the product's explicit local-supervision model without installing a daemon.
- Upgrading Studio, changing the pinned OpenWA release, or changing the managed Connector instance starts a
  distinct observation identity and cannot reuse older samples.
- The final evidence file remains secret-free and bounded. Detailed local rows remain available for
  diagnosis until retention removes them.
- This proves Runtime safety continuity; independent Event Inbox alerting, off-host backup/restore,
  native storage evidence, UAT, and operator acknowledgement remain required.

## Required verification

- migration and query tests for clean, unsafe, incomplete, stale, and excessive-gap windows;
- scheduler wiring and shutdown tests;
- release capture tests for candidate identity and 24-hour continuity;
- signed production acceptance and promotion tests against operational snapshot schema 3;
- full Runtime, Studio, release, and packaged managed-runtime checks before tagging.
