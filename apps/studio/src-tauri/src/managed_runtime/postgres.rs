use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use age::{secrecy::SecretString, x25519, Decryptor, Encryptor};
use fs2::FileExt;
use postgresql_embedded::{blocking::PostgreSQL, SettingsBuilder, Status};
use ring::digest::{Context as DigestContext, SHA256};
use serde::{Deserialize, Serialize};

use super::model::ManagedRuntimeBackup;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const DATABASE_NAME: &str = "wa_runtime";
const AUTOMATIC_BACKUP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const INTEGRITY_CHECK_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const CLOCK_SKEW_TOLERANCE: Duration = Duration::from_secs(5 * 60);
const INTEGRITY_MARKER_PREFIX: &str = "integrity-ok-v1-";
const AUTOMATIC_BACKUP_RETENTION_COUNT: usize = 7;
const MANUAL_BACKUP_RETENTION_COUNT: usize = 5;
const SAFETY_BACKUP_RETENTION_COUNT: usize = 3;
const PROCESS_OUTPUT_LIMIT: usize = 64 * 1024;
const MAINTENANCE_CANCELLED: &str = "Managed PostgreSQL maintenance was cancelled.";
const BACKUP_MANIFEST_FORMAT_VERSION: u32 = 1;
const BACKUP_STORAGE_POLICY_VERSION: u32 = 1;
const BACKUP_MANIFEST_MAX_BYTES: u64 = 64 * 1024;
const MEBIBYTE: u64 = 1_024 * 1_024;
const GIBIBYTE: u64 = 1_024 * MEBIBYTE;
const BACKUP_ESTIMATE_MIN_BYTES: u64 = 64 * MEBIBYTE;
const BACKUP_FREE_SPACE_RESERVE_BYTES: u64 = 2 * GIBIBYTE;
const BACKUP_BUDGET_MIN_BYTES: u64 = 2 * GIBIBYTE;
const BACKUP_BUDGET_MAX_BYTES: u64 = 8 * GIBIBYTE;

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedBackupManifest {
    format_version: u32,
    backup_id: String,
    backup_kind: String,
    created_at_ms: u64,
    size_bytes: u64,
    sha256: String,
    storage_policy_version: u32,
    data_classes: Vec<String>,
}

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

    #[cfg(test)]
    pub fn create_release_backup(
        &self,
        backup_directory: &Path,
        release_version: &str,
        identity: &x25519::Identity,
    ) -> Result<Option<PathBuf>, String> {
        self.create_release_backup_inner(backup_directory, release_version, identity, None)
    }

    pub fn create_release_backup_with_cancellation(
        &self,
        backup_directory: &Path,
        release_version: &str,
        identity: &x25519::Identity,
        cancellation: &AtomicBool,
    ) -> Result<Option<PathBuf>, String> {
        self.create_release_backup_inner(
            backup_directory,
            release_version,
            identity,
            Some(cancellation),
        )
    }

    fn create_release_backup_inner(
        &self,
        backup_directory: &Path,
        release_version: &str,
        identity: &x25519::Identity,
        cancellation: Option<&AtomicBool>,
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
        if verified_backup_exists(backup_directory, &prefix, |backup| {
            self.verify_encrypted_dump_with_cancellation(backup, identity, cancellation)
        })? {
            return Ok(None);
        }
        self.create_encrypted_backup_with_cancellation(
            backup_directory,
            &prefix,
            identity,
            true,
            cancellation,
        )
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

    #[cfg(test)]
    pub fn create_update_backup(
        &self,
        backup_directory: &Path,
        current_version: &str,
        target_version: &str,
        identity: &x25519::Identity,
    ) -> Result<PathBuf, String> {
        self.create_update_backup_inner(
            backup_directory,
            current_version,
            target_version,
            identity,
            None,
        )
    }

    pub fn create_update_backup_with_cancellation(
        &self,
        backup_directory: &Path,
        current_version: &str,
        target_version: &str,
        identity: &x25519::Identity,
        cancellation: &AtomicBool,
    ) -> Result<PathBuf, String> {
        self.create_update_backup_inner(
            backup_directory,
            current_version,
            target_version,
            identity,
            Some(cancellation),
        )
    }

    fn create_update_backup_inner(
        &self,
        backup_directory: &Path,
        current_version: &str,
        target_version: &str,
        identity: &x25519::Identity,
        cancellation: Option<&AtomicBool>,
    ) -> Result<PathBuf, String> {
        let prefix = format!(
            "pre-update-v{}-to-v{}-",
            safe_filename_component(current_version),
            safe_filename_component(target_version),
        );
        self.create_encrypted_backup_with_cancellation(
            backup_directory,
            &prefix,
            identity,
            true,
            cancellation,
        )
    }

    pub fn create_automatic_backup(
        &self,
        backup_directory: &Path,
        identity: &x25519::Identity,
        cancellation: &AtomicBool,
    ) -> Result<Option<PathBuf>, String> {
        let now = unix_timestamp_millis()?;
        if !automatic_backup_is_due(backup_directory, now)? {
            return Ok(None);
        }
        self.create_encrypted_backup_with_cancellation(
            backup_directory,
            "automatic-",
            identity,
            true,
            Some(cancellation),
        )
        .map(Some)
    }

    pub fn create_manual_backup_with_cancellation(
        &self,
        backup_directory: &Path,
        identity: &x25519::Identity,
        cancellation: &AtomicBool,
    ) -> Result<PathBuf, String> {
        self.create_encrypted_backup_with_cancellation(
            backup_directory,
            "manual-",
            identity,
            true,
            Some(cancellation),
        )
    }

    pub fn verify_integrity_if_due(
        &self,
        state_directory: &Path,
        cancellation: &AtomicBool,
    ) -> Result<bool, String> {
        fs::create_dir_all(state_directory).map_err(|error| {
            format!(
                "Could not create PostgreSQL integrity state directory {}: {error}",
                state_directory.display()
            )
        })?;
        let now = unix_timestamp_millis()?;
        if !integrity_check_is_due(state_directory, now)? {
            return Ok(false);
        }
        self.run_pg_amcheck(cancellation)?;
        commit_integrity_marker(state_directory, now)?;
        Ok(true)
    }

    pub fn background_maintenance_due(
        &self,
        state_directory: &Path,
    ) -> Result<(bool, bool), String> {
        let now = unix_timestamp_millis()?;
        Ok((
            integrity_check_is_due(state_directory, now)?,
            automatic_backup_is_due(state_directory, now)?,
        ))
    }

    #[cfg(test)]
    pub fn create_portable_backup(
        &self,
        destination: &Path,
        passphrase: SecretString,
    ) -> Result<(), String> {
        self.create_portable_backup_inner(destination, passphrase, None)
    }

    pub fn create_portable_backup_with_cancellation(
        &self,
        destination: &Path,
        passphrase: SecretString,
        cancellation: &AtomicBool,
    ) -> Result<(), String> {
        self.create_portable_backup_inner(destination, passphrase, Some(cancellation))
    }

    fn create_portable_backup_inner(
        &self,
        destination: &Path,
        passphrase: SecretString,
        cancellation: Option<&AtomicBool>,
    ) -> Result<(), String> {
        validate_portable_destination(destination)?;
        let partial_path = portable_partial_path(destination)?;
        let result = (|| {
            self.write_encrypted_dump_with_cancellation(
                &partial_path,
                Encryptor::with_user_passphrase(passphrase.clone()),
                cancellation,
            )?;
            self.verify_passphrase_encrypted_dump_with_cancellation(
                &partial_path,
                passphrase,
                cancellation,
            )?;
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

    fn run_pg_amcheck(&self, cancellation: &AtomicBool) -> Result<(), String> {
        let settings = self.postgresql.settings();
        let pg_amcheck = settings.binary_dir().join(postgres_binary("pg_amcheck"));
        let mut child = Command::new(&pg_amcheck)
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
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start bundled pg_amcheck: {error}"))?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return Err("Could not capture bundled pg_amcheck output.".to_string());
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill();
            return Err("Could not capture bundled pg_amcheck errors.".to_string());
        };
        let stdout_reader = std::thread::spawn(move || drain_process_output(stdout));
        let stderr_reader = std::thread::spawn(move || drain_process_output(stderr));
        let status = loop {
            if cancellation.load(Ordering::Acquire) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(MAINTENANCE_CANCELLED.to_string());
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(format!("Could not wait for bundled pg_amcheck: {error}"));
                }
            }
        };
        let (stdout, stdout_truncated) = stdout_reader
            .join()
            .map_err(|_| "Bundled pg_amcheck output reader panicked.".to_string())?
            .map_err(|error| format!("Could not read bundled pg_amcheck output: {error}"))?;
        let (stderr, stderr_truncated) = stderr_reader
            .join()
            .map_err(|_| "Bundled pg_amcheck error reader panicked.".to_string())?
            .map_err(|error| format!("Could not read bundled pg_amcheck errors: {error}"))?;
        if status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&stdout).trim().to_string();
        let (detail, truncated) = if !stderr.is_empty() {
            (stderr, stderr_truncated)
        } else {
            (stdout, stdout_truncated)
        };
        let detail = if truncated {
            format!("{detail} [output truncated]")
        } else {
            detail
        };
        Err(if detail.is_empty() {
            "Managed PostgreSQL integrity check failed.".to_string()
        } else {
            format!("Managed PostgreSQL integrity check failed: {detail}")
        })
    }

    fn write_encrypted_dump_cancellable(
        &self,
        destination: &Path,
        identity: &x25519::Identity,
        cancellation: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let recipient = identity.to_public();
        let encryptor =
            Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
                .map_err(|error| format!("Could not initialize backup encryption: {error}"))?;
        self.write_encrypted_dump_with_cancellation(destination, encryptor, cancellation)
    }

    fn write_encrypted_dump_with_cancellation(
        &self,
        destination: &Path,
        encryptor: Encryptor,
        cancellation: Option<&AtomicBool>,
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
            copy_with_cancellation(&mut plaintext, &mut encrypted, cancellation)
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
        self.create_encrypted_backup_with_cancellation(
            backup_directory,
            prefix,
            identity,
            rotate_after,
            None,
        )
    }

    fn create_encrypted_backup_with_cancellation(
        &self,
        backup_directory: &Path,
        prefix: &str,
        identity: &x25519::Identity,
        rotate_after: bool,
        cancellation: Option<&AtomicBool>,
    ) -> Result<PathBuf, String> {
        fs::create_dir_all(backup_directory).map_err(|error| {
            format!(
                "Could not create managed PostgreSQL backup directory {}: {error}",
                backup_directory.display()
            )
        })?;
        rotate_backups(backup_directory)?;
        let timestamp = unix_timestamp_millis()?;
        let final_path = backup_directory.join(format!("{prefix}{timestamp}.dump.age"));
        let partial_path = backup_directory.join(format!("{prefix}{timestamp}.dump.age.partial"));
        let backup_kind = final_path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(managed_backup_identity)
            .map(|(kind, _)| kind)
            .ok_or_else(|| "The managed backup prefix is invalid.".to_string())?;
        let storage_budget = backup_storage_preflight(
            backup_directory,
            &self.postgresql.settings().data_dir,
            backup_kind,
            cancellation,
        )?;
        if let Err(error) =
            self.write_encrypted_dump_cancellable(&partial_path, identity, cancellation)
        {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
        if let Err(error) =
            self.verify_encrypted_dump_with_cancellation(&partial_path, identity, cancellation)
        {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
        let actual_size = fs::metadata(&partial_path)
            .map_err(|error| format!("Could not inspect managed backup size: {error}"))?
            .len();
        if let Err(error) =
            ensure_backup_fits_budget(backup_directory, backup_kind, actual_size, storage_budget)
        {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
        fs::rename(&partial_path, &final_path).map_err(|error| {
            format!(
                "Could not commit PostgreSQL backup {}: {error}",
                final_path.display()
            )
        })?;
        if let Err(error) = write_backup_manifest(&final_path, cancellation) {
            let _ = fs::remove_file(&final_path);
            if let Ok(manifest) = backup_manifest_path(&final_path) {
                let _ = fs::remove_file(manifest);
            }
            return Err(error);
        }
        sync_parent_directory(&final_path)?;
        if rotate_after {
            rotate_backups(backup_directory)?;
        }
        enforce_backup_byte_budget(backup_directory, storage_budget)?;
        Ok(final_path)
    }

    fn verify_encrypted_dump(
        &self,
        source: &Path,
        identity: &x25519::Identity,
    ) -> Result<(), String> {
        self.verify_encrypted_dump_with_cancellation(source, identity, None)
    }

    fn verify_encrypted_dump_with_cancellation(
        &self,
        source: &Path,
        identity: &x25519::Identity,
        cancellation: Option<&AtomicBool>,
    ) -> Result<(), String> {
        verify_backup_manifest_if_present(source, cancellation)?;
        let encrypted = File::open(source)
            .map(BufReader::new)
            .map_err(|error| format!("Could not open encrypted PostgreSQL backup: {error}"))?;
        let decryptor = Decryptor::new(encrypted)
            .map_err(|error| format!("Could not parse encrypted PostgreSQL backup: {error}"))?;
        let mut plaintext = decryptor
            .decrypt(std::iter::once(identity as &dyn age::Identity))
            .map_err(|error| format!("Could not decrypt PostgreSQL backup: {error}"))?;
        self.run_pg_restore_with_cancellation(
            &mut plaintext,
            &["--list"],
            "Encrypted PostgreSQL backup verification",
            cancellation,
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
        self.verify_passphrase_encrypted_dump_with_cancellation(source, passphrase, None)
    }

    fn verify_passphrase_encrypted_dump_with_cancellation(
        &self,
        source: &Path,
        passphrase: SecretString,
        cancellation: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let mut plaintext = passphrase_decryptor(source, passphrase)?;
        self.run_pg_restore_with_cancellation(
            &mut plaintext,
            &["--list"],
            "Portable PostgreSQL recovery archive verification",
            cancellation,
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
        self.run_pg_restore_with_cancellation(plaintext, arguments, operation, None)
    }

    fn run_pg_restore_with_cancellation(
        &self,
        plaintext: &mut dyn Read,
        arguments: &[&str],
        operation: &str,
        cancellation: Option<&AtomicBool>,
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
            .and_then(|mut input| {
                stream_archive_to(plaintext, &mut input, operation, cancellation)
            });
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

fn drain_process_output(mut reader: impl Read) -> io::Result<(Vec<u8>, bool)> {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok((retained, truncated));
        }
        let remaining = PROCESS_OUTPUT_LIMIT.saturating_sub(retained.len());
        let keep = remaining.min(read);
        retained.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
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

fn integrity_check_timestamps(directory: &Path) -> Result<Vec<u64>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not inspect PostgreSQL integrity state: {error}"
            ))
        }
    };
    let mut timestamps = Vec::new();
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
        timestamps.push(timestamp);
    }
    Ok(timestamps)
}

