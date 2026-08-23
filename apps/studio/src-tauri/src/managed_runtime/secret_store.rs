use std::{
    fs::{self, File},
    io::{self, Read},
    path::PathBuf,
};

use age::{secrecy::ExposeSecret, x25519};
use dirs::data_dir;
use keyring::{Entry, Error as KeyringError};
use rand::{distr::Alphanumeric, RngExt};
use serde::{Deserialize, Serialize};

const STORE_SCHEMA_VERSION: u8 = 1;
const STORE_DIRECTORY: &str = "dev.hiepknor.wastudio";
const STORE_FILE: &str = "secrets.json";
const RUNTIME_CREDENTIALS_ENTRY: &str = "runtime-credentials-v2";
const POSTGRES_PASSWORD_ENTRY: &str = "postgres-password-v1";
const BACKUP_IDENTITY_ENTRY: &str = "backup-identity-v1";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalSecretFile {
    schema_version: u8,
    runtime: Option<ManagedRuntimeCredentials>,
    postgres_password: Option<String>,
    backup_identity: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeCredentials {
    pub schema_version: u8,
    pub runtime_api_key: String,
    pub device_id: String,
    pub openwa_base_url: String,
    pub openwa_api_key: String,
    pub openwa_webhook_secret: String,
    pub openwa_allowed_session_ids: Vec<String>,
    pub event_inbox_base_url: String,
    pub event_inbox_device_token: String,
    pub event_inbox_callback_url: String,
    pub allow_live_sends: bool,
}

pub fn managed_postgres_password() -> Result<String, String> {
    migrate_legacy_store()?;
    if let Some(password) = read_secure_entry(POSTGRES_PASSWORD_ENTRY, "PostgreSQL password")? {
        if password.len() >= 32 {
            return Ok(password);
        }
        return Err("The managed PostgreSQL local secret is invalid.".to_string());
    }
    let password = random_secret(48);
    write_secure_entry(POSTGRES_PASSWORD_ENTRY, "PostgreSQL password", &password)?;
    Ok(password)
}

pub fn managed_postgres_backup_identity() -> Result<x25519::Identity, String> {
    migrate_legacy_store()?;
    if let Some(encoded) = read_secure_entry(BACKUP_IDENTITY_ENTRY, "backup identity")? {
        return parse_backup_identity(&encoded);
    }
    let identity = x25519::Identity::generate();
    write_secure_entry(
        BACKUP_IDENTITY_ENTRY,
        "backup identity",
        identity.to_string().expose_secret(),
    )?;
    Ok(identity)
}

pub fn parse_backup_identity(encoded: &str) -> Result<x25519::Identity, String> {
    encoded
        .parse()
        .map_err(|error| format!("The managed PostgreSQL backup identity is invalid: {error}"))
}

pub fn save_managed_runtime_credentials(
    credentials: &ManagedRuntimeCredentials,
) -> Result<(), String> {
    migrate_legacy_store()?;
    let encoded = serde_json::to_string(credentials)
        .map_err(|error| format!("Could not encode Managed Runtime credentials: {error}"))?;
    write_secure_entry(RUNTIME_CREDENTIALS_ENTRY, "Runtime credentials", &encoded)
}

pub fn load_managed_runtime_credentials() -> Result<Option<ManagedRuntimeCredentials>, String> {
    migrate_legacy_store()?;
    let Some(encoded) = read_secure_entry(RUNTIME_CREDENTIALS_ENTRY, "Runtime credentials")? else {
        return Ok(None);
    };
    let credentials: ManagedRuntimeCredentials = serde_json::from_str(&encoded)
        .map_err(|_| "Managed Runtime credentials have an unsupported format.".to_string())?;
    if credentials.schema_version != 2
        || credentials.runtime_api_key.len() < 32
        || credentials.event_inbox_device_token.len() < 32
        || credentials.openwa_webhook_secret.len() < 32
    {
        return Err("Managed Runtime credentials have an unsupported format.".to_string());
    }
    Ok(Some(credentials))
}

pub(crate) fn random_secret(length: usize) -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn store_path() -> Result<PathBuf, String> {
    data_dir()
        .map(|directory| directory.join(STORE_DIRECTORY).join(STORE_FILE))
        .ok_or_else(|| "Could not resolve the WA Studio application data directory.".to_string())
}

fn secure_entry(account: &str, label: &str) -> Result<Entry, String> {
    Entry::new(STORE_DIRECTORY, account).map_err(|error| secure_store_error(label, error))
}

fn read_secure_entry(account: &str, label: &str) -> Result<Option<String>, String> {
    let entry = secure_entry(account, label)?;
    read_secure_result(entry.get_password(), label)
}

fn read_secure_result(
    result: Result<String, KeyringError>,
    label: &str,
) -> Result<Option<String>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(secure_store_error(label, error)),
    }
}

