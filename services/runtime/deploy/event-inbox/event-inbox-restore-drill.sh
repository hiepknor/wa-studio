#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

deploy_dir="${EVENT_INBOX_DEPLOY_DIR:-/opt/wa-event-inbox}"
work_root="${EVENT_INBOX_BACKUP_WORK_DIR:-/var/lib/wa-event-inbox-backup}"
metrics_directory="${EVENT_INBOX_BACKUP_METRICS_DIR:-/var/lib/node-exporter/textfile}"
evidence_directory="${EVENT_INBOX_RESTORE_EVIDENCE_DIR:-${work_root}/evidence}"
remote="${EVENT_INBOX_BACKUP_REMOTE:?EVENT_INBOX_BACKUP_REMOTE is required}"
identity_file="${EVENT_INBOX_BACKUP_AGE_IDENTITY_FILE:?EVENT_INBOX_BACKUP_AGE_IDENTITY_FILE is required}"
deployment_manifest="${EVENT_INBOX_DEPLOYMENT_MANIFEST:?EVENT_INBOX_DEPLOYMENT_MANIFEST is required}"
compose_file="${deploy_dir}/compose.yaml"
environment_file="${deploy_dir}/event-inbox.env"

for command_name in age docker flock jq rclone sha256sum; do
  command -v "${command_name}" >/dev/null
done
test -f "${identity_file}"
test -f "${deployment_manifest}"
test -f "${compose_file}"
test -f "${environment_file}"

install -d -m 0700 "${work_root}"
exec 9>"${work_root}/restore-drill.lock"
flock -n 9

remote_root="${remote%/}"
archive_name="${1:-}"
if [[ -z "${archive_name}" ]]; then
  checksum_name="$(rclone lsf "${remote_root}" --files-only --include 'wa-event-inbox-*.dump.age.sha256' \
    | LC_ALL=C sort | tail -n 1)"
  test -n "${checksum_name}"
  archive_name="${checksum_name%.sha256}"
fi
if [[ ! "${archive_name}" =~ ^wa-event-inbox-[0-9]{8}T[0-9]{6}Z\.dump\.age$ ]]; then
  printf 'Invalid Event Inbox backup name: %s\n' "${archive_name}" >&2
  exit 1
fi
checksum_name="${archive_name}.sha256"

temporary_directory="$(mktemp -d "${work_root}/restore.XXXXXX")"
timestamp="$(date -u +%Y%m%d%H%M%S)"
drill_database="wa_event_inbox_restore_${timestamp}_$$"
created_database=false
evidence_temporary=""
compose=(docker compose --env-file "${environment_file}" -f "${compose_file}")
started_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
started_epoch="$(date -u +%s)"
deployment_snapshot="${temporary_directory}/wa-studio-deployment.json"
install -m 0600 "${deployment_manifest}" "${deployment_snapshot}"

cleanup() {
  if [[ "${created_database}" = true ]]; then
    "${compose[@]}" exec -T postgres sh -ceu \
      'dropdb --username "$POSTGRES_USER" --if-exists --force "$1"' sh "${drill_database}" \
      >/dev/null 2>&1 || true
  fi
  rm -f "${temporary_directory}/${archive_name}" \
    "${temporary_directory}/${checksum_name}" \
    "${temporary_directory}/event-inbox.dump" \
    "${deployment_snapshot}"
  if [[ -n "${evidence_temporary}" ]]; then
    rm -f "${evidence_temporary}"
  fi
  rmdir "${temporary_directory}" 2>/dev/null || true
}
trap cleanup EXIT

rclone copyto "${remote_root}/${archive_name}" "${temporary_directory}/${archive_name}"
rclone copyto "${remote_root}/${checksum_name}" "${temporary_directory}/${checksum_name}"
(
  cd "${temporary_directory}"
  sha256sum --check "${checksum_name}"
)
age --decrypt --identity "${identity_file}" \
  --output "${temporary_directory}/event-inbox.dump" \
  "${temporary_directory}/${archive_name}"
"${compose[@]}" exec -T postgres pg_restore --list \
  < "${temporary_directory}/event-inbox.dump" >/dev/null

"${compose[@]}" exec -T postgres sh -ceu \
  'createdb --username "$POSTGRES_USER" "$1"' sh "${drill_database}"
created_database=true
"${compose[@]}" exec -T postgres sh -ceu \
  'exec pg_restore --username "$POSTGRES_USER" --dbname "$1" --exit-on-error --no-owner --no-privileges' \
  sh "${drill_database}" < "${temporary_directory}/event-inbox.dump"

