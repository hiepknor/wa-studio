# ADR 017: Layered disaster recovery for desktop-managed PostgreSQL

- Status: Accepted
- Date: 2026-08-23
- Applies to: WA Studio native supervisor and desktop-managed PostgreSQL

## Context

WA Studio already created device-encrypted logical backups before Runtime migrations, application
updates, and database restores. Each archive was authenticated by `age` and inspected by the bundled
`pg_restore --list`; restore used `--single-transaction`. This protected planned maintenance, but it
did not bound ordinary data loss, give an operator a manual recovery point, survive loss of the
device key, or offer recovery while startup was degraded.

The Runtime database contains business intent, audit history, idempotency records, leases, and
delivery outcomes. Rebuilding an empty database after corruption is therefore a last resort, not a
normal repair path.

## Decision

1. A successful desktop startup creates a verified rolling logical backup when no managed recovery
   point was created in the previous 24 hours. Operators can create additional manual recovery
   points while Runtime is ready.
2. Local backups use an `age` X25519 identity held by the native secret store. The identity and
   PostgreSQL credentials never cross the native/webview boundary.
3. Backup retention is tiered so one noisy class cannot evict another: seven rolling, five manual,
   and three per safety class (`pre-migration`, `pre-update`, and `pre-restore`). Unknown files are
   never rotated.
4. Before migration or Runtime launch, an existing cluster runs the bundled `pg_amcheck` when its
   last successful integrity marker is at least seven days old. It checks supported heap, TOAST,
   sequence, materialized-view, and B-tree relations with one connection and stops the startup on a
   corruption finding. Stronger parent/root-descend options are not enabled because they take locks
   that can block writes.
5. A portable recovery archive uses independent `age` scrypt encryption with a 16–1024 character
   operator passphrase. WA Studio does not persist that passphrase. Export writes a unique partial
   file with mode `0600`, verifies the complete authenticated stream with bundled
   `pg_restore --list`, atomically renames it, and syncs the containing directory.
6. Normal local and portable restores authenticate and inspect the archive first, take a fresh
   device-encrypted safety backup, stop Runtime processes, and apply `pg_restore --clean
   --if-exists --single-transaction` before restarting the managed stack.
7. A degraded local restore stages the selected archive outside the PostgreSQL root, quarantines
   the failed root by an atomic sibling rename, provisions a clean cluster, authenticates and
   restores the staged archive transactionally, and retains the selected recovery point. Neither
   the failed cluster nor a managed backup is deleted.
8. Backup directories must be outside the PostgreSQL root. The supervisor refuses a degraded reset
   when an environment override violates this boundary.

## Recovery objectives

- Desktop rolling-backup RPO: at most 24 hours while the application is opened successfully at
  least once per day.
- Planned-maintenance RPO: the immediately preceding verified safety point.
- Portable/off-device RPO: the time of the last operator export.
- RTO: operator-driven and hardware-dependent; the restore is considered complete only after the
  migrated Runtime reports operational health for the new supervisor generation.

These are product objectives, not a substitute for an organizational backup policy. A portable
archive and its passphrase must be stored in separate failure domains.

## Consequences

- Local rollback is automatic and convenient but cannot recover from simultaneous device and
  keychain loss.
- Portable archives can recover on another provisioned device, but loss of their passphrase is
  intentionally unrecoverable.
- Logical restore preserves schema/data consistency and the Runtime's audit and idempotency rows;
  it does not restore OpenWA, which has a separate lifecycle and data store.
- Quarantined clusters consume disk until an operator validates recovery and removes them under an
  explicit retention procedure.

## Required verification

- a real bundled PostgreSQL drill must prove device-key and passphrase dump/restore round trips;
- tiered rotation must retain every recovery class independently;
- path traversal, symlinks, partial archives, wrong passphrases, and tampering must fail closed;
- packaged E2E must restart an existing managed database and observe a non-empty authenticated
  encrypted backup;
- degraded restore must leave the original database root quarantined and restart only after a
  successful transactional restore.
