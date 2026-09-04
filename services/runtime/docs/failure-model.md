# Failure model

PostgreSQL owns durable intent and business state. BullMQ is a transport optimization: deleting or
restarting Redis may delay work, but every non-terminal durable row must remain discoverable by the
scheduler.

## Implementation status

[ADR 001](adr/001-postgresql-owned-durable-work-execution.md) accepts PostgreSQL-owned retry and
attempt fencing as the target model. Database-owned retry and lease-token fencing are implemented
for webhook processing, gateway synchronization, campaign preparation and capability refresh.
Session-scoped sync epochs now fence full-sync domain writes, and PostgreSQL session leases serialize
outbound sends. The scheduler holds a dedicated PostgreSQL advisory-lock connection before starting
ticks, listeners or heartbeats. A second scheduler fails fast; losing the owning connection stops
the active runner. Worker replica count remains an operator-controlled rollout decision.

## Processing guarantees

Idempotent work such as webhook normalization, synchronization, capability refresh and campaign
preparation is processed at least once. In the accepted target model, repositories use unique
constraints, revision checks and token-owned database leases so replay is safe. A stale attempt is
not allowed to renew, complete, fail or mutate guarded domain data.

Session Sync Runs, their group Items, and targeted group Intents also have database-enforced legal
transition graphs and lifecycle-field invariants. Capability-refresh observation reads a separate
per-revision projection instead of the mutable scheduling Intent. A newer event may coalesce into the
same worker aggregate, but it cannot rewrite an older completed or failed operation returned by poll
or idempotent replay.

Message delivery cannot be exactly once because the pinned OpenWA send endpoint does not accept a
Runtime request identifier. A live job is therefore attempted once. If the worker loses its lease
after entering `PROCESSING`, the Runtime records `UNKNOWN` and never schedules an automatic resend.
An operator must resolve that ambiguity or create a new intent.

`ACCEPTED` is dispatch-complete but can still receive a definitive failed webhook, while `UNKNOWN`
can later receive attempt-bound accepted, sent, delivered, read, or failed evidence. Delivery reconciliation therefore keeps the
Campaign Run `COMPLETED`/`PARTIAL_FAILED` aggregate convergent with current durable delivery evidence.
Every correction is audited and side-effect free: it does not reopen the run or issue another send.

The implementation serializes outbound work with a token-owned PostgreSQL lease per session. A
waiting worker refreshes its message processing lease, and only the current session-lease owner may
start the OpenWA request or release the lease. At the final pre-send fence, both the session lease
and message processing lease are extended beyond the configured OpenWA request timeout with a fixed
safety margin, so another worker cannot acquire that session while the POST is still within its
allowed response window. After the configured pacing delay and while still holding that session
lease, the worker re-reads durable session sendability and group capability before the final
ownership check and outbound POST. Lease loss cannot make an unproven OpenWA result safe to retry.
After the outbound POST starts, HTTP 408, HTTP 5xx, transport failures and invalid success responses
become `UNKNOWN`; only explicit non-timeout HTTP 4xx responses prove rejection.

Session status and restriction projections are independently event-time fenced. A strictly older or
equal-time distinct event cannot overwrite the accepted observation, and a session snapshot follows
the same field-level ownership rule.

## Retry and ownership

PostgreSQL is the only retry authority in the accepted model. BullMQ jobs use one transport attempt;
processors persist bounded backoff or terminal exhaustion before the job is removed. A durable
attempt claim returns a random lease token. Renewal and state transitions require both running state
and the current token. A zero-row update means lost ownership, not successful completion or retry
exhaustion.

Gateway synchronization also uses a monotonically increasing epoch per session. At most one run per
session may be active. Discovery publishes the authoritative summary snapshot, then PostgreSQL-owned
per-group reconciliation items carry independent retry schedules and token-owned leases. Every
detail write verifies both the session epoch and item lease. Group data and parent progress are
incrementally published; a failed item does not replay completed siblings, and an older attempt
cannot write after a newer epoch begins.

Group webhooks use a separate revisioned targeted intent keyed by session and group. A duplicate
webhook event is rejected by event idempotency before it can advance the intent. An event arriving
while revision N runs advances the requested revision; N may publish its fenced authoritative read,
but completion returns the intent to `PENDING` for the newer revision. PostgreSQL notifications only
wake dispatch and are never considered evidence that an intent exists or completed.

Malformed successful OpenWA responses fail before durable domain writes. Group pagination is
bounded and treats duplicate IDs, oversized pages or a full page at the configured page limit as a
compatibility failure, preventing an unbounded or non-progressing synchronization loop.

## Durable dispatch

The scheduler rediscovers work from these PostgreSQL rows:

| Work | Dispatchable state | Expired lease behavior |
| --- | --- | --- |
| Webhook | `PENDING`, `RETRY` | Return to `RETRY`; eventually `DEAD` after bounded attempts. |
| Message job | Due `SCHEDULED` | `QUEUED` returns to `SCHEDULED`; `PROCESSING` becomes `UNKNOWN`. |
| Gateway sync | Due `PENDING` | Owning attempt returns to delayed `PENDING`; exhaustion becomes `FAILED`. |
| Group reconciliation | Due `PENDING` or `RETRY` | Owning item returns to `RETRY`; exhaustion becomes `FAILED` and finalizes parent progress. |
| Targeted group intent | Debounced `PENDING` or `RETRY` | Owning revision returns to `RETRY`; a newer requested revision returns to `PENDING`. |
| Campaign preparation | Due `PREPARING` | Owning attempt backs off durably; exhaustion becomes `FAILED`. |
| Campaign delivery | `PENDING` in a running run | Materialized from the durable delivery row. |

Queue job IDs are hashes of durable identities. They prevent concurrent duplicate publication but
are not leases, retry records or permanent idempotency keys; terminal truth remains in PostgreSQL.

## Failure isolation

The scheduler isolates failures between message, webhook, gateway and campaign ticks. The accepted
runner model gives each tick an interval, timeout, no-overlap guard and failure backoff. Feature
processors through repositories—not Bull event listeners or executable entrypoints—own state
transitions and side effects.

Worker startup takes ownership of each queue handle before creating the next one, so a later queue
startup failure closes every worker already created. Queue-worker close is idempotent and all
concurrent close callers await the same active-job drain; the transport does not disconnect its
shared queue connections until those drains settle.

HTTP entrypoint startup is rollback-safe. After Nest has created the API or Event Inbox application
context, a listener bind failure closes that context so database pools and module-owned resources do
not keep a failed process alive. If context close also fails, the startup and cleanup failures are
retained together for the process supervisor and logs.

Event Inbox expiry maintenance is single-flight. Interval ticks reuse an active cleanup instead of
starting overlapping database work, and module shutdown cancels future ticks and drains the active
cleanup before repository pools close.

Scheduler leadership is process-wide rather than tick-specific. The advisory lock prevents two
replicas from concurrently publishing the same durable work, while repository leases and unique
job IDs remain the per-item correctness fences. Leadership is deliberately fail-fast instead of
automatic in-process standby promotion; the process supervisor owns restart and retry policy.
Every scheduled or notification-triggered tick registers the same active-run ownership. During
shutdown, exceeding the graceful wait emits an operational warning but does not release scheduler
leadership; the lock remains held until active work settles or process termination closes the
dedicated PostgreSQL connection. Shutdown also disables the notification wake coordinator before
draining ticks, so a coalesced catch-up wake cannot start new scheduler work behind that drain.

A tick timeout emits telemetry but does not pretend to cancel an in-flight SQL or queue operation.
The tick remains guarded until that operation settles, then schedules bounded exponential backoff.
Other ticks continue on their own timers. Telemetry publication failure is logged and cannot change
the work outcome.

## Authorization invariant

Every public object access resolves to a session and checks the deployment session scope. Signed
webhooks for sessions outside `OPENWA_ALLOWED_SESSION_IDS` are rejected. Live low-level sends must
target an active synchronized group whose capability is currently `ALLOWED`; the worker repeats the
check immediately before calling OpenWA.

## Idempotency

Operator-triggered session sync, group capability refresh, and Campaign Run pause/resume/cancel use
immutable PostgreSQL mutation receipts. The receipt key is scoped by operation type and bound to a
canonical request hash. The receipt is inserted in the same transaction as the durable state change,
so neither the domain mutation nor its replay evidence can commit alone. A concurrent request with
the same operation/key waits on a transaction advisory lock and then replays the committed receipt;
reuse for a different target or payload is rejected. Successful run-action replay returns the current
canonical run without reapplying the historical transition. A resume rejected by preflight records
the rejection and report too, so the same key cannot become successful merely because capability
state changes later. Conflicts caused before a durable decision—such as a stale preflight input—do not
create a receipt and require a fresh operator intent.

Message idempotency is scoped. The Runtime stores a canonical request hash with each key. Repeating
the same scope, key and request returns the existing job; reusing the key for a different request is
a conflict. Campaign message jobs use a run-specific scope so client keys cannot collide with
campaign delivery keys. Terminal records are removed by configured operational retention, so
idempotency is guaranteed only while the original record remains within that retention window. Raw
webhook envelopes and normalized events use shorter, independent lifetimes and multi-batch bounded
draining as defined by [ADR 012](adr/012-event-ownership-and-bounded-storage.md).

Runtime mutation receipts have the same operational retention window. Cleanup removes expired
receipts before their old Session Sync or Campaign Run results and before unreferenced historical
capability-operation projections. The latest group reconciliation revision and every active revision
remain readable; a historical terminal revision remains readable for as long as a retained receipt
can replay it.

Campaign-run idempotency binds the key to execution mode and every supplied campaign/target
revision. LIVE additionally requires a signed, expiring preflight proof for new work. An exact replay
may authenticate that proof after expiry because it returns the existing durable run; it cannot
re-enter preparation or create a second send intent.