pub fn last_integrity_check_at(directory: &Path, now_ms: u64) -> Result<Option<u64>, String> {
    Ok(latest_credible_timestamp(
        now_ms,
        integrity_check_timestamps(directory)?,
    ))
}

pub fn integrity_check_interval_millis() -> u64 {
    INTEGRITY_CHECK_INTERVAL.as_millis() as u64
}

fn maintenance_is_due(now_ms: u64, last_success_at_ms: Option<u64>, interval_ms: u64) -> bool {
    match last_success_at_ms {
        None => true,
        Some(last_success_at_ms) if !timestamp_is_credible(now_ms, last_success_at_ms) => true,
        Some(last_success_at_ms) if last_success_at_ms > now_ms => false,
        Some(last_success_at_ms) => now_ms.saturating_sub(last_success_at_ms) >= interval_ms,
    }
}

pub(super) fn timestamp_is_credible(now_ms: u64, timestamp_ms: u64) -> bool {
    timestamp_ms <= now_ms.saturating_add(CLOCK_SKEW_TOLERANCE.as_millis() as u64)
}

fn latest_credible_timestamp(
    now_ms: u64,
    timestamps: impl IntoIterator<Item = u64>,
) -> Option<u64> {
    timestamps
        .into_iter()
        .filter(|timestamp| timestamp_is_credible(now_ms, *timestamp))
        .max()
}

