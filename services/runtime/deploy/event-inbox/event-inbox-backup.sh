#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

deploy_dir="${EVENT_INBOX_DEPLOY_DIR:-/opt/wa-event-inbox}"
work_root="${EVENT_INBOX_BACKUP_WORK_DIR:-/var/lib/wa-event-inbox-backup}"
remote="${EVENT_INBOX_BACKUP_REMOTE:?EVENT_INBOX_BACKUP_REMOTE is required}"
recipient="${EVENT_INBOX_BACKUP_AGE_RECIPIENT:?EVENT_INBOX_BACKUP_AGE_RECIPIENT is required}"
compose_file="${deploy_dir}/compose.yaml"
environment_file="${deploy_dir}/event-inbox.env"

for command_name in age docker flock rclone sha256sum; do
  command -v "${command_name}" >/dev/null
done
test -f "${compose_file}"
test -f "${environment_file}"

install -d -m 0700 "${work_root}"
exec 9>"${work_root}/backup.lock"
flock -n 9

temporary_directory="$(mktemp -d "${work_root}/backup.XXXXXX")"
cleanup() {
  rm -f "${temporary_directory}/event-inbox.dump" \
    "${temporary_directory}"/*.dump.age \
    "${temporary_directory}"/*.sha256
  rmdir "${temporary_directory}" 2>/dev/null || true
}
trap cleanup EXIT

compose=(docker compose --env-file "${environment_file}" -f "${compose_file}")
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_name="wa-event-inbox-${timestamp}.dump.age"
checksum_name="${archive_name}.sha256"
dump_path="${temporary_directory}/event-inbox.dump"
archive_path="${temporary_directory}/${archive_name}"
checksum_path="${temporary_directory}/${checksum_name}"
remote_root="${remote%/}"

"${compose[@]}" exec -T postgres sh -ceu \
  'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-privileges' \
  > "${dump_path}"
test -s "${dump_path}"
"${compose[@]}" exec -T postgres pg_restore --list < "${dump_path}" >/dev/null

age --encrypt --recipient "${recipient}" --output "${archive_path}" "${dump_path}"
test -s "${archive_path}"
(
  cd "${temporary_directory}"
  sha256sum "${archive_name}" > "${checksum_name}"
)

rclone copyto "${archive_path}" "${remote_root}/${archive_name}.partial"
local_digest="$(sha256sum "${archive_path}" | awk '{print $1}')"
remote_digest="$(rclone cat "${remote_root}/${archive_name}.partial" | sha256sum | awk '{print $1}')"
test "${remote_digest}" = "${local_digest}"
rclone moveto "${remote_root}/${archive_name}.partial" "${remote_root}/${archive_name}"
rclone copyto "${checksum_path}" "${remote_root}/${checksum_name}"

printf 'Event Inbox backup uploaded: %s sha256=%s\n' "${archive_name}" "${local_digest}"
