use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use age::{secrecy::ExposeSecret, x25519};
use dirs::data_dir;
use rand::{distr::Alphanumeric, RngExt};
use serde::{Deserialize, Serialize};

const STORE_SCHEMA_VERSION: u8 = 1;
const STORE_DIRECTORY: &str = "dev.hiepknor.wastudio";
const STORE_FILE: &str = "secrets.json";

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
    let mut store = load_store()?;
    if let Some(password) = store.postgres_password {
        if password.len() >= 32 {
            return Ok(password);
        }
        return Err("The managed PostgreSQL local secret is invalid.".to_string());
    }
    let password = random_secret(48);
    store.postgres_password = Some(password.clone());
    save_store(&store)?;
    Ok(password)
}

pub fn managed_postgres_backup_identity() -> Result<x25519::Identity, String> {
    let mut store = load_store()?;
    if let Some(encoded) = store.backup_identity {
        return parse_backup_identity(&encoded);
    }
    let identity = x25519::Identity::generate();
    store.backup_identity = Some(identity.to_string().expose_secret().to_string());
    save_store(&store)?;
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
    let mut store = load_store()?;
    store.runtime = Some(credentials.clone());
    save_store(&store)
}

pub fn load_managed_runtime_credentials() -> Result<Option<ManagedRuntimeCredentials>, String> {
    let Some(store) = load_store_optional()? else {
        return Ok(None);
    };
    let Some(credentials) = store.runtime else {
        return Ok(None);
    };
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

fn load_store() -> Result<LocalSecretFile, String> {
    Ok(load_store_optional()?.unwrap_or(LocalSecretFile {
        schema_version: STORE_SCHEMA_VERSION,
        ..LocalSecretFile::default()
    }))
}

fn load_store_optional() -> Result<Option<LocalSecretFile>, String> {
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

fn save_store(store: &LocalSecretFile) -> Result<(), String> {
    let path = store_path()?;
    let directory = path
        .parent()
        .ok_or_else(|| "Local WA Studio secret path has no parent directory.".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the WA Studio data directory: {error}"))?;
    restrict_directory(directory)?;

    let temporary = directory.join(format!(".{STORE_FILE}.{}.tmp", std::process::id()));
    let encoded = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("Could not encode local WA Studio secrets: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create local WA Studio secret file: {error}"))?;
    restrict_file(&file)?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write local WA Studio secrets: {error}"))?;
    drop(file);
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not commit local WA Studio secrets: {error}"))?;
    restrict_file_path(&path)?;
    Ok(())
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not restrict WA Studio data directory: {error}"))
}

#[cfg(not(unix))]
fn restrict_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(file: &File) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not restrict local WA Studio secret file: {error}"))
}

#[cfg(not(unix))]
fn restrict_file(_file: &File) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file_path(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not restrict local WA Studio secret file: {error}"))
}

#[cfg(not(unix))]
fn restrict_file_path(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use age::secrecy::ExposeSecret;

    use super::{parse_backup_identity, random_secret};

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
}