pub fn latest_recovery_point_at(backups: &[ManagedRuntimeBackup], now_ms: u64) -> Option<u64> {
    latest_credible_timestamp(now_ms, backups.iter().map(|backup| backup.created_at_ms))
}

fn automatic_backup_is_due(directory: &Path, now_ms: u64) -> Result<bool, String> {
    let latest_backup = latest_recovery_point_at(&list_backups(directory)?, now_ms);
    Ok(maintenance_is_due(
        now_ms,
        latest_backup,
        AUTOMATIC_BACKUP_INTERVAL.as_millis() as u64,
    ))
}

fn integrity_check_is_due(directory: &Path, now_ms: u64) -> Result<bool, String> {
    Ok(maintenance_is_due(
        now_ms,
        last_integrity_check_at(directory, now_ms)?,
        INTEGRITY_CHECK_INTERVAL.as_millis() as u64,
    ))
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
    cancellation: Option<&AtomicBool>,
) -> Result<(), String> {
    match copy_with_cancellation(plaintext, output, cancellation) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
            // `pg_restore --list` may finish after reading the archive table of contents and
            // close stdin before the data blocks arrive. Drain the decrypted stream so age still
            // authenticates the complete backup instead of treating that successful early exit
            // as a corrupt archive.
            copy_with_cancellation(plaintext, &mut io::sink(), cancellation)
                .map(|_| ())
                .map_err(|error| format!("{operation} could not authenticate its archive: {error}"))
        }
        Err(error) => Err(format!("{operation} could not stream its archive: {error}")),
    }
}

