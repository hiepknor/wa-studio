#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

deploy_dir="${EVENT_INBOX_DEPLOY_DIR:-/opt/wa-event-inbox}"
work_root="${EVENT_INBOX_BACKUP_WORK_DIR:-/var/lib/wa-event-inbox-backup}"
remote="${EVENT_INBOX_BACKUP_REMOTE:?EVENT_INBOX_BACKUP_REMOTE is required}"
identity_file="${EVENT_INBOX_BACKUP_AGE_IDENTITY_FILE:?EVENT_INBOX_BACKUP_AGE_IDENTITY_FILE is required}"
compose_file="${deploy_dir}/compose.yaml"
environment_file="${deploy_dir}/event-inbox.env"

for command_name in age docker flock rclone sha256sum; do
  command -v "${command_name}" >/dev/null
done
test -f "${identity_file}"
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
compose=(docker compose --env-file "${environment_file}" -f "${compose_file}")

cleanup() {
  if [[ "${created_database}" = true ]]; then
    "${compose[@]}" exec -T postgres sh -ceu \
      'dropdb --username "$POSTGRES_USER" --if-exists --force "$1"' sh "${drill_database}" \
      >/dev/null 2>&1 || true
  fi
  rm -f "${temporary_directory}/${archive_name}" \
    "${temporary_directory}/${checksum_name}" \
    "${temporary_directory}/event-inbox.dump"
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

verification_sql="SELECT CASE WHEN
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
  THEN 'ok' ELSE 'invalid' END"
verification="$("${compose[@]}" exec -T postgres sh -ceu \
  'exec psql --username "$POSTGRES_USER" --dbname "$1" --no-align --tuples-only --set ON_ERROR_STOP=1 --command "$2"' \
  sh "${drill_database}" "${verification_sql}")"
test "${verification}" = "ok"

printf 'Event Inbox restore drill passed: %s\n' "${archive_name}"
