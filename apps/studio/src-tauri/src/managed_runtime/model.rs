use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReleaseManifest {
    pub schema_version: u8,
    pub service: String,
    pub version: String,
    pub contract_version: String,
    pub openwa_release_tag: String,
    pub openwa_contract_sha256: String,
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
    RotatingCredentials,
    Resetting,
    Restoring,
    Updating,
    Ready,
    Degraded,
    Stopping,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedRuntimeLifecycleOperation {
    Reconfigure,
    Reset,
    RotateConnectorCredential,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeLifecycleStatus {
    pub operation: ManagedRuntimeLifecycleOperation,
    pub phase: ManagedRuntimeLifecyclePhase,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedRuntimeAvailability {
    #[default]
    Starting,
    NeedsSetup,
    Online,
    Busy,
    Degraded,
    Stopping,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeCapabilities {
    pub can_read: bool,
    pub can_edit_drafts: bool,
    pub can_sync: bool,
    pub can_launch_campaign: bool,
    pub can_send: bool,
}

impl ManagedRuntimeCapabilities {
    fn online() -> Self {
        Self {
            can_read: true,
            can_edit_drafts: true,
            can_sync: true,
            can_launch_campaign: true,
            can_send: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedRuntimeMaintenanceKind {
    PreMigrationBackup,
    IntegrityCheck,
    AutomaticBackup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeMaintenance {
    pub kind: ManagedRuntimeMaintenanceKind,
    pub blocking: bool,
    pub cancellable: bool,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StoragePressure {
    Normal,
    Warning,
    Critical,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeStorageDiagnostics {
    pub filesystem_total_bytes: u64,
    pub filesystem_available_bytes: u64,
    pub filesystem_available_percent: u8,
    pub pressure: StoragePressure,
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
    pub storage: ManagedRuntimeStorageDiagnostics,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeSnapshot {
    pub phase: ManagedRuntimePhase,
    pub availability: ManagedRuntimeAvailability,
    pub capabilities: ManagedRuntimeCapabilities,
    pub maintenance: Option<ManagedRuntimeMaintenance>,
    pub manifest: Option<RuntimeReleaseManifest>,
    pub connection: Option<ManagedRuntimeConnection>,
    pub error: Option<String>,
}

impl ManagedRuntimeSnapshot {
    pub fn phase(phase: ManagedRuntimePhase, manifest: RuntimeReleaseManifest) -> Self {
        Self {
            phase,
            availability: availability_for_phase(phase),
            capabilities: ManagedRuntimeCapabilities::default(),
            maintenance: None,
            manifest: Some(manifest),
            connection: None,
            error: None,
        }
    }

    pub fn ready(manifest: RuntimeReleaseManifest, connection: ManagedRuntimeConnection) -> Self {
        Self {
            phase: ManagedRuntimePhase::Ready,
            availability: ManagedRuntimeAvailability::Online,
            capabilities: ManagedRuntimeCapabilities::online(),
            maintenance: None,
            manifest: Some(manifest),
            connection: Some(connection),
            error: None,
        }
    }

    pub fn degraded(manifest: Option<RuntimeReleaseManifest>, error: impl Into<String>) -> Self {
        Self {
            phase: ManagedRuntimePhase::Degraded,
            availability: ManagedRuntimeAvailability::Degraded,
            capabilities: ManagedRuntimeCapabilities::default(),
            maintenance: None,
            manifest,
            connection: None,
            error: Some(error.into()),
        }
    }

    pub fn provisioning_required(manifest: RuntimeReleaseManifest) -> Self {
        Self {
            phase: ManagedRuntimePhase::ProvisioningRequired,
            availability: ManagedRuntimeAvailability::NeedsSetup,
            capabilities: ManagedRuntimeCapabilities::default(),
            maintenance: None,
            manifest: Some(manifest),
            connection: None,
            error: None,
        }
    }
}

fn availability_for_phase(phase: ManagedRuntimePhase) -> ManagedRuntimeAvailability {
    match phase {
        ManagedRuntimePhase::Discovering
        | ManagedRuntimePhase::DatabaseStarting
        | ManagedRuntimePhase::Migrating
        | ManagedRuntimePhase::RuntimeStarting => ManagedRuntimeAvailability::Starting,
        ManagedRuntimePhase::ProvisioningRequired => ManagedRuntimeAvailability::NeedsSetup,
        ManagedRuntimePhase::Ready => ManagedRuntimeAvailability::Online,
        ManagedRuntimePhase::Reconfiguring
        | ManagedRuntimePhase::RotatingCredentials
        | ManagedRuntimePhase::Resetting
        | ManagedRuntimePhase::Restoring
        | ManagedRuntimePhase::Updating => ManagedRuntimeAvailability::Busy,
        ManagedRuntimePhase::Degraded => ManagedRuntimeAvailability::Degraded,
        ManagedRuntimePhase::Stopping => ManagedRuntimeAvailability::Stopping,
    }
}