fn copy_with_cancellation(
    input: &mut dyn Read,
    output: &mut dyn Write,
    cancellation: Option<&AtomicBool>,
) -> io::Result<u64> {
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancellation.is_some_and(|token| token.load(Ordering::Acquire)) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                MAINTENANCE_CANCELLED,
            ));
        }
        let read = input.read(&mut buffer)?;
        if read == 0 {
            return Ok(copied);
        }
        output.write_all(&buffer[..read])?;
        copied = copied.saturating_add(read as u64);
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

fn backup_manifest_path(backup: &Path) -> Result<PathBuf, String> {
    let name = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The managed backup file name is not valid UTF-8.".to_string())?;
    Ok(backup.with_file_name(format!("{name}.manifest.json")))
}

fn backup_manifest_data_classes() -> Vec<String> {
    [
        "durable-domain",
        "delivery-evidence",
        "active-transient-work",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn sha256_file(path: &Path, cancellation: Option<&AtomicBool>) -> Result<String, String> {
    let mut file = File::open(path)
        .map(BufReader::new)
        .map_err(|error| format!("Could not read managed backup for hashing: {error}"))?;
    let mut digest = DigestContext::new(&SHA256);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancellation.is_some_and(|token| token.load(Ordering::Acquire)) {
            return Err(MAINTENANCE_CANCELLED.to_string());
        }
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash managed backup: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn write_backup_manifest(backup: &Path, cancellation: Option<&AtomicBool>) -> Result<(), String> {
    let backup_id = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The managed backup file name is not valid UTF-8.".to_string())?;
    let (kind, created_at_ms) = managed_backup_identity(backup_id)
        .ok_or_else(|| "The managed backup file name is invalid.".to_string())?;
    let size_bytes = fs::metadata(backup)
        .map_err(|error| format!("Could not inspect managed backup size: {error}"))?
        .len();
    let manifest = ManagedBackupManifest {
        format_version: BACKUP_MANIFEST_FORMAT_VERSION,
        backup_id: backup_id.to_string(),
        backup_kind: kind.to_string(),
        created_at_ms,
        size_bytes,
        sha256: sha256_file(backup, cancellation)?,
        storage_policy_version: BACKUP_STORAGE_POLICY_VERSION,
        data_classes: backup_manifest_data_classes(),
    };
    let path = backup_manifest_path(backup)?;
    let partial = path.with_extension("json.partial");
    let result = (|| {
        let encoded = serde_json::to_vec(&manifest)
            .map_err(|error| format!("Could not encode managed backup manifest: {error}"))?;
        let mut file = secure_file(&partial)
            .map(BufWriter::new)
            .map_err(|error| format!("Could not create managed backup manifest: {error}"))?;
        file.write_all(&encoded)
            .and_then(|_| file.flush())
            .and_then(|_| file.get_ref().sync_all())
            .map_err(|error| format!("Could not write managed backup manifest: {error}"))?;
        fs::rename(&partial, &path)
            .map_err(|error| format!("Could not commit managed backup manifest: {error}"))?;
        sync_parent_directory(&path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

fn verify_backup_manifest_if_present(
    backup: &Path,
    cancellation: Option<&AtomicBool>,
) -> Result<(), String> {
    let path = backup_manifest_path(backup)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not inspect managed backup manifest: {error}"
            ))
        }
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("The managed backup manifest is not a regular file.".to_string());
    }
    if metadata.len() > BACKUP_MANIFEST_MAX_BYTES {
        return Err("The managed backup manifest exceeds its size limit.".to_string());
    }
    let encoded = fs::read(&path)
        .map_err(|error| format!("Could not read managed backup manifest: {error}"))?;
    let manifest: ManagedBackupManifest = serde_json::from_slice(&encoded)
        .map_err(|error| format!("The managed backup manifest is invalid: {error}"))?;
    let backup_id = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The managed backup file name is not valid UTF-8.".to_string())?;
    let (kind, created_at_ms) = managed_backup_identity(backup_id)
        .ok_or_else(|| "The managed backup file name is invalid.".to_string())?;
    let size_bytes = fs::metadata(backup)
        .map_err(|error| format!("Could not inspect managed backup size: {error}"))?
        .len();
    if manifest.format_version != BACKUP_MANIFEST_FORMAT_VERSION
        || manifest.backup_id != backup_id
        || manifest.backup_kind != kind
        || manifest.created_at_ms != created_at_ms
        || manifest.size_bytes != size_bytes
        || manifest.storage_policy_version != BACKUP_STORAGE_POLICY_VERSION
        || manifest.data_classes != backup_manifest_data_classes()
    {
        return Err("The managed backup manifest does not match this archive.".to_string());
    }
    let actual_sha256 = sha256_file(backup, cancellation)?;
    if manifest.sha256 != actual_sha256 {
        return Err("The managed backup failed its manifest checksum verification.".to_string());
    }
    Ok(())
}

fn remove_backup_and_manifest(backup: &Path) -> Result<(), String> {
    fs::remove_file(backup).map_err(|error| {
        format!(
            "Could not rotate expired PostgreSQL backup {}: {error}",
            backup.display()
        )
    })?;
    let manifest = backup_manifest_path(backup)?;
    match fs::remove_file(&manifest) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not rotate expired PostgreSQL backup manifest {}: {error}",
            manifest.display()
        )),
    }
}

fn require_backup_manifest(backup: &Path) -> Result<(), String> {
    let path = backup_manifest_path(backup)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(
                "A manifest is required to reuse a pre-migration recovery point.".to_string(),
            )
        }
        Err(error) => {
            return Err(format!(
                "Could not inspect managed backup manifest: {error}"
            ))
        }
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("The managed backup manifest is not a regular file.".to_string());
    }
    Ok(())
}

