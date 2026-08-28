use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use age::{secrecy::SecretString, x25519, Decryptor, Encryptor};
use fs2::FileExt;
use postgresql_embedded::{blocking::PostgreSQL, SettingsBuilder, Status};

use super::model::ManagedRuntimeBackup;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const DATABASE_NAME: &str = "wa_runtime";
const AUTOMATIC_BACKUP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const INTEGRITY_CHECK_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const INTEGRITY_MARKER_PREFIX: &str = "integrity-ok-v1-";
const AUTOMATIC_BACKUP_RETENTION_COUNT: usize = 7;
const MANUAL_BACKUP_RETENTION_COUNT: usize = 5;
const SAFETY_BACKUP_RETENTION_COUNT: usize = 3;

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
            super::observability::warn(
                "managed_postgres.orphan_process_recovered",
                serde_json::json!({}),
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

    pub fn create_automatic_backup(
        &self,
        backup_directory: &Path,
        identity: &x25519::Identity,
    ) -> Result<Option<PathBuf>, String> {
        if !self.database_preexisting {
            return Ok(None);
        }
        let now = unix_timestamp_millis()?;
        let interval = AUTOMATIC_BACKUP_INTERVAL.as_millis() as u64;
        if list_backups(backup_directory)?.iter().any(|backup| {
            now.saturating_sub(backup.created_at_ms) < interval || backup.created_at_ms > now
        }) {
            return Ok(None);
        }
        self.create_encrypted_backup(backup_directory, "automatic-", identity, true)
            .map(Some)
    }

    pub fn create_manual_backup(
        &self,
        backup_directory: &Path,
        identity: &x25519::Identity,
    ) -> Result<PathBuf, String> {
        self.create_encrypted_backup(backup_directory, "manual-", identity, true)
    }

    pub fn verify_integrity_if_due(&self, state_directory: &Path) -> Result<bool, String> {
        if !self.database_preexisting {
            return Ok(false);
        }
        fs::create_dir_all(state_directory).map_err(|error| {
            format!(
                "Could not create PostgreSQL integrity state directory {}: {error}",
                state_directory.display()
            )
        })?;
        let now = unix_timestamp_millis()?;
        let interval = INTEGRITY_CHECK_INTERVAL.as_millis() as u64;
        if latest_integrity_check(state_directory)?
            .is_some_and(|timestamp| timestamp > now || now.saturating_sub(timestamp) < interval)
        {
            return Ok(false);
        }
        self.run_pg_amcheck()?;
        commit_integrity_marker(state_directory, now)?;
        Ok(true)
    }

    pub fn create_portable_backup(
        &self,
        destination: &Path,
        passphrase: SecretString,
    ) -> Result<(), String> {
        validate_portable_destination(destination)?;
        let partial_path = portable_partial_path(destination)?;
        let result = (|| {
            self.write_encrypted_dump_with(
                &partial_path,
                Encryptor::with_user_passphrase(passphrase.clone()),
            )?;
            self.verify_passphrase_encrypted_dump(&partial_path, passphrase)?;
            fs::rename(&partial_path, destination).map_err(|error| {
                format!(
                    "Could not commit portable PostgreSQL recovery archive {}: {error}",
                    destination.display()
                )
            })?;
            sync_parent_directory(destination)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial_path);
        }
        result
    }

    pub fn restore_portable_backup(
        &self,
        source: &Path,
        passphrase: SecretString,
        backup_directory: &Path,
        release_version: &str,
        identity: &x25519::Identity,
    ) -> Result<PathBuf, String> {
        validate_portable_source(source)?;
        self.verify_passphrase_encrypted_dump(source, passphrase.clone())?;
        let prefix = format!("pre-restore-v{}-", safe_filename_component(release_version));
        let safety_backup =
            self.create_encrypted_backup(backup_directory, &prefix, identity, false)?;
        self.restore_passphrase_encrypted_dump(source, passphrase)?;
        rotate_backups(backup_directory)?;
        Ok(safety_backup)
    }

    pub fn restore_verified_source(
        &self,
        source: &Path,
        identity: &x25519::Identity,
    ) -> Result<(), String> {
        validate_portable_source(source)?;
        self.verify_encrypted_dump(source, identity)?;
        self.restore_encrypted_dump(source, identity)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.postgresql
            .stop()
            .map_err(|error| format!("Could not stop managed PostgreSQL: {error}"))
    }

    fn run_pg_amcheck(&self) -> Result<(), String> {
        let settings = self.postgresql.settings();
        let pg_amcheck = settings.binary_dir().join(postgres_binary("pg_amcheck"));
        let output = Command::new(&pg_amcheck)
            .args([
                "--no-password",
                "--install-missing=pg_catalog",
                "--on-error-stop",
                "--jobs=1",
                "--host",
                settings.host.as_str(),
                "--port",
                &settings.port.to_string(),
                "--username",
                settings.username.as_str(),
                DATABASE_NAME,
            ])
            .env("PGPASSWORD", &settings.password)
            .output()
            .map_err(|error| format!("Could not start bundled pg_amcheck: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        Err(if detail.is_empty() {
            "Managed PostgreSQL integrity check failed.".to_string()
        } else {
            format!("Managed PostgreSQL integrity check failed: {detail}")
        })
    }

    fn write_encrypted_dump(
        &self,
        destination: &Path,
        identity: &x25519::Identity,
    ) -> Result<(), String> {
        let recipient = identity.to_public();
        let encryptor =
            Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
                .map_err(|error| format!("Could not initialize backup encryption: {error}"))?;
        self.write_encrypted_dump_with(destination, encryptor)
    }

    fn write_encrypted_dump_with(
        &self,
        destination: &Path,
        encryptor: Encryptor,
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
        let timestamp = unix_timestamp_millis()?;
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

    fn verify_passphrase_encrypted_dump(
        &self,
        source: &Path,
        passphrase: SecretString,
    ) -> Result<(), String> {
        let mut plaintext = passphrase_decryptor(source, passphrase)?;
        self.run_pg_restore(
            &mut plaintext,
            &["--list"],
            "Portable PostgreSQL recovery archive verification",
        )
    }

    fn restore_passphrase_encrypted_dump(
        &self,
        source: &Path,
        passphrase: SecretString,
    ) -> Result<(), String> {
        let mut plaintext = passphrase_decryptor(source, passphrase)?;
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
            "Portable PostgreSQL recovery archive restore",
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

fn unix_timestamp_millis() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock cannot timestamp a database backup: {error}"))?
        .as_millis();
    u64::try_from(millis).map_err(|_| "Database backup timestamp exceeds u64.".to_string())
}

fn latest_integrity_check(directory: &Path) -> Result<Option<u64>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect PostgreSQL integrity state: {error}"
            ))
        }
    };
    let mut latest = None;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Could not inspect PostgreSQL integrity state: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("Could not inspect PostgreSQL integrity marker: {error}"))?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name();
        let Some(timestamp) = name
            .to_str()
            .and_then(|name| name.strip_prefix(INTEGRITY_MARKER_PREFIX))
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        latest = Some(latest.map_or(timestamp, |current: u64| current.max(timestamp)));
    }
    Ok(latest)
}

