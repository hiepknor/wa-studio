use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use age::{x25519, Decryptor, Encryptor};
use fs2::FileExt;
use postgresql_embedded::{blocking::PostgreSQL, SettingsBuilder, Status};

use super::model::ManagedRuntimeBackup;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const DATABASE_NAME: &str = "wa_runtime";
const BACKUP_RETENTION_COUNT: usize = 7;

pub struct ManagedPostgres {
    postgresql: PostgreSQL,
    database_url: String,
    database_preexisting: bool,
    _root_lock: File,
}

impl ManagedPostgres {
    pub fn start(root: &Path, password: String) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| {
            format!(
                "Could not create managed PostgreSQL directory {}: {error}",
                root.display()
            )
        })?;
        let root_lock = acquire_root_lock(root)?;
        let password_file = root.join("initdb-password");
        let settings = SettingsBuilder::new()
            .installation_dir(root.join("installations"))
            .data_dir(root.join("data-v17"))
            .password_file(&password_file)
            .host("127.0.0.1")
            .port(0)
            .username("postgres")
            .password(password)
            .temporary(false)
            .timeout(Some(Duration::from_secs(60)))
            .config("listen_addresses", "127.0.0.1")
            .config("max_connections", "40")
            .config("shared_buffers", "64MB")
            .config("max_wal_size", "512MB")
            .config("log_min_messages", "warning")
            .build();
        let mut postgresql = PostgreSQL::new(settings);
        let setup_result = postgresql.setup();
        let _ = fs::remove_file(&password_file);
        setup_result.map_err(|error| format!("Could not provision managed PostgreSQL: {error}"))?;
        if postgresql.status() == Status::Started {
            eprintln!(
                "[managed-postgres] Recovering a PostgreSQL process left by an earlier app exit."
            );
            postgresql.stop().map_err(|error| {
                format!("Could not stop the previously orphaned managed PostgreSQL: {error}")
            })?;
        }
        postgresql
            .start()
            .map_err(|error| format!("Could not start managed PostgreSQL: {error}"))?;
        let database_url = postgresql.settings().url(DATABASE_NAME);
        let mut managed = Self {
            postgresql,
            database_url,
            database_preexisting: false,
            _root_lock: root_lock,
        };
        let database_preexisting = managed
            .postgresql
            .database_exists(DATABASE_NAME)
            .map_err(|error| format!("Could not inspect the managed Runtime database: {error}"))?;
        if !database_preexisting {
            managed
                .postgresql
                .create_database(DATABASE_NAME)
                .map_err(|error| {
                    format!("Could not create the managed Runtime database: {error}")
                })?;
        }
        managed.database_preexisting = database_preexisting;
        Ok(managed)
    }

    pub fn database_url(&self) -> &str {
        &self.database_url
    }

    pub fn database_preexisting(&self) -> bool {
        self.database_preexisting
    }

    pub fn create_release_backup(
        &self,
        backup_directory: &Path,
        release_version: &str,
        identity: &x25519::Identity,
    ) -> Result<Option<PathBuf>, String> {
        if !self.database_preexisting {
            return Ok(None);
        }
        fs::create_dir_all(backup_directory).map_err(|error| {
            format!(
                "Could not create managed PostgreSQL backup directory {}: {error}",
                backup_directory.display()
            )
        })?;
        let version = safe_filename_component(release_version);
        let prefix = format!("pre-migration-v{version}-");
        if backup_exists(backup_directory, &prefix)? {
            return Ok(None);
        }
        self.create_encrypted_backup(backup_directory, &prefix, identity, true)
            .map(Some)
    }

    pub fn restore_backup(
        &self,
        backup_directory: &Path,
        backup_id: &str,
        release_version: &str,
        identity: &x25519::Identity,
    ) -> Result<PathBuf, String> {
        let source = resolve_managed_backup(backup_directory, backup_id)?;
        self.verify_encrypted_dump(&source, identity)?;
        let prefix = format!("pre-restore-v{}-", safe_filename_component(release_version));
        let safety_backup =
            self.create_encrypted_backup(backup_directory, &prefix, identity, false)?;
        self.restore_encrypted_dump(&source, identity)?;
        rotate_backups(backup_directory)?;
        Ok(safety_backup)
    }

    pub fn create_update_backup(
        &self,
        backup_directory: &Path,
        current_version: &str,
        target_version: &str,
        identity: &x25519::Identity,
    ) -> Result<PathBuf, String> {
        let prefix = format!(
            "pre-update-v{}-to-v{}-",
            safe_filename_component(current_version),
            safe_filename_component(target_version),
        );
        self.create_encrypted_backup(backup_directory, &prefix, identity, true)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.postgresql
            .stop()
            .map_err(|error| format!("Could not stop managed PostgreSQL: {error}"))
    }

    fn write_encrypted_dump(
        &self,
        destination: &Path,
        identity: &x25519::Identity,
    ) -> Result<(), String> {
        let settings = self.postgresql.settings();
        let pg_dump = settings.binary_dir().join(postgres_binary("pg_dump"));
        let mut child = Command::new(&pg_dump)
            .args([
                "--format=custom",
                "--no-owner",
                "--no-privileges",
                "--no-password",
                "--dbname",
                DATABASE_NAME,
                "--host",
                settings.host.as_str(),
                "--port",
                &settings.port.to_string(),
                "--username",
                settings.username.as_str(),
            ])
            .env("PGPASSWORD", &settings.password)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start bundled pg_dump: {error}"))?;
        let copy_result = (|| -> Result<(), String> {
            let mut plaintext = child
                .stdout
                .take()
                .ok_or_else(|| "Could not capture bundled pg_dump output.".to_string())?;
            let output = secure_file(destination)
                .map(BufWriter::new)
                .map_err(|error| format!("Could not create encrypted backup: {error}"))?;
            let recipient = identity.to_public();
            let encryptor =
                Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
                    .map_err(|error| format!("Could not initialize backup encryption: {error}"))?;
            let mut encrypted = encryptor
                .wrap_output(output)
                .map_err(|error| format!("Could not write backup encryption header: {error}"))?;
            io::copy(&mut plaintext, &mut encrypted)
                .map_err(|error| format!("Could not encrypt PostgreSQL backup: {error}"))?;
            let mut output = encrypted
                .finish()
                .map_err(|error| format!("Could not finalize PostgreSQL backup: {error}"))?;
            output
                .flush()
                .map_err(|error| format!("Could not flush PostgreSQL backup: {error}"))?;
            output
                .get_ref()
                .sync_all()
                .map_err(|error| format!("Could not sync PostgreSQL backup: {error}"))?;
            Ok(())
        })();
        if copy_result.is_err() {
            let _ = child.kill();
        }
        let output = child
            .wait_with_output()
            .map_err(|error| format!("Could not wait for bundled pg_dump: {error}"))?;
        copy_result?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "Bundled pg_dump failed.".to_string()
            } else {
                format!("Bundled pg_dump failed: {stderr}")
            });
        }
        Ok(())
    }

    fn create_encrypted_backup(
        &self,
        backup_directory: &Path,
        prefix: &str,
        identity: &x25519::Identity,
        rotate_after: bool,
    ) -> Result<PathBuf, String> {
        fs::create_dir_all(backup_directory).map_err(|error| {
            format!(
                "Could not create managed PostgreSQL backup directory {}: {error}",
                backup_directory.display()
            )
        })?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("System clock cannot timestamp a database backup: {error}"))?
            .as_millis();
        let final_path = backup_directory.join(format!("{prefix}{timestamp}.dump.age"));
        let partial_path = backup_directory.join(format!("{prefix}{timestamp}.dump.age.partial"));
        if let Err(error) = self.write_encrypted_dump(&partial_path, identity) {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
        if let Err(error) = self.verify_encrypted_dump(&partial_path, identity) {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
        fs::rename(&partial_path, &final_path).map_err(|error| {
            format!(
                "Could not commit PostgreSQL backup {}: {error}",
                final_path.display()
            )
        })?;
        if rotate_after {
            rotate_backups(backup_directory)?;
        }
        Ok(final_path)
    }

    fn verify_encrypted_dump(
        &self,
        source: &Path,
        identity: &x25519::Identity,
    ) -> Result<(), String> {
        let encrypted = File::open(source)
            .map(BufReader::new)
            .map_err(|error| format!("Could not open encrypted PostgreSQL backup: {error}"))?;
        let decryptor = Decryptor::new(encrypted)
            .map_err(|error| format!("Could not parse encrypted PostgreSQL backup: {error}"))?;
        let mut plaintext = decryptor
            .decrypt(std::iter::once(identity as &dyn age::Identity))
            .map_err(|error| format!("Could not decrypt PostgreSQL backup: {error}"))?;
        self.run_pg_restore(
            &mut plaintext,
            &["--list"],
            "Encrypted PostgreSQL backup verification",
        )
    }

    fn restore_encrypted_dump(
        &self,
        source: &Path,
        identity: &x25519::Identity,
    ) -> Result<(), String> {
        let encrypted = File::open(source)
            .map(BufReader::new)
            .map_err(|error| format!("Could not open encrypted PostgreSQL backup: {error}"))?;
        let decryptor = Decryptor::new(encrypted)
            .map_err(|error| format!("Could not parse encrypted PostgreSQL backup: {error}"))?;
        let mut plaintext = decryptor
            .decrypt(std::iter::once(identity as &dyn age::Identity))
            .map_err(|error| format!("Could not decrypt PostgreSQL backup: {error}"))?;
        self.run_pg_restore(
            &mut plaintext,
            &[
                "--clean",
                "--if-exists",
                "--single-transaction",
                "--no-owner",
                "--no-privileges",
                "--dbname",
                DATABASE_NAME,
            ],
            "Encrypted PostgreSQL backup restore",
        )
    }

    fn run_pg_restore(
        &self,
        plaintext: &mut dyn Read,
        arguments: &[&str],
        operation: &str,
    ) -> Result<(), String> {
        let settings = self.postgresql.settings();
        let pg_restore = settings.binary_dir().join(postgres_binary("pg_restore"));
        let mut child = Command::new(&pg_restore)
            .args(arguments)
            .args([
                "--host",
                settings.host.as_str(),
                "--port",
                &settings.port.to_string(),
                "--username",
                settings.username.as_str(),
            ])
            .env("PGPASSWORD", &settings.password)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start bundled pg_restore: {error}"))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Could not capture bundled pg_restore errors.".to_string())?;
        let stderr_reader = std::thread::spawn(move || {
            let mut output = String::new();
            let result = stderr.read_to_string(&mut output);
            (result, output)
        });
        let copy_result = child
            .stdin
            .take()
            .ok_or_else(|| "Could not open bundled pg_restore input.".to_string())
            .and_then(|mut input| stream_archive_to(plaintext, &mut input, operation));
        if copy_result.is_err() {
            let _ = child.kill();
        }
        let status = child
            .wait()
            .map_err(|error| format!("Could not wait for bundled pg_restore: {error}"))?;
        let (stderr_result, stderr) = stderr_reader
            .join()
            .map_err(|_| "Bundled pg_restore error reader panicked.".to_string())?;
        stderr_result
            .map_err(|error| format!("Could not read bundled pg_restore errors: {error}"))?;
        if !status.success() {
            let stderr = stderr.trim();
            return Err(if stderr.is_empty() {
                format!("{operation} failed.")
            } else {
                format!("{operation} failed: {stderr}")
            });
        }
        copy_result?;
        Ok(())
    }
}