verification_sql="SELECT concat(CASE WHEN
  to_regclass('public.event_inbox_events') IS NOT NULL
  AND to_regclass('public.event_inbox_usage') IS NOT NULL
  AND to_regclass('public.event_inbox_devices') IS NOT NULL
  AND to_regclass('public.event_inbox_session_owners') IS NOT NULL
  AND to_regclass('public.event_inbox_rate_limits') IS NOT NULL
  AND EXISTS (SELECT 1 FROM schema_migrations WHERE name = '003_pairing_rate_limits.sql')
  AND (SELECT stored_events FROM event_inbox_usage WHERE singleton = true)
    = (SELECT count(*) FROM event_inbox_events)
  AND (SELECT stored_bytes FROM event_inbox_usage WHERE singleton = true)
    = (SELECT COALESCE(sum(storage_bytes), 0) FROM event_inbox_events)
  THEN 'ok' ELSE 'invalid' END, '|', COALESCE((SELECT max(name) FROM schema_migrations), 'missing'))"
verification="$("${compose[@]}" exec -T postgres sh -ceu \
  'exec psql --username "$POSTGRES_USER" --dbname "$1" --no-align --tuples-only --set ON_ERROR_STOP=1 --command "$2"' \
  sh "${drill_database}" "${verification_sql}")"
verification_status="${verification%%|*}"
restored_migration_head="${verification#*|}"
test "${verification_status}" = "ok"
if [[ ! "${restored_migration_head}" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]; then
  printf 'Invalid restored migration head: %s\n' "${restored_migration_head}" >&2
  exit 1
fi

archive_sha256="$(awk 'NR == 1 { print $1 }' "${temporary_directory}/${checksum_name}")"
deployment_manifest_sha256="$(sha256sum "${deployment_snapshot}" | awk '{print $1}')"
for digest in "${archive_sha256}" "${deployment_manifest_sha256}"; do
  if [[ ! "${digest}" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'Invalid recovery evidence digest.\n' >&2
    exit 1
  fi
done
completed_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
completed_epoch="$(date -u +%s)"
duration_seconds="$((completed_epoch - started_epoch))"
install -d -m 0700 "${evidence_directory}"
evidence_path="${evidence_directory}/wa-event-inbox-restore-drill-${timestamp}.json"
evidence_temporary="$(mktemp "${evidence_path}.XXXXXX")"
chmod 0600 "${evidence_temporary}"
jq --exit-status \
  --arg restored_migration_head "${restored_migration_head}" \
  '.schemaVersion == 1
    and .product == "wa-studio"
    and .releaseScope == "product"
    and (.repository | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
    and (.tag | test("^v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$"))
    and (.gitCommit | test("^[0-9a-f]{40}$"))
    and (.components.eventInbox.imageDigest | test("^sha256:[0-9a-f]{64}$"))
    and (.components.eventInbox.migrationHead.setSha256 | test("^[0-9a-f]{64}$"))
    and .components.eventInbox.migrationHead.name == $restored_migration_head' \
  "${deployment_snapshot}" >/dev/null
jq --null-input \
  --slurpfile deployment "${deployment_snapshot}" \
  --arg recorded_at "${completed_at}" \
  --arg deployment_sha256 "${deployment_manifest_sha256}" \
  --arg archive_name "${archive_name}" \
  --arg archive_sha256 "${archive_sha256}" \
  --arg started_at "${started_at}" \
  --arg completed_at "${completed_at}" \
  --argjson duration_seconds "${duration_seconds}" \
  --arg restored_migration_head "${restored_migration_head}" \
  '{
    schemaVersion: 1,
    evidenceType: "wa-studio-event-inbox-restore-drill",
    recordedAt: $recorded_at,
    release: {
      repository: $deployment[0].repository,
      tag: $deployment[0].tag,
      gitCommit: $deployment[0].gitCommit,
      deploymentManifestSha256: $deployment_sha256,
      eventInboxImageDigest: $deployment[0].components.eventInbox.imageDigest,
      eventInboxMigrationHead: $restored_migration_head,
      eventInboxMigrationSetSha256: $deployment[0].components.eventInbox.migrationHead.setSha256
    },
    backup: { objectKey: $archive_name, sha256: $archive_sha256 },
    restore: {
      startedAt: $started_at,
      completedAt: $completed_at,
      durationSeconds: $duration_seconds,
      isolation: "temporary-database",
      restoredMigrationHead: $restored_migration_head,
      checksumVerified: true,
      archiveCatalogVerified: true,
      schemaVerified: true,
      usageLedgerVerified: true
    },
    result: "PASS"
  }' > "${evidence_temporary}"
( set -o noclobber; : > "${evidence_path}" )
mv -f "${evidence_temporary}" "${evidence_path}"

install -d -m 0755 "${metrics_directory}"
metrics_path="${metrics_directory}/wa-event-inbox-restore-drill.prom"
metrics_temporary="$(mktemp "${metrics_path}.XXXXXX")"
printf 'wa_event_inbox_restore_drill_last_success_timestamp_seconds %s\n' "$(date -u +%s)" \
  > "${metrics_temporary}"
chmod 0644 "${metrics_temporary}"
mv -f "${metrics_temporary}" "${metrics_path}"

printf 'Event Inbox restore drill passed: %s evidence=%s\n' "${archive_name}" "${evidence_path}"