pub fn last_integrity_check_at(directory: &Path) -> Result<Option<u64>, String> {
    latest_integrity_check(directory)
}

pub fn integrity_check_interval_millis() -> u64 {
    INTEGRITY_CHECK_INTERVAL.as_millis() as u64
}

fn commit_integrity_marker(directory: &Path, timestamp: u64) -> Result<(), String> {
    let marker = directory.join(format!("{INTEGRITY_MARKER_PREFIX}{timestamp}"));
    let file = secure_file(&marker)
        .map_err(|error| format!("Could not commit PostgreSQL integrity marker: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not sync PostgreSQL integrity marker: {error}"))?;
    sync_parent_directory(&marker)?;
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Could not rotate PostgreSQL integrity state: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("Could not rotate PostgreSQL integrity state: {error}"))?;
        let path = entry.path();
        if path != marker
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(INTEGRITY_MARKER_PREFIX))
            && path.is_file()
            && !path.is_symlink()
        {
            fs::remove_file(&path).map_err(|error| {
                format!(
                    "Could not rotate PostgreSQL integrity marker {}: {error}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn validate_portable_source(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not open the PostgreSQL recovery archive: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("The PostgreSQL recovery archive is not a regular file.".to_string());
    }
    Ok(())
}

fn validate_portable_destination(path: &Path) -> Result<(), String> {
    if path.file_name().is_none() {
        return Err("Choose a file for the PostgreSQL recovery archive.".to_string());
    }
    if path.exists() {
        return Err(
            "The selected recovery archive already exists; choose a new file name.".to_string(),
        );
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The recovery archive destination has no parent directory.".to_string())?;
    let metadata = fs::metadata(parent).map_err(|error| {
        format!(
            "Could not inspect the recovery archive directory {}: {error}",
            parent.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err("The recovery archive destination is not a directory.".to_string());
    }
    Ok(())
}

fn portable_partial_path(destination: &Path) -> Result<PathBuf, String> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The recovery archive file name is not valid UTF-8.".to_string())?;
    Ok(destination.with_file_name(format!(".{name}.{}.partial", uuid::Uuid::new_v4())))
}

fn sync_parent_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(
            path.parent()
                .ok_or_else(|| "The recovery archive has no parent directory.".to_string())?,
        )
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync the recovery archive directory: {error}"))?;
    }
    Ok(())
}

fn passphrase_decryptor(source: &Path, passphrase: SecretString) -> Result<Box<dyn Read>, String> {
    let encrypted = File::open(source)
        .map(BufReader::new)
        .map_err(|error| format!("Could not open portable PostgreSQL recovery archive: {error}"))?;
    let decryptor = Decryptor::new(encrypted).map_err(|error| {
        format!("Could not parse portable PostgreSQL recovery archive: {error}")
    })?;
    let identity = age::scrypt::Identity::new(passphrase);
    decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map(|reader| Box::new(reader) as Box<dyn Read>)
        .map_err(|error| format!("Could not decrypt portable PostgreSQL recovery archive: {error}"))
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

pub fn remove_incomplete_backups(directory: &Path) -> Result<usize, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(format!(
                "Could not inspect incomplete PostgreSQL backups: {error}"
            ))
        }
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Could not inspect incomplete PostgreSQL backup: {error}"))?;
        let file_type = entry.file_type().map_err(|error| {
            format!("Could not inspect incomplete PostgreSQL backup type: {error}")
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_managed_partial = name.ends_with(".dump.age.partial")
            && (name.starts_with("automatic-")
                || name.starts_with("manual-")
                || name.starts_with("pre-migration-v")
                || name.starts_with("pre-restore-v")
                || name.starts_with("pre-update-v"));
        if !file_type.is_file() || file_type.is_symlink() || !is_managed_partial {
            continue;
        }
        fs::remove_file(entry.path()).map_err(|error| {
            format!(
                "Could not remove incomplete PostgreSQL backup {}: {error}",
                entry.path().display()
            )
        })?;
        removed += 1;
    }
    Ok(removed)
}

pub fn stage_managed_backup(
    directory: &Path,
    backup_id: &str,
    staging_directory: &Path,
) -> Result<PathBuf, String> {
    let source = resolve_managed_backup(directory, backup_id)?;
    fs::create_dir_all(staging_directory).map_err(|error| {
        format!(
            "Could not create PostgreSQL recovery staging directory {}: {error}",
            staging_directory.display()
        )
    })?;
    let staged = staging_directory.join(format!("{}.dump.age", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut input = File::open(&source)
            .map(BufReader::new)
            .map_err(|error| format!("Could not open selected PostgreSQL backup: {error}"))?;
        let mut output = secure_file(&staged)
            .map(BufWriter::new)
            .map_err(|error| format!("Could not stage selected PostgreSQL backup: {error}"))?;
        io::copy(&mut input, &mut output)
            .map_err(|error| format!("Could not stage selected PostgreSQL backup: {error}"))?;
        output
            .flush()
            .and_then(|_| output.get_ref().sync_all())
            .map_err(|error| format!("Could not sync staged PostgreSQL backup: {error}"))?;
        sync_parent_directory(&staged)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result.map(|_| staged)
}

pub fn retain_staged_managed_backup(
    staged: &Path,
    directory: &Path,
    backup_id: &str,
) -> Result<(), String> {
    if managed_backup_identity(backup_id).is_none()
        || Path::new(backup_id)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(backup_id)
    {
        return Err("The selected PostgreSQL backup identifier is invalid.".to_string());
    }
    validate_portable_source(staged)?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not recreate PostgreSQL backup directory: {error}"))?;
    let destination = directory.join(backup_id);
    if destination.exists() {
        return Ok(());
    }
    let mut input = File::open(staged)
        .map(BufReader::new)
        .map_err(|error| format!("Could not reopen staged PostgreSQL backup: {error}"))?;
    let mut output = secure_file(&destination)
        .map(BufWriter::new)
        .map_err(|error| format!("Could not retain selected PostgreSQL backup: {error}"))?;
    let result = io::copy(&mut input, &mut output)
        .map_err(|error| format!("Could not retain selected PostgreSQL backup: {error}"))
        .and_then(|_| {
            output
                .flush()
                .and_then(|_| output.get_ref().sync_all())
                .map_err(|error| format!("Could not sync retained PostgreSQL backup: {error}"))
        })
        .and_then(|_| sync_parent_directory(&destination));
    if result.is_err() {
        let _ = fs::remove_file(&destination);
    }
    result
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
    } else if prefix == "automatic" {
        "automatic"
    } else if prefix == "manual" {
        "manual"
    } else {
        return None;
    };
    Some((kind, timestamp.parse().ok()?))
}

fn rotate_backups(directory: &Path) -> Result<(), String> {
    let mut backups = fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect PostgreSQL backups: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let (kind, timestamp) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(managed_backup_identity)?;
            (path.is_file() && !path.is_symlink()).then_some((path, kind, timestamp))
        })
        .collect::<Vec<_>>();
    backups.sort_by_key(|(_, kind, timestamp)| (*kind, std::cmp::Reverse(*timestamp)));
    let mut seen = std::collections::HashMap::<&str, usize>::new();
    for (expired, _, _) in backups.into_iter().filter(|(_, kind, _)| {
        let count = seen.entry(kind).or_default();
        *count += 1;
        *count > backup_retention(kind)
    }) {
        fs::remove_file(&expired).map_err(|error| {
            format!(
                "Could not rotate expired PostgreSQL backup {}: {error}",
                expired.display()
            )
        })?;
    }
    Ok(())
}

fn backup_retention(kind: &str) -> usize {
    match kind {
        "automatic" => AUTOMATIC_BACKUP_RETENTION_COUNT,
        "manual" => MANUAL_BACKUP_RETENTION_COUNT,
        _ => SAFETY_BACKUP_RETENTION_COUNT,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{self, Cursor, Write},
        process::Command,
    };

    use age::{secrecy::SecretString, x25519};

    use super::{
        acquire_root_lock, commit_integrity_marker, latest_integrity_check, list_backups,
        postgres_binary, remove_incomplete_backups, resolve_managed_backup,
        retain_staged_managed_backup, rotate_backups, safe_filename_component,
        stage_managed_backup, stream_archive_to, ManagedPostgres, AUTOMATIC_BACKUP_RETENTION_COUNT,
        DATABASE_NAME, MANUAL_BACKUP_RETENTION_COUNT, SAFETY_BACKUP_RETENTION_COUNT,
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
    fn rotates_each_backup_class_without_one_class_evicting_another() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..(AUTOMATIC_BACKUP_RETENTION_COUNT + 2) {
            fs::write(
                directory.path().join(format!("automatic-{index}.dump.age")),
                [],
            )
            .unwrap();
        }
        for index in 0..(MANUAL_BACKUP_RETENTION_COUNT + 1) {
            fs::write(
                directory.path().join(format!("manual-{index}.dump.age")),
                [],
            )
            .unwrap();
        }
        for index in 0..(SAFETY_BACKUP_RETENTION_COUNT + 1) {
            fs::write(
                directory
                    .path()
                    .join(format!("pre-migration-v0.1.0-{index}.dump.age")),
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
            AUTOMATIC_BACKUP_RETENTION_COUNT
                + MANUAL_BACKUP_RETENTION_COUNT
                + SAFETY_BACKUP_RETENTION_COUNT
                + 2
        );
        assert!(directory
            .path()
            .join("pre-update-v0.2.0-to-v0.3.0-101.dump.age")
            .exists());
        assert!(directory.path().join("user-owned.dump.age").exists());
    }

    #[test]
    fn lists_automatic_and_manual_recovery_points() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("automatic-10.dump.age"), [1]).unwrap();
        fs::write(directory.path().join("manual-20.dump.age"), [1, 2]).unwrap();

        let backups = list_backups(directory.path()).unwrap();

        assert_eq!(backups[0].kind, "manual");
        assert_eq!(backups[1].kind, "automatic");
    }

    #[test]
    fn stages_and_retains_a_backup_across_cluster_quarantine() {
        let directory = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        let backup_id = "automatic-20.dump.age";
        let source = directory.path().join(backup_id);
        fs::write(&source, [1, 2, 3, 4]).unwrap();

        let staged = stage_managed_backup(directory.path(), backup_id, staging.path()).unwrap();
        fs::remove_file(&source).unwrap();
        retain_staged_managed_backup(&staged, directory.path(), backup_id).unwrap();

        assert_eq!(fs::read(source).unwrap(), [1, 2, 3, 4]);
    }

    #[test]
    fn commits_only_the_latest_successful_integrity_marker() {
        let directory = tempfile::tempdir().unwrap();

        commit_integrity_marker(directory.path(), 10).unwrap();
        commit_integrity_marker(directory.path(), 20).unwrap();

        assert_eq!(latest_integrity_check(directory.path()).unwrap(), Some(20));
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
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
    fn removes_only_managed_incomplete_backups() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("automatic-1.dump.age.partial"),
            b"partial",
        )
        .unwrap();
        fs::write(
            directory.path().join("manual-2.dump.age.partial"),
            b"partial",
        )
        .unwrap();
        fs::write(directory.path().join("automatic-3.dump.age"), b"complete").unwrap();
        fs::write(directory.path().join("unrelated.partial"), b"keep").unwrap();

        assert_eq!(remove_incomplete_backups(directory.path()).unwrap(), 2);
        assert!(directory.path().join("automatic-3.dump.age").exists());
        assert!(directory.path().join("unrelated.partial").exists());
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
        let integrity_state = tempfile::tempdir().unwrap();
        assert!(postgres
            .verify_integrity_if_due(integrity_state.path())
            .unwrap());
        assert!(!postgres
            .verify_integrity_if_due(integrity_state.path())
            .unwrap());
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

        let portable = backups.path().join("portable-recovery.dump.age");
        let passphrase = SecretString::from("portable-test-passphrase".to_string());
        postgres
            .create_portable_backup(&portable, passphrase.clone())
            .unwrap();
        execute_sql(
            &postgres,
            "TRUNCATE restore_probe; INSERT INTO restore_probe VALUES ('portable-after');",
        );
        postgres
            .restore_portable_backup(&portable, passphrase, backups.path(), "0.3.0", &identity)
            .unwrap();
        assert_eq!(
            query_sql(&postgres, "SELECT value FROM restore_probe"),
            "before"
        );
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