impl Drop for ManagedPostgres {
    fn drop(&mut self) {
        if self.postgresql.status() == Status::Started {
            let _ = self.postgresql.stop();
        }
    }
}

fn postgres_binary(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn secure_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path)
}

fn stream_archive_to(
    plaintext: &mut dyn Read,
    output: &mut dyn Write,
    operation: &str,
) -> Result<(), String> {
    match io::copy(plaintext, output) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
            // `pg_restore --list` may finish after reading the archive table of contents and
            // close stdin before the data blocks arrive. Drain the decrypted stream so age still
            // authenticates the complete backup instead of treating that successful early exit
            // as a corrupt archive.
            io::copy(plaintext, &mut io::sink())
                .map(|_| ())
                .map_err(|error| format!("{operation} could not authenticate its archive: {error}"))
        }
        Err(error) => Err(format!("{operation} could not stream its archive: {error}")),
    }
}

fn acquire_root_lock(root: &Path) -> Result<File, String> {
    let path = root.join("managed-postgres.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(&path).map_err(|error| {
        format!(
            "Could not open the managed PostgreSQL lifecycle lock {}: {error}",
            path.display()
        )
    })?;
    file.try_lock_exclusive().map_err(|error| {
        format!(
            "Managed PostgreSQL at {} is already owned by another WA Studio process: {error}",
            root.display()
        )
    })?;
    Ok(file)
}

