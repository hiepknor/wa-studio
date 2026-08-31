use std::{
    fs::{self, File},
    io::{self, Read},
    path::PathBuf,
};

use age::{secrecy::ExposeSecret, x25519};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use dirs::data_dir;
use keyring::{Entry, Error as KeyringError};
use rand::{distr::Alphanumeric, RngExt};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

const STORE_SCHEMA_VERSION: u8 = 1;
const STORE_DIRECTORY: &str = "dev.hiepknor.wastudio";
const STORE_FILE: &str = "secrets.json";
const RUNTIME_CREDENTIALS_ENTRY: &str = "runtime-credentials-v2";
const RUNTIME_PROVISIONING_ENTRY: &str = "runtime-provisioning-v1";
const RUNTIME_LIFECYCLE_ENTRY: &str = "runtime-lifecycle-v1";
const RUNTIME_CLEANUP_ENTRY: &str = "runtime-cleanup-v1";
const RUNTIME_CONNECTOR_ROTATION_ENTRY: &str = "runtime-connector-rotation-v1";
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
    #[serde(default)]
    pub connector: Option<ManagedOpenWaConnectorCredentials>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedOpenWaConnectorCredentials {
    pub connector_id: String,
    pub token_generation: u64,
    pub connector_token: String,
    pub session_id: String,
    pub plugin_version: String,
    pub ingress_instance_id: String,
    pub ingress_secret: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeProvisioningIntent {
    pub schema_version: u8,
    pub runtime_api_key: String,
    pub device_id: String,
    pub openwa_base_url: String,
    pub openwa_api_key: String,
    pub allow_live_sends: bool,
    pub connector_id: String,
    pub connector_secret: String,
    pub connector_token_generation: u64,
    pub ingress_instance_id: String,
    pub ingress_secret: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedRuntimeLifecycleOperation {
    Reconfigure,
    Reset,
    RotateConnectorCredential,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedRuntimeLifecyclePhase {
    Prepared,
    WorkspaceBlocked,
    RuntimeDrained,
    RuntimeStopped,
    RemoteMutated,
    RuntimeRestarted,
    Verified,
    Resumed,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeLifecycleIntent {
    pub schema_version: u8,
    pub operation_id: String,
    pub operation: ManagedRuntimeLifecycleOperation,
    pub phase: ManagedRuntimeLifecyclePhase,
    pub target_fingerprint: String,
    pub block_idempotency_key: String,
    pub resume_idempotency_key: String,
    #[serde(default)]
    pub baseline_connector_observed_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedRuntimeCleanupOperation {
    Reset,
    Replace,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedRuntimeCleanupPhase {
    Prepared,
    OpenWaCleaned,
    RemoteCleaned,
    DeviceRevoked,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeCleanupIntent {
    pub schema_version: u8,
    pub operation_id: String,
    pub operation: ManagedRuntimeCleanupOperation,
    pub phase: ManagedRuntimeCleanupPhase,
    pub source: ManagedRuntimeCredentials,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeConnectorRotationIntent {
    pub schema_version: u8,
    pub connector_id: String,
    pub source_generation: u64,
    pub target_generation: u64,
    pub connector_secret: String,
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
    if !matches!(credentials.schema_version, 2 | 3)
        || credentials.runtime_api_key.len() < 32
        || credentials.event_inbox_device_token.len() < 32
        || credentials.openwa_webhook_secret.len() < 32
        || (credentials.schema_version == 3 && credentials.connector.is_none())
    {
        return Err("Managed Runtime credentials have an unsupported format.".to_string());
    }
    Ok(Some(credentials))
}

pub fn clear_managed_runtime_credentials() -> Result<(), String> {
    let entry = secure_entry(RUNTIME_CREDENTIALS_ENTRY, "Runtime credentials")?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(secure_store_error("Runtime credentials", error)),
    }
}

pub fn save_managed_runtime_provisioning_intent(
    intent: &ManagedRuntimeProvisioningIntent,
) -> Result<(), String> {
    migrate_legacy_store()?;
    let encoded = serde_json::to_string(intent)
        .map_err(|error| format!("Could not encode Managed Runtime provisioning state: {error}"))?;
    write_secure_entry(
        RUNTIME_PROVISIONING_ENTRY,
        "Runtime provisioning state",
        &encoded,
    )
}

pub fn load_managed_runtime_provisioning_intent(
) -> Result<Option<ManagedRuntimeProvisioningIntent>, String> {
    migrate_legacy_store()?;
    let Some(encoded) =
        read_secure_entry(RUNTIME_PROVISIONING_ENTRY, "Runtime provisioning state")?
    else {
        return Ok(None);
    };
    let intent: ManagedRuntimeProvisioningIntent = serde_json::from_str(&encoded)
        .map_err(|_| "Managed Runtime provisioning state has an unsupported format.".to_string())?;
    if intent.schema_version != 1
        || intent.runtime_api_key.len() < 32
        || intent.connector_secret.len() != 43
        || intent.connector_token_generation == 0
        || intent.ingress_secret.len() < 32
    {
        return Err("Managed Runtime provisioning state has an unsupported format.".to_string());
    }
    Ok(Some(intent))
}

pub fn clear_managed_runtime_provisioning_intent() -> Result<(), String> {
    let entry = secure_entry(RUNTIME_PROVISIONING_ENTRY, "Runtime provisioning state")?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(secure_store_error("Runtime provisioning state", error)),
    }
}

pub fn save_managed_runtime_lifecycle_intent(
    intent: &ManagedRuntimeLifecycleIntent,
) -> Result<(), String> {
    migrate_legacy_store()?;
    let encoded = serde_json::to_string(intent)
        .map_err(|error| format!("Could not encode Managed Runtime lifecycle state: {error}"))?;
    write_secure_entry(RUNTIME_LIFECYCLE_ENTRY, "Runtime lifecycle state", &encoded)
}

pub fn load_managed_runtime_lifecycle_intent(
) -> Result<Option<ManagedRuntimeLifecycleIntent>, String> {
    migrate_legacy_store()?;
    let Some(encoded) = read_secure_entry(RUNTIME_LIFECYCLE_ENTRY, "Runtime lifecycle state")?
    else {
        return Ok(None);
    };
    let intent: ManagedRuntimeLifecycleIntent = serde_json::from_str(&encoded)
        .map_err(|_| "Managed Runtime lifecycle state has an unsupported format.".to_string())?;
    if intent.schema_version != 1
        || uuid::Uuid::parse_str(&intent.operation_id).is_err()
        || uuid::Uuid::parse_str(&intent.block_idempotency_key).is_err()
        || uuid::Uuid::parse_str(&intent.resume_idempotency_key).is_err()
        || intent.target_fingerprint.len() != 64
        || !intent
            .target_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Managed Runtime lifecycle state has an unsupported format.".to_string());
    }
    Ok(Some(intent))
}

pub fn clear_managed_runtime_lifecycle_intent() -> Result<(), String> {
    let entry = secure_entry(RUNTIME_LIFECYCLE_ENTRY, "Runtime lifecycle state")?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(secure_store_error("Runtime lifecycle state", error)),
    }
}

pub fn save_managed_runtime_cleanup_intent(
    intent: &ManagedRuntimeCleanupIntent,
) -> Result<(), String> {
    migrate_legacy_store()?;
    let encoded = serde_json::to_string(intent)
        .map_err(|error| format!("Could not encode Managed Runtime cleanup state: {error}"))?;
    write_secure_entry(RUNTIME_CLEANUP_ENTRY, "Runtime cleanup state", &encoded)
}

pub fn load_managed_runtime_cleanup_intent() -> Result<Option<ManagedRuntimeCleanupIntent>, String>
{
    migrate_legacy_store()?;
    let Some(encoded) = read_secure_entry(RUNTIME_CLEANUP_ENTRY, "Runtime cleanup state")? else {
        return Ok(None);
    };
    let intent: ManagedRuntimeCleanupIntent = serde_json::from_str(&encoded)
        .map_err(|_| "Managed Runtime cleanup state has an unsupported format.".to_string())?;
    if intent.schema_version != 1
        || uuid::Uuid::parse_str(&intent.operation_id).is_err()
        || !matches!(intent.source.schema_version, 2 | 3)
        || intent.source.runtime_api_key.len() < 32
        || intent.source.event_inbox_device_token.len() < 32
        || intent.source.openwa_webhook_secret.len() < 32
        || (intent.source.schema_version == 3 && intent.source.connector.is_none())
    {
        return Err("Managed Runtime cleanup state has an unsupported format.".to_string());
    }
    Ok(Some(intent))
}

pub fn clear_managed_runtime_cleanup_intent() -> Result<(), String> {
    let entry = secure_entry(RUNTIME_CLEANUP_ENTRY, "Runtime cleanup state")?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(secure_store_error("Runtime cleanup state", error)),
    }
}

pub fn save_managed_runtime_connector_rotation_intent(
    intent: &ManagedRuntimeConnectorRotationIntent,
) -> Result<(), String> {
    migrate_legacy_store()?;
    let encoded = serde_json::to_string(intent).map_err(|error| {
        format!("Could not encode Managed Runtime connector rotation state: {error}")
    })?;
    write_secure_entry(
        RUNTIME_CONNECTOR_ROTATION_ENTRY,
        "Runtime connector rotation state",
        &encoded,
    )
}

pub fn load_managed_runtime_connector_rotation_intent(
) -> Result<Option<ManagedRuntimeConnectorRotationIntent>, String> {
    migrate_legacy_store()?;
    let Some(encoded) = read_secure_entry(
        RUNTIME_CONNECTOR_ROTATION_ENTRY,
        "Runtime connector rotation state",
    )?
    else {
        return Ok(None);
    };
    let intent: ManagedRuntimeConnectorRotationIntent =
        serde_json::from_str(&encoded).map_err(|_| {
            "Managed Runtime connector rotation state has an unsupported format.".to_string()
        })?;
    if intent.schema_version != 1
        || uuid::Uuid::parse_str(&intent.connector_id).is_err()
        || intent.source_generation == 0
        || intent.target_generation != intent.source_generation.saturating_add(1)
        || intent.connector_secret.len() != 43
    {
        return Err(
            "Managed Runtime connector rotation state has an unsupported format.".to_string(),
        );
    }
    Ok(Some(intent))
}

pub fn clear_managed_runtime_connector_rotation_intent() -> Result<(), String> {
    let entry = secure_entry(
        RUNTIME_CONNECTOR_ROTATION_ENTRY,
        "Runtime connector rotation state",
    )?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(secure_store_error(
            "Runtime connector rotation state",
            error,
        )),
    }
}

pub(crate) fn random_secret(length: usize) -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

pub(crate) fn random_connector_secret() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Could not generate a connector credential.".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
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

    use super::{
        parse_backup_identity, random_connector_secret, random_secret, read_secure_result,
    };

    #[test]
    fn generated_secret_has_requested_length() {
        assert_eq!(random_secret(48).len(), 48);
        assert_eq!(random_connector_secret().unwrap().len(), 43);
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
