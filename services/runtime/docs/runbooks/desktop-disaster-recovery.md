# Desktop managed-Runtime disaster recovery

This runbook applies only to PostgreSQL managed by WA Studio. OpenWA and the public Event Inbox have
separate data stores and recovery procedures.

## Before risky work

1. Open **Settings → Encrypted database backups** and create a manual backup.
2. Confirm the new recovery point is listed with a non-zero size.
3. For device replacement, filesystem work, or any incident that can affect both the Mac and its
   keychain, export a portable Runtime archive.
4. Store the archive away from the Mac and store its passphrase in a different protected system.
5. Do not start the work until both artifacts have been verified by WA Studio.

Local recovery points are retained by class: seven rolling, five manual, and three for each
maintenance safety class. A rolling point is created at startup only when no managed backup is less
than 24 hours old. Existing clusters also run bundled `pg_amcheck` at most once every seven days;
any corruption finding blocks migration and Runtime startup and leaves the application degraded.

## Restore while Runtime is healthy

Use a local recovery point for same-device rollback. WA Studio stops the Runtime, creates a
`pre-restore` safety point, restores in one PostgreSQL transaction, and starts the stack again. Use
**Portable Runtime archive → Import and restore** for an off-device archive. The operation is not
complete until the application reconnects and Runtime is operational.

After recovery, verify:

- the expected sessions, campaigns, runs, audit events, and idempotency outcomes are present;
- Runtime operational health names the current desktop supervisor generation;
- PostgreSQL queue, worker, and scheduler health are ready;
- no LIVE campaign is resumed without a fresh operator review and preflight.

## Recover from degraded startup

The setup/repair screen lists local recovery points even when Runtime cannot start. Select the
newest recovery point whose timestamp precedes the incident and confirm **Quarantine and restore**.
WA Studio copies the archive to protected temporary staging, renames the failed PostgreSQL root to a
`postgresql-stale-<timestamp>` sibling, creates a clean cluster, restores transactionally, and then
starts migrations and Runtime.

If restore fails, do not reset again or delete either directory. Record the native error, preserve
the selected archive and every `postgresql-stale-*` directory, and retry with an older verified
recovery point. A wrong device key, tampered archive, insufficient disk, or failed PostgreSQL binary
must fail without modifying the quarantined original.

## Empty reset

Use empty database reset only when no usable recovery point exists and business owners explicitly
accept loss of Runtime-owned state. Reset quarantines the old PostgreSQL root; it does not delete it.
The supervisor refuses reset if `WA_DESKTOP_BACKUP_ROOT` is nested under
`WA_DESKTOP_POSTGRES_ROOT`, because reset would otherwise move the only visible backups together
with the failed cluster.

## Drill cadence

At least quarterly and before a major storage or PostgreSQL change:

1. export a new portable archive from a non-production copy;
2. restore it into an isolated, freshly provisioned WA Studio profile;
3. compare aggregate counts for campaigns, runs, deliveries, audit events, and idempotency records;
4. verify operational health and run a DRY_RUN campaign;
5. record archive timestamp, restore duration, Runtime/Studio versions, and discrepancies;
6. securely remove the isolated profile and drill artifacts only after the report is accepted.

Never validate disaster recovery by restoring over the only production copy.
