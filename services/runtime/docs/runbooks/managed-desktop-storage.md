# Managed desktop storage lifecycle

This runbook applies only to the `desktop-managed` Runtime profile. Server deployments keep their
configured message history and retention policy.

## Data classes

| Class | Examples | Recovery rule |
| --- | --- | --- |
| Durable domain state | sessions, groups, lists, campaigns, runs, deliveries, safety state | Included in every logical backup |
| Delivery evidence | message jobs, attempts, projection state, mutation receipts | Included until normal retention expires it |
| Active transient work | unprocessed/dead webhooks, queue work, projection intents | Included so restore does not silently lose admitted work |
| Rebuildable/expired data | processed raw webhooks, disabled inbox bodies, expired receipts | Removed by policy before backup |

The backup archive remains one transactionally consistent logical snapshot. The manifest records
the included classes; splitting them into independently restorable archives would create invalid
cross-class revisions and is intentionally unsupported.

## Policy rollout

Storage policy version 1 runs from the normal retention tick and is restart-safe:

1. Delete `inbound_messages` in bounded batches when message storage is disabled.
2. Delete the matching `message.received` Runtime ledger rows. Contact observation intents are
   independent and continue processing.
3. Convert legacy processed webhook rows to compact idempotency receipts, then delete their raw
   payloads in the same transaction.
4. Accumulate progress in `runtime_storage_policy_state` and mark `LOGICALLY_COMPACT` only after all
   three queues return a short final batch.

Observe `wa_runtime_storage_policy_state` and `wa_runtime_storage_policy_rows_removed`. Repeated
`DRAINING` is expected for a large legacy database. A failed batch rolls back without advancing the
checkpoint and the next scheduler tick resumes it.

Event Inbox events are acknowledged only after the local raw spool transaction commits. If the
spool reaches its count or byte quota, Runtime returns backpressure and Event Inbox retains the
event for retry.

## Logical cleanup versus disk returned to macOS

Batch deletion makes PostgreSQL pages reusable and stops future growth, but it does not immediately
shrink relation files. Do not run `VACUUM FULL` on a managed workstation database: it takes
exclusive locks and can require another table-sized allocation.

To return already allocated space to the filesystem:

1. Wait for `wa_runtime_storage_policy_state{phase="logically_compact",version="1"} 1`.
2. Create a manual recovery point in **Settings → Backup & recovery**.
3. Confirm the new archive and its `.manifest.json` sidecar exist and that the UI reports success.
4. Restore that same recovery point during a maintenance window. WA Studio stops Runtime, creates a
   separate pre-restore safety point, verifies the archive manifest and encrypted dump, recreates
   the logical tables, and starts Runtime again.
5. Verify Runtime readiness, session state, group counts, campaign history, and pending work before
   rotating older safety points.

The restore should be postponed when filesystem pressure is critical. A logical restore needs room
for the compact live dataset while PostgreSQL still retains old relation files until commit.

## Backup integrity

New managed recovery points have a versioned sidecar manifest containing the archive identity,
kind, timestamp, byte length, storage policy version, data classes, and SHA-256 of the encrypted
archive. WA Studio verifies the checksum before staging or restoring it. Legacy archives without a
manifest remain restorable through the existing authenticated `age` and `pg_restore --list`
verification path.

Portable passphrase archives remain self-contained and do not depend on an on-device sidecar.