fn write_secure_entry(account: &str, label: &str, value: &str) -> Result<(), String> {
    secure_entry(account, label)?
        .set_password(value)
        .map_err(|error| secure_store_error(label, error))
}

fn secure_store_error(label: &str, error: KeyringError) -> String {
    format!("Could not access {label} in the operating system credential store: {error}")
}

fn migrate_legacy_store() -> Result<(), String> {
    let Some(store) = load_legacy_store()? else {
        return Ok(());
    };
    if let Some(credentials) = store.runtime {
        let encoded = serde_json::to_string(&credentials)
            .map_err(|error| format!("Could not encode Managed Runtime credentials: {error}"))?;
        write_secure_entry_if_missing(RUNTIME_CREDENTIALS_ENTRY, "Runtime credentials", &encoded)?;
    }
    if let Some(password) = store.postgres_password {
        write_secure_entry_if_missing(POSTGRES_PASSWORD_ENTRY, "PostgreSQL password", &password)?;
    }
    if let Some(identity) = store.backup_identity {
        write_secure_entry_if_missing(BACKUP_IDENTITY_ENTRY, "backup identity", &identity)?;
    }
    let path = store_path()?;
    fs::remove_file(&path).map_err(|error| {
        format!(
            "Managed secrets were migrated to the operating system credential store, but the legacy secret file could not be removed: {error}"
        )
    })
}

fn write_secure_entry_if_missing(account: &str, label: &str, value: &str) -> Result<(), String> {
    if read_secure_entry(account, label)?.is_none() {
        write_secure_entry(account, label, value)?;
    }
    Ok(())
}

fn load_legacy_store() -> Result<Option<LocalSecretFile>, String> {
    let path = store_path()?;
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read local WA Studio secrets: {error}")),
    };
    let mut encoded = String::new();
    file.read_to_string(&mut encoded)
        .map_err(|error| format!("Could not read local WA Studio secrets: {error}"))?;
    let store: LocalSecretFile = serde_json::from_str(&encoded)
        .map_err(|error| format!("Local WA Studio secrets are invalid: {error}"))?;
    if store.schema_version != STORE_SCHEMA_VERSION {
        return Err("Local WA Studio secrets have an unsupported format.".to_string());
    }
    Ok(Some(store))
}

#[cfg(test)]
mod tests {
    use age::secrecy::ExposeSecret;

    use keyring::Error as KeyringError;

    use super::{parse_backup_identity, random_secret, read_secure_result};

    #[test]
    fn generated_secret_has_requested_length() {
        assert_eq!(random_secret(48).len(), 48);
    }

    #[test]
    fn backup_identity_round_trips() {
        let identity = age::x25519::Identity::generate();
        let encoded = identity.to_string();
        let restored = parse_backup_identity(encoded.expose_secret()).unwrap();
        assert_eq!(
            encoded.expose_secret(),
            restored.to_string().expose_secret()
        );
    }

    #[test]
    fn credential_store_failures_do_not_fall_back_to_plaintext_storage() {
        let error = read_secure_result(Err(KeyringError::NoDefaultStore), "Runtime credentials")
            .unwrap_err();

        assert!(error.contains("operating system credential store"));
    }
}