fn safe_filename_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn backup_exists(directory: &Path, prefix: &str) -> Result<bool, String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect PostgreSQL backups: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not inspect PostgreSQL backup: {error}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(".dump.age") {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn list_backups(directory: &Path) -> Result<Vec<ManagedRuntimeBackup>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not inspect PostgreSQL backups: {error}")),
    };
    let mut backups = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not inspect PostgreSQL backup: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect PostgreSQL backup type: {error}"))?;
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let Some((kind, created_at_ms)) = managed_backup_identity(&id) else {
            continue;
        };
        let size_bytes = entry
            .metadata()
            .map_err(|error| format!("Could not inspect PostgreSQL backup size: {error}"))?
            .len();
        backups.push(ManagedRuntimeBackup {
            id,
            kind: kind.to_string(),
            created_at_ms,
            size_bytes,
        });
    }
    backups.sort_by_key(|backup| std::cmp::Reverse(backup.created_at_ms));
    Ok(backups)
}

fn resolve_managed_backup(directory: &Path, backup_id: &str) -> Result<PathBuf, String> {
    if Path::new(backup_id)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(backup_id)
        || managed_backup_identity(backup_id).is_none()
    {
        return Err("The selected PostgreSQL backup identifier is invalid.".to_string());
    }
    let path = directory.join(backup_id);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not open the selected PostgreSQL backup: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("The selected PostgreSQL backup is not a regular file.".to_string());
    }
    Ok(path)
}