fn verified_backup_exists<F>(directory: &Path, prefix: &str, mut verify: F) -> Result<bool, String>
where
    F: FnMut(&Path) -> Result<(), String>,
{
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect PostgreSQL backups: {error}"))?;
    let mut candidates = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not inspect PostgreSQL backup: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect PostgreSQL backup type: {error}"))?;
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some((_, timestamp)) = managed_backup_identity(&name) else {
            continue;
        };
        if name.starts_with(prefix) {
            candidates.push((timestamp, entry.path()));
        }
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    for (_, backup) in candidates {
        match require_backup_manifest(&backup).and_then(|_| verify(&backup)) {
            Ok(()) => return Ok(true),
            Err(error) if error.contains(MAINTENANCE_CANCELLED) => return Err(error),
            Err(error) => {
                let reason: String = error.chars().take(512).collect();
                super::observability::warn(
                    "managed_postgres.existing_backup_invalid",
                    serde_json::json!({
                        "backupId": backup.file_name().and_then(|name| name.to_str()),
                        "reason": reason,
                    }),
                );
            }
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

pub struct BackupStorageSummary {
    pub recovery_point_bytes: u64,
    pub automatic_recovery_bytes: u64,
    pub automatic_recovery_budget_bytes: u64,
}

pub fn backup_storage_summary(
    directory: &Path,
    filesystem_total_bytes: u64,
) -> Result<BackupStorageSummary, String> {
    let backups = backup_files(directory)?;
    let recovery_point_bytes = backups.iter().fold(0_u64, |total, backup| {
        total.saturating_add(backup.size_bytes)
    });
    let automatic_recovery_bytes = backups
        .iter()
        .filter(|backup| backup.kind != "manual")
        .fold(0_u64, |total, backup| {
            total.saturating_add(backup.size_bytes)
        });
    let estimated_backup_bytes = backups
        .iter()
        .max_by_key(|backup| backup.timestamp)
        .map(|backup| {
            backup
                .size_bytes
                .saturating_add(backup.size_bytes / 2)
                .max(BACKUP_ESTIMATE_MIN_BYTES)
        })
        .unwrap_or(BACKUP_ESTIMATE_MIN_BYTES);
    Ok(BackupStorageSummary {
        recovery_point_bytes,
        automatic_recovery_bytes,
        automatic_recovery_budget_bytes: backup_storage_budget(
            filesystem_total_bytes,
            estimated_backup_bytes,
        ),
    })
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
    verify_backup_manifest_if_present(&source, None)?;
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
    result?;
    if let Err(error) = write_backup_manifest(&destination, None) {
        let _ = fs::remove_file(&destination);
        if let Ok(manifest) = backup_manifest_path(&destination) {
            let _ = fs::remove_file(manifest);
        }
        return Err(error);
    }
    Ok(())
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

#[derive(Debug)]
struct BackupFile {
    path: PathBuf,
    kind: &'static str,
    timestamp: u64,
    size_bytes: u64,
}

fn backup_files(directory: &Path) -> Result<Vec<BackupFile>, String> {
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
        let Some((kind, timestamp)) = entry.file_name().to_str().and_then(managed_backup_identity)
        else {
            continue;
        };
        let size_bytes = entry
            .metadata()
            .map_err(|error| format!("Could not inspect PostgreSQL backup size: {error}"))?
            .len();
        backups.push(BackupFile {
            path: entry.path(),
            kind,
            timestamp,
            size_bytes,
        });
    }
    Ok(backups)
}

fn backup_storage_preflight(
    backup_directory: &Path,
    postgres_data_directory: &Path,
    new_kind: &str,
    cancellation: Option<&AtomicBool>,
) -> Result<u64, String> {
    let backups = backup_files(backup_directory)?;
    let estimated_bytes = match backups.iter().max_by_key(|backup| backup.timestamp) {
        Some(latest) => latest
            .size_bytes
            .saturating_add(latest.size_bytes / 2)
            .max(BACKUP_ESTIMATE_MIN_BYTES),
        None => {
            directory_size(postgres_data_directory, cancellation)?.max(BACKUP_ESTIMATE_MIN_BYTES)
        }
    };
    let filesystem_total_bytes = fs2::total_space(backup_directory)
        .map_err(|error| format!("Could not inspect backup storage capacity: {error}"))?;
    let filesystem_available_bytes = fs2::available_space(backup_directory)
        .map_err(|error| format!("Could not inspect available backup storage: {error}"))?;
    let required_available_bytes = estimated_bytes.saturating_add(BACKUP_FREE_SPACE_RESERVE_BYTES);
    if filesystem_available_bytes < required_available_bytes {
        return Err(format!(
            "Not enough free space to create a managed PostgreSQL backup safely. At least {} bytes must remain available after reserving space for the backup.",
            BACKUP_FREE_SPACE_RESERVE_BYTES
        ));
    }
    let budget = backup_storage_budget(filesystem_total_bytes, estimated_bytes);
    ensure_backup_fits_budget(backup_directory, new_kind, estimated_bytes, budget)?;
    Ok(budget)
}

fn backup_storage_budget(filesystem_total_bytes: u64, estimated_backup_bytes: u64) -> u64 {
    let baseline = (filesystem_total_bytes / 20)
        .clamp(BACKUP_BUDGET_MIN_BYTES, BACKUP_BUDGET_MAX_BYTES)
        .min(filesystem_total_bytes);
    baseline.max(estimated_backup_bytes)
}

fn ensure_backup_fits_budget(
    directory: &Path,
    new_kind: &str,
    new_size_bytes: u64,
    budget_bytes: u64,
) -> Result<(), String> {
    let backups = backup_files(directory)?;
    let newest_safety_bytes = (!is_safety_backup(new_kind))
        .then(|| {
            backups
                .iter()
                .filter(|backup| is_safety_backup(backup.kind))
                .max_by_key(|backup| backup.timestamp)
                .map(|backup| backup.size_bytes)
        })
        .flatten()
        .unwrap_or(0);
    let protected_bytes = new_size_bytes.saturating_add(newest_safety_bytes);
    if protected_bytes > budget_bytes {
        return Err(format!(
            "The managed backup would exceed the automatic recovery budget of {budget_bytes} bytes while preserving the latest safety recovery point."
        ));
    }
    Ok(())
}

fn enforce_backup_byte_budget(directory: &Path, budget_bytes: u64) -> Result<(), String> {
    let mut backups = backup_files(directory)?;
    let now_ms = unix_timestamp_millis()?;
    let mut retained_bytes = backups
        .iter()
        .filter(|backup| backup.kind != "manual")
        .fold(0_u64, |total, backup| {
            total.saturating_add(backup.size_bytes)
        });
    if retained_bytes <= budget_bytes {
        return Ok(());
    }

    let newest_path = backups
        .iter()
        .filter(|backup| backup.kind != "manual")
        .max_by_key(|backup| {
            (
                timestamp_is_credible(now_ms, backup.timestamp),
                backup.timestamp,
            )
        })
        .map(|backup| backup.path.clone());
    let newest_safety_path = backups
        .iter()
        .filter(|backup| is_safety_backup(backup.kind))
        .max_by_key(|backup| {
            (
                timestamp_is_credible(now_ms, backup.timestamp),
                backup.timestamp,
            )
        })
        .map(|backup| backup.path.clone());
    backups.sort_by_key(|backup| {
        let priority = if backup.kind == "automatic" { 0 } else { 1 };
        (priority, backup.timestamp)
    });
    for backup in backups {
        if retained_bytes <= budget_bytes {
            break;
        }
        if backup.kind == "manual"
            || newest_path.as_ref() == Some(&backup.path)
            || newest_safety_path.as_ref() == Some(&backup.path)
        {
            continue;
        }
        remove_backup_and_manifest(&backup.path)?;
        retained_bytes = retained_bytes.saturating_sub(backup.size_bytes);
    }
    if retained_bytes > budget_bytes {
        return Err(format!(
            "Managed recovery points use {retained_bytes} bytes, exceeding the automatic recovery budget of {budget_bytes} bytes; protected recovery points were retained."
        ));
    }
    Ok(())
}

fn directory_size(path: &Path, cancellation: Option<&AtomicBool>) -> Result<u64, String> {
    if cancellation.is_some_and(|token| token.load(Ordering::Acquire)) {
        return Err(MAINTENANCE_CANCELLED.to_string());
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(format!(
                "Could not inspect managed PostgreSQL storage: {error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut total = 0_u64;
    for entry in fs::read_dir(path)
        .map_err(|error| format!("Could not inspect managed PostgreSQL storage: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("Could not inspect managed PostgreSQL storage: {error}"))?;
        total = total.saturating_add(directory_size(&entry.path(), cancellation)?);
    }
    Ok(total)
}

fn is_safety_backup(kind: &str) -> bool {
    matches!(kind, "pre-migration" | "pre-restore" | "pre-update")
}

fn backup_retention_class(kind: &str) -> &str {
    if is_safety_backup(kind) {
        "safety"
    } else {
        kind
    }
}

fn rotate_backups(directory: &Path) -> Result<(), String> {
    let mut backups = backup_files(directory)?;
    let now_ms = unix_timestamp_millis()?;
    backups.sort_by_key(|backup| {
        (
            backup_retention_class(backup.kind),
            std::cmp::Reverse((
                backup.kind == "manual" || timestamp_is_credible(now_ms, backup.timestamp),
                backup.timestamp,
            )),
        )
    });
    let mut seen = std::collections::HashMap::<&str, usize>::new();
    for expired in backups.into_iter().filter(|backup| {
        let class = backup_retention_class(backup.kind);
        let count = seen.entry(class).or_default();
        *count += 1;
        *count > backup_retention(class)
    }) {
        remove_backup_and_manifest(&expired.path)?;
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
        sync::atomic::AtomicBool,
    };

    use age::{secrecy::SecretString, x25519};

    use super::super::secret_store::random_secret;

    use super::{
        acquire_root_lock, automatic_backup_is_due, commit_integrity_marker,
        copy_with_cancellation, drain_process_output, enforce_backup_byte_budget,
        ensure_backup_fits_budget, integrity_check_is_due, last_integrity_check_at,
        latest_recovery_point_at, list_backups, maintenance_is_due, postgres_binary,
        remove_incomplete_backups, resolve_managed_backup, retain_staged_managed_backup,
        rotate_backups, safe_filename_component, stage_managed_backup, stream_archive_to,
        unix_timestamp_millis, verified_backup_exists, verify_backup_manifest_if_present,
        write_backup_manifest, ManagedPostgres, AUTOMATIC_BACKUP_RETENTION_COUNT,
        BACKUP_BUDGET_MAX_BYTES, BACKUP_BUDGET_MIN_BYTES, DATABASE_NAME, INTEGRITY_MARKER_PREFIX,
        MAINTENANCE_CANCELLED, MANUAL_BACKUP_RETENTION_COUNT, PROCESS_OUTPUT_LIMIT,
        SAFETY_BACKUP_RETENTION_COUNT,
    };

    struct EarlyClosingWriter {
        bytes_before_close: usize,
    }

    #[test]
    fn marks_daily_and_weekly_protection_due_during_long_running_sessions() {
        let hour = 60 * 60 * 1_000;
        let day = 24 * hour;
        let week = 7 * day;

        assert!(maintenance_is_due(48 * hour, Some(24 * hour), day));
        assert!(maintenance_is_due(8 * day, Some(day), week));
        assert!(!maintenance_is_due(day - 1, Some(0), day));
        assert!(!maintenance_is_due(day, Some(day + 1), day));
        assert!(maintenance_is_due(day, Some(day + hour), day));
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
    fn drains_process_output_without_retaining_unbounded_diagnostics() {
        let payload = vec![7_u8; PROCESS_OUTPUT_LIMIT + 8 * 1024];

        let (output, truncated) = drain_process_output(Cursor::new(payload)).unwrap();

        assert_eq!(output.len(), PROCESS_OUTPUT_LIMIT);
        assert!(truncated);
    }

    #[test]
    fn retains_complete_process_output_within_the_diagnostic_limit() {
        let payload = vec![7_u8; 8 * 1024];

        let (output, truncated) = drain_process_output(Cursor::new(payload.clone())).unwrap();

        assert_eq!(output, payload);
        assert!(!truncated);
    }

    #[test]
    fn drains_an_archive_when_a_successful_reader_closes_its_pipe_early() {
        let payload = vec![7_u8; 64];
        let mut plaintext = Cursor::new(payload.clone());
        let mut output = EarlyClosingWriter {
            bytes_before_close: 8,
        };

        stream_archive_to(&mut plaintext, &mut output, "backup verification", None).unwrap();

        assert_eq!(plaintext.position(), payload.len() as u64);
    }

    #[test]
    fn cancels_archive_streaming_before_reading_more_data() {
        let mut plaintext = Cursor::new(vec![7_u8; 64]);
        let mut output = Vec::new();
        let cancellation = AtomicBool::new(true);

        let error =
            copy_with_cancellation(&mut plaintext, &mut output, Some(&cancellation)).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(plaintext.position(), 0);
        assert!(output.is_empty());
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
    fn binds_managed_backup_manifests_to_archive_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let backup = directory.path().join("manual-10.dump.age");
        fs::write(&backup, b"encrypted archive").unwrap();

        write_backup_manifest(&backup, None).unwrap();
        verify_backup_manifest_if_present(&backup, None).unwrap();

        fs::write(&backup, b"encrypted archivf").unwrap();
        let error = verify_backup_manifest_if_present(&backup, None).unwrap_err();
        assert!(error.contains("manifest checksum"));
    }

    #[test]
    fn pre_migration_dedup_uses_only_the_newest_verified_regular_backup() {
        let directory = tempfile::tempdir().unwrap();
        let prefix = "pre-migration-v0.2.2-";
        fs::create_dir(directory.path().join(format!("{prefix}30.dump.age"))).unwrap();
        fs::write(
            directory.path().join(format!("{prefix}20.dump.age")),
            b"invalid",
        )
        .unwrap();
        fs::write(
            directory
                .path()
                .join(format!("{prefix}20.dump.age.manifest.json")),
            b"manifest",
        )
        .unwrap();
        fs::write(
            directory.path().join(format!("{prefix}10.dump.age")),
            b"valid",
        )
        .unwrap();
        fs::write(
            directory
                .path()
                .join(format!("{prefix}10.dump.age.manifest.json")),
            b"manifest",
        )
        .unwrap();
        fs::write(directory.path().join("manual-40.dump.age"), b"unrelated").unwrap();
        fs::write(
            directory
                .path()
                .join(format!("{prefix}not-a-time.dump.age")),
            b"malformed",
        )
        .unwrap();
        let mut inspected = Vec::new();

        let exists = verified_backup_exists(directory.path(), prefix, |backup| {
            let name = backup.file_name().unwrap().to_string_lossy().to_string();
            inspected.push(name.clone());
            if name == format!("{prefix}10.dump.age") {
                Ok(())
            } else {
                Err("archive is corrupt".to_string())
            }
        })
        .unwrap();

        assert!(exists);
        assert_eq!(
            inspected,
            vec![
                format!("{prefix}20.dump.age"),
                format!("{prefix}10.dump.age")
            ]
        );
    }

    #[test]
    fn pre_migration_dedup_creates_a_new_backup_when_all_candidates_are_invalid() {
        let directory = tempfile::tempdir().unwrap();
        let prefix = "pre-migration-v0.2.2-";
        fs::write(
            directory.path().join(format!("{prefix}10.dump.age")),
            b"invalid",
        )
        .unwrap();
        fs::write(
            directory
                .path()
                .join(format!("{prefix}10.dump.age.manifest.json")),
            b"manifest",
        )
        .unwrap();

        assert!(!verified_backup_exists(directory.path(), prefix, |_| {
            Err("archive is corrupt".to_string())
        })
        .unwrap());
    }

    #[test]
    fn pre_migration_dedup_propagates_maintenance_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let prefix = "pre-migration-v0.2.2-";
        fs::write(
            directory.path().join(format!("{prefix}10.dump.age")),
            b"candidate",
        )
        .unwrap();
        fs::write(
            directory
                .path()
                .join(format!("{prefix}10.dump.age.manifest.json")),
            b"manifest",
        )
        .unwrap();

        let error = verified_backup_exists(directory.path(), prefix, |_| {
            Err(MAINTENANCE_CANCELLED.to_string())
        })
        .unwrap_err();

        assert_eq!(error, MAINTENANCE_CANCELLED);
    }

    #[test]
    fn pre_migration_dedup_rejects_a_legacy_archive_without_a_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let prefix = "pre-migration-v0.2.2-";
        fs::write(
            directory.path().join(format!("{prefix}10.dump.age")),
            b"legacy archive",
        )
        .unwrap();
        let mut inspected = false;

        let exists = verified_backup_exists(directory.path(), prefix, |_| {
            inspected = true;
            Ok(())
        })
        .unwrap();

        assert!(!exists);
        assert!(!inspected);
    }

    #[cfg(unix)]
    #[test]
    fn pre_migration_dedup_never_follows_symlink_candidates() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let external = tempfile::NamedTempFile::new().unwrap();
        let prefix = "pre-migration-v0.2.2-";
        symlink(
            external.path(),
            directory.path().join(format!("{prefix}10.dump.age")),
        )
        .unwrap();
        let mut inspected = false;

        let exists = verified_backup_exists(directory.path(), prefix, |_| {
            inspected = true;
            Ok(())
        })
        .unwrap();

        assert!(!exists);
        assert!(!inspected);
    }

    #[test]
    fn rotates_a_managed_backup_and_its_manifest_together() {
        let directory = tempfile::tempdir().unwrap();
        let oldest = directory.path().join("automatic-0.dump.age");
        fs::write(&oldest, b"oldest").unwrap();
        write_backup_manifest(&oldest, None).unwrap();
        for index in 1..=AUTOMATIC_BACKUP_RETENTION_COUNT {
            fs::write(
                directory.path().join(format!("automatic-{index}.dump.age")),
                index.to_string(),
            )
            .unwrap();
        }

        rotate_backups(directory.path()).unwrap();

        assert!(!oldest.exists());
        assert!(!directory
            .path()
            .join("automatic-0.dump.age.manifest.json")
            .exists());
    }

    #[test]
    fn rotates_automatic_manual_and_shared_safety_retention_classes() {
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
        );
        assert!(directory
            .path()
            .join("pre-update-v0.2.0-to-v0.3.0-101.dump.age")
            .exists());
        assert!(directory.path().join("user-owned.dump.age").exists());
    }

    #[test]
    fn byte_budget_prunes_automatic_backups_but_preserves_latest_safety_and_manual() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("automatic-1.dump.age"), [1; 6]).unwrap();
        fs::write(directory.path().join("automatic-4.dump.age"), [1; 6]).unwrap();
        fs::write(
            directory.path().join("pre-migration-v0.1.0-3.dump.age"),
            [1; 6],
        )
        .unwrap();
        fs::write(directory.path().join("manual-2.dump.age"), [1; 100]).unwrap();

        enforce_backup_byte_budget(directory.path(), 12).unwrap();

        assert!(!directory.path().join("automatic-1.dump.age").exists());
        assert!(directory.path().join("automatic-4.dump.age").exists());
        assert!(directory
            .path()
            .join("pre-migration-v0.1.0-3.dump.age")
            .exists());
        assert!(directory.path().join("manual-2.dump.age").exists());
    }

    #[test]
    fn byte_budget_does_not_preserve_an_implausibly_future_backup_over_a_current_one() {
        let directory = tempfile::tempdir().unwrap();
        let now = unix_timestamp_millis().unwrap();
        let current = directory.path().join(format!("automatic-{now}.dump.age"));
        let future = directory
            .path()
            .join(format!("automatic-{}.dump.age", u64::MAX));
        fs::write(&current, [1; 6]).unwrap();
        fs::write(&future, [1; 6]).unwrap();

        enforce_backup_byte_budget(directory.path(), 6).unwrap();

        assert!(current.exists());
        assert!(!future.exists());
    }

    #[test]
    fn capacity_check_does_not_replace_the_latest_safety_point_with_an_automatic_backup() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory
                .path()
                .join("pre-update-v0.1.0-to-v0.2.0-1.dump.age"),
            [1; 8],
        )
        .unwrap();

        assert!(ensure_backup_fits_budget(directory.path(), "automatic", 10, 17).is_err());
        assert!(ensure_backup_fits_budget(directory.path(), "pre-update", 10, 10).is_ok());
    }

    #[test]
    fn storage_budget_is_bounded_but_can_fit_one_large_recovery_point() {
        assert_eq!(
            super::backup_storage_budget(20 * BACKUP_BUDGET_MIN_BYTES, 1),
            BACKUP_BUDGET_MIN_BYTES
        );
        assert_eq!(
            super::backup_storage_budget(u64::MAX, 1),
            BACKUP_BUDGET_MAX_BYTES
        );
        assert_eq!(
            super::backup_storage_budget(u64::MAX, BACKUP_BUDGET_MAX_BYTES + 1),
            BACKUP_BUDGET_MAX_BYTES + 1
        );
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

        assert_eq!(
            last_integrity_check_at(directory.path(), 20).unwrap(),
            Some(20)
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn scheduling_ignores_implausibly_future_backup_and_integrity_timestamps() {
        let backup_directory = tempfile::tempdir().unwrap();
        let integrity_directory = tempfile::tempdir().unwrap();
        let now = 1_000;
        fs::write(backup_directory.path().join("automatic-900.dump.age"), [1]).unwrap();
        fs::write(
            backup_directory
                .path()
                .join(format!("automatic-{}.dump.age", u64::MAX)),
            [1],
        )
        .unwrap();
        fs::write(
            integrity_directory
                .path()
                .join(format!("{INTEGRITY_MARKER_PREFIX}900")),
            [],
        )
        .unwrap();
        fs::write(
            integrity_directory
                .path()
                .join(format!("{INTEGRITY_MARKER_PREFIX}{}", u64::MAX)),
            [],
        )
        .unwrap();

        let backups = list_backups(backup_directory.path()).unwrap();
        assert_eq!(latest_recovery_point_at(&backups, now), Some(900));
        assert!(!automatic_backup_is_due(backup_directory.path(), now).unwrap());
        assert_eq!(
            last_integrity_check_at(integrity_directory.path(), now).unwrap(),
            Some(900)
        );
        assert!(!integrity_check_is_due(integrity_directory.path(), now).unwrap());

        fs::remove_file(backup_directory.path().join("automatic-900.dump.age")).unwrap();
        fs::remove_file(
            integrity_directory
                .path()
                .join(format!("{INTEGRITY_MARKER_PREFIX}900")),
        )
        .unwrap();
        assert!(automatic_backup_is_due(backup_directory.path(), now).unwrap());
        assert_eq!(
            last_integrity_check_at(integrity_directory.path(), now).unwrap(),
            None
        );
        assert!(integrity_check_is_due(integrity_directory.path(), now).unwrap());
    }

    #[test]
    fn retention_keeps_a_current_backup_ahead_of_future_clock_anomalies() {
        let directory = tempfile::tempdir().unwrap();
        let now = unix_timestamp_millis().unwrap();
        let current = directory.path().join(format!("automatic-{now}.dump.age"));
        fs::write(&current, [1]).unwrap();
        for offset in 0..AUTOMATIC_BACKUP_RETENTION_COUNT {
            fs::write(
                directory
                    .path()
                    .join(format!("automatic-{}.dump.age", u64::MAX - offset as u64)),
                [1],
            )
            .unwrap();
        }

        rotate_backups(directory.path()).unwrap();

        assert!(current.exists());
        assert_eq!(
            list_backups(directory.path()).unwrap().len(),
            AUTOMATIC_BACKUP_RETENTION_COUNT
        );
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
        let mut postgres = ManagedPostgres::start(cluster.path(), random_secret(48)).unwrap();
        execute_sql(
            &postgres,
            "CREATE TABLE restore_probe(value text NOT NULL); INSERT INTO restore_probe VALUES ('before');",
        );
        postgres.database_preexisting = true;
        let integrity_state = tempfile::tempdir().unwrap();
        let cancellation = AtomicBool::new(false);
        assert!(postgres
            .verify_integrity_if_due(integrity_state.path(), &cancellation)
            .unwrap());
        assert!(!postgres
            .verify_integrity_if_due(integrity_state.path(), &cancellation)
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
