# ADR 021: Runtime-owned OpenWA Safety Governor

- Status: Accepted
- Date: 2026-08-29
- Applies to: every WA Runtime operation that can reach the configured OpenWA deployment

## Context

OpenWA is an external gateway and does not provide WA Studio with a complete, durable admission
boundary across message sends, synchronization, contact reads, pagination, webhook reconciliation,
and recovery probes. Per-worker delays are insufficient because multiple Runtime processes can race,
restarts erase in-memory counters, and a retry after an ambiguous network outcome can duplicate a
WhatsApp send. A campaign-only limiter would leave the same session exposed through direct Message
Jobs and background engines.

The protection must therefore be owned by WA Runtime, survive process and desktop restarts, remain
effective across worker replicas, and require no OpenWA source-code change.

## Decision

1. PostgreSQL is the authority for a three-level safety hierarchy: `WORKSPACE`, hashed OpenWA
   `UPSTREAM`, and `SESSION`. The most restrictive effective parent state always wins.
2. Every governed operation reserves durable GCRA-style buckets before entering OpenWA. Upstream
   buckets bound aggregate HTTP pressure; session buckets bound operation classes. Message sends
   additionally share `MESSAGE_SEND_ALL` pacing and minute/hour/day buckets so alternating text and
   image messages cannot multiply session throughput.
3. New sessions start in `CANARY`. `STANDARD` is an explicit operator promotion after a stable
   observation period. Image sends cost two units in shared session windows while one OpenWA HTTP
   request still costs one upstream unit.
4. Recipient frequency is calculated from durable `current_upstream_started_at` evidence, including
   failed and unknown post-dispatch outcomes. A failed or ambiguous attempt therefore cannot bypass
   the recipient window.
5. Only one message may own the `ACTIVE_SESSION` lease for a session. A message permit is not enough
   to send: immediately before the request, one database transaction rechecks the lease, policy
   version, parent circuits, session readiness/restriction, group capability, cancellation, and
   Campaign Run state, then durably records the upstream-start boundary.
6. An explicit safe rejection may finish without opening a circuit. OpenWA `429` creates adaptive
   throttling and cooldown. Repeated transient failures or ambiguous outcomes open the circuit.
   Exactly one `HALF_OPEN` recovery lease may probe an affected scope. A session restriction creates
   a durable manual block.
7. Permit outcomes are idempotent by permit token. Once an upstream request may have started, an
   uncertain result becomes `UNKNOWN`; Runtime never retries it blindly. Automatic message retry is
   limited to the explicitly reviewed `409` and `429` cases.
8. Adaptive rate pressure and recovery are scope-wide. A `429` slows every existing bucket in the
   affected upstream/session scope; each twenty-success recovery step relaxes the same complete scope
   toward its configured base rate.
9. Long-running background work preserves durable intent when admission is deferred. Pagination
   waits only inside the bounded request deadline. Webhook reconciliation reserves one conservative
   workflow permit costed for its maximum bounded list/update/delete sequence.
10. Operator block/resume and profile changes require idempotency keys, create mutation receipts and
    sanitized Activity events, and are exposed through authenticated Runtime endpoints and WA Studio
    Settings. Blocking prevents new commits but cannot recall an effect already submitted upstream.
11. The authenticated compatibility health probe is the sole OpenWA control-plane exception. It is
    independently bounded and must remain outside the governor so a circuit cannot prevent the probe
    required to observe recovery or a release mismatch.

## Initial policy envelopes

| Profile | Text pacing | Image pacing | Shared minute/hour/day | Recipient window | Image cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| `CANARY` | 15 seconds | 20 seconds | 3 / 20 / 50 | 1 per 6 hours | 2 |
| `STANDARD` | 10 seconds | 15 seconds | 5 / 40 / 100 | 2 per 6 hours | 2 |

The limits are admission ceilings, not delivery promises. OpenWA cooldown, session restriction,
Campaign Run state, group capability, and final-fence checks may lower effective throughput further.

## Persistence and rollout

- Migrations `060`–`065` introduce scopes, buckets, leases, send fencing, Campaign Run cancellation,
  database guards, mutation receipts, and outcome receipts.
- Migration `066` introduces the shared message budget and safety policy version 5 without rewriting
  an already-applied migration. It removes superseded per-content session window buckets; pacing
  buckets by content remain.
- OpenWA remains external and pinned through `release/components.json`. No OpenWA table, binary, or
  source file is changed by this decision.

## Consequences and limits

- Throughput is intentionally lower and burst work may remain durably deferred for a long period.
- Database availability is part of the outbound safety boundary; Runtime fails closed when it cannot
  obtain authoritative state.
- The governor reduces duplicate-send and rate-pressure risk but cannot guarantee that WhatsApp will
  not restrict a session. Consent, recipient quality, content, account reputation, and upstream
  platform policy remain external controls.
- A compatibility probe can still reach OpenWA while a session is blocked. It cannot send a message
  or mutate session business state.
- Policy changes require a new policy version, a forward migration when persisted bucket semantics
  change, contract/UI review when the public snapshot changes, and cross-content integration tests.

## Required verification

- parallel workers admit only one session message boundary and the safe paced slice of a burst;
- text and image share one session budget, with image charged at the reviewed cost;
- cancellation or manual block between reservation and dispatch fails the final fence;
- duplicate outcome callbacks have one effect;
- `429`, transient, ambiguous, restriction, cooldown, and half-open recovery paths are covered;
- every OpenWA adapter method is governed or is the documented compatibility-probe exception;
- fresh install and upgrade migrations pass Runtime integration tests and packaged desktop E2E;
- the generated Runtime contract, Studio controls, Activity presentation, and metrics remain in sync.
