use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReleaseManifest {
    pub schema_version: u8,
    pub service: String,
    pub version: String,
    pub contract_version: String,
    pub profiles: Vec<String>,
    pub roles: Vec<String>,
    pub database_backends: Vec<String>,
    pub queue_backends: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeConnection {
    pub base_url: String,
    pub transport: ManagedRuntimeTransportKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedRuntimeTransportKind {
    Native,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedRuntimePhase {
    #[default]
    Discovering,
    ProvisioningRequired,
    DatabaseStarting,
    Migrating,
    RuntimeStarting,
    Reconfiguring,
    Restoring,
    Updating,
    Ready,
    Degraded,
    Stopping,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeBackup {
    pub id: String,
    pub kind: String,
    pub created_at_ms: u64,
    pub size_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProtectionFreshness {
    Fresh,
    Due,
    Missing,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeDiagnostics {
    pub generated_at_ms: u64,
    pub desktop_product: &'static str,
    pub runtime_service: &'static str,
    pub runtime_phase: ManagedRuntimePhase,
    pub runtime_version: Option<String>,
    pub process_generation: Option<u64>,
    pub managed_postgres_running: bool,
    pub recovery_point_count: usize,
    pub latest_recovery_point_at_ms: Option<u64>,
    pub recovery_freshness: ProtectionFreshness,
    pub last_integrity_check_at_ms: Option<u64>,
    pub integrity_freshness: ProtectionFreshness,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeSnapshot {
    pub phase: ManagedRuntimePhase,
    pub manifest: Option<RuntimeReleaseManifest>,
    pub connection: Option<ManagedRuntimeConnection>,
    pub error: Option<String>,
}

impl ManagedRuntimeSnapshot {
    pub fn phase(phase: ManagedRuntimePhase, manifest: RuntimeReleaseManifest) -> Self {
        Self {
            phase,
            manifest: Some(manifest),
            connection: None,
            error: None,
        }
    }

    pub fn ready(manifest: RuntimeReleaseManifest, connection: ManagedRuntimeConnection) -> Self {
        Self {
            phase: ManagedRuntimePhase::Ready,
            manifest: Some(manifest),
            connection: Some(connection),
            error: None,
        }
    }

    pub fn degraded(manifest: Option<RuntimeReleaseManifest>, error: impl Into<String>) -> Self {
        Self {
            phase: ManagedRuntimePhase::Degraded,
            manifest,
            connection: None,
            error: Some(error.into()),
        }
    }

    pub fn provisioning_required(manifest: RuntimeReleaseManifest) -> Self {
        Self {
            phase: ManagedRuntimePhase::ProvisioningRequired,
            manifest: Some(manifest),
            connection: None,
            error: None,
        }
    }
}