fn managed_backup_identity(name: &str) -> Option<(&'static str, u64)> {
    let stem = name.strip_suffix(".dump.age")?;
    let (prefix, timestamp) = stem.rsplit_once('-')?;
    let kind = if prefix.starts_with("pre-migration-v") {
        "pre-migration"
    } else if prefix.starts_with("pre-restore-v") {
        "pre-restore"
    } else if prefix.starts_with("pre-update-v") {
        "pre-update"
    } else {
        return None;
    };
    Some((kind, timestamp.parse().ok()?))
}

fn rotate_backups(directory: &Path) -> Result<(), String> {
    let mut backups = fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect PostgreSQL backups: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(managed_backup_identity)
                .is_some()
                && path.is_file()
                && !path.is_symlink()
        })
        .collect::<Vec<_>>();
    backups.sort_by_key(|path| {
        std::cmp::Reverse(
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(managed_backup_identity)
                .map(|(_, timestamp)| timestamp)
                .unwrap_or(0),
        )
    });
    for expired in backups.into_iter().skip(BACKUP_RETENTION_COUNT) {
        fs::remove_file(&expired).map_err(|error| {
            format!(
                "Could not rotate expired PostgreSQL backup {}: {error}",
                expired.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{self, Cursor, Write},
        process::Command,
    };

    use age::x25519;

    use super::{
        acquire_root_lock, list_backups, postgres_binary, resolve_managed_backup, rotate_backups,
        safe_filename_component, stream_archive_to, ManagedPostgres, BACKUP_RETENTION_COUNT,
        DATABASE_NAME,
    };

    struct EarlyClosingWriter {
        bytes_before_close: usize,
    }

    impl Write for EarlyClosingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if self.bytes_before_close == 0 {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "reader exited"));
            }
            let written = buffer.len().min(self.bytes_before_close);
            self.bytes_before_close -= written;
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn drains_an_archive_when_a_successful_reader_closes_its_pipe_early() {
        let payload = vec![7_u8; 64];
        let mut plaintext = Cursor::new(payload.clone());
        let mut output = EarlyClosingWriter {
            bytes_before_close: 8,
        };

        stream_archive_to(&mut plaintext, &mut output, "backup verification").unwrap();

        assert_eq!(plaintext.position(), payload.len() as u64);
    }

    #[test]
    fn gives_one_process_exclusive_ownership_of_a_managed_cluster() {
        let directory = tempfile::tempdir().unwrap();
        let first = acquire_root_lock(directory.path()).unwrap();

        assert!(acquire_root_lock(directory.path()).is_err());
        drop(first);
        assert!(acquire_root_lock(directory.path()).is_ok());
    }

    #[test]
    fn sanitizes_release_versions_used_in_backup_names() {
        assert_eq!(
            safe_filename_component("0.2.0+desktop/rc1"),
            "0.2.0_desktop_rc1"
        );
    }

    #[test]
    fn rotates_only_managed_backups_and_keeps_the_newest_seven() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..9 {
            fs::write(
                directory
                    .path()
                    .join(format!("pre-migration-v0.1.{index}-{index}.dump.age")),
                [],
            )
            .unwrap();
        }
        fs::write(directory.path().join("pre-restore-v0.2.0-100.dump.age"), []).unwrap();
        fs::write(
            directory
                .path()
                .join("pre-update-v0.2.0-to-v0.3.0-101.dump.age"),
            [],
        )
        .unwrap();
        fs::write(directory.path().join("user-owned.dump.age"), []).unwrap();

        rotate_backups(directory.path()).unwrap();

        assert_eq!(
            list_backups(directory.path()).unwrap().len(),
            BACKUP_RETENTION_COUNT
        );
        assert!(directory
            .path()
            .join("pre-update-v0.2.0-to-v0.3.0-101.dump.age")
            .exists());
        assert!(directory.path().join("user-owned.dump.age").exists());
    }

    #[test]
    fn lists_managed_backups_newest_first_and_rejects_path_traversal() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("pre-migration-v0.1.0-10.dump.age"),
            [1, 2],
        )
        .unwrap();
        fs::write(
            directory.path().join("pre-restore-v0.2.0-20.dump.age"),
            [1, 2, 3],
        )
        .unwrap();
        fs::write(
            directory
                .path()
                .join("pre-update-v0.2.0-to-v0.3.0-30.dump.age"),
            [1, 2, 3, 4],
        )
        .unwrap();

        let backups = list_backups(directory.path()).unwrap();

        assert_eq!(backups[0].kind, "pre-update");
        assert_eq!(backups[0].created_at_ms, 30);
        assert_eq!(backups[0].size_bytes, 4);
        assert!(resolve_managed_backup(directory.path(), "../secret.dump.age").is_err());
    }

    #[test]
    #[ignore = "extracts and starts the bundled PostgreSQL distribution"]
    fn restores_an_encrypted_dump_transactionally_and_keeps_a_safety_backup() {
        let cluster = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        let mut postgres = ManagedPostgres::start(
            cluster.path(),
            "restore-test-password-with-at-least-32-characters".to_string(),
        )
        .unwrap();
        execute_sql(
            &postgres,
            "CREATE TABLE restore_probe(value text NOT NULL); INSERT INTO restore_probe VALUES ('before');",
        );
        postgres.database_preexisting = true;
        let identity = x25519::Identity::generate();
        let backup = postgres
            .create_release_backup(backups.path(), "0.1.0", &identity)
            .unwrap()
            .unwrap();
        execute_sql(
            &postgres,
            "TRUNCATE restore_probe; INSERT INTO restore_probe VALUES ('after');",
        );
        let backup_id = backup.file_name().unwrap().to_string_lossy();

        let safety = postgres
            .restore_backup(backups.path(), &backup_id, "0.2.0", &identity)
            .unwrap();

        assert_eq!(
            query_sql(&postgres, "SELECT value FROM restore_probe"),
            "before"
        );
        assert!(safety
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("pre-restore-v0.2.0-"));
        let update_backup = postgres
            .create_update_backup(backups.path(), "0.2.0", "0.3.0", &identity)
            .unwrap();
        assert!(update_backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("pre-update-v0.2.0-to-v0.3.0-"));
        assert!(list_backups(backups.path())
            .unwrap()
            .iter()
            .any(|backup| backup.kind == "pre-update"));
    }

    fn execute_sql(postgres: &ManagedPostgres, sql: &str) {
        let output = psql(postgres, sql);
        assert!(
            output.status.success(),
            "psql failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn query_sql(postgres: &ManagedPostgres, sql: &str) -> String {
        let output = psql(postgres, sql);
        assert!(
            output.status.success(),
            "psql failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn psql(postgres: &ManagedPostgres, sql: &str) -> std::process::Output {
        let settings = postgres.postgresql.settings();
        Command::new(settings.binary_dir().join(postgres_binary("psql")))
            .args([
                "--no-password",
                "--tuples-only",
                "--no-align",
                "--dbname",
                DATABASE_NAME,
                "--host",
                settings.host.as_str(),
                "--port",
                &settings.port.to_string(),
                "--username",
                settings.username.as_str(),
                "--command",
                sql,
            ])
            .env("PGPASSWORD", &settings.password)
            .output()
            .unwrap()
    }
}
