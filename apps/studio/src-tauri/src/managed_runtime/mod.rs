mod config;
mod config_envelope;
mod lifecycle;
mod model;
pub(crate) mod observability;
mod postgres;
mod provisioning;
mod provisioning_routes;
mod release;
mod secret_store;
mod state;
pub(crate) mod transport;

use std::{
    fs::{self, create_dir_all},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use age::secrecy::SecretString;
use config::{DesktopDatabaseConfig, DesktopRuntimeConfig};
use model::{
    ManagedRuntimeConnection, ManagedRuntimeLifecycleStatus, ManagedRuntimeMaintenance,
    ManagedRuntimeMaintenanceKind, ManagedRuntimePhase, ManagedRuntimeQuarantineCleanup,
    ManagedRuntimeStorageDiagnostics, ProtectionFreshness, StoragePressure,
};
use provisioning::{ManagedRuntimeProvisioningInput, ManagedRuntimeProvisioningProfile};
use release::{OPENWA_CONTRACT_SHA256, OPENWA_RELEASE_TAG};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

pub use model::{
    ManagedRuntimeBackup, ManagedRuntimeDiagnostics, ManagedRuntimeSnapshot,
    ManagedRuntimeTransportKind, RuntimeReleaseManifest,
};
use state::AutoRestartPlan;
pub use state::ManagedRuntimeState;

pub const STATE_CHANGED_EVENT: &str = "managed-runtime://state-changed";
const RECOVERY_FRESHNESS_INTERVAL_MS: u64 = 24 * 60 * 60 * 1_000;
const GIBIBYTE: u64 = 1_024 * 1_024 * 1_024;
const STORAGE_WARNING_AVAILABLE_BYTES: u64 = 20 * GIBIBYTE;
const STORAGE_CRITICAL_AVAILABLE_BYTES: u64 = 10 * GIBIBYTE;
const STORAGE_WARNING_AVAILABLE_PERCENT: u8 = 15;
const STORAGE_CRITICAL_AVAILABLE_PERCENT: u8 = 8;
const BACKGROUND_MAINTENANCE_START_DELAY: Duration = Duration::from_secs(15);
const BACKGROUND_MAINTENANCE_POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);
const BACKGROUND_MAINTENANCE_MAX_JITTER: Duration = Duration::from_secs(2 * 60);

#[derive(Clone)]
struct ManagedPostgresMaintenanceContext {
    backup_directory: PathBuf,
    backup_identity: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeMigrationPlan {
    database_state: String,
    pending: Vec<String>,
    checksums_backfill: Vec<String>,
    current_fingerprint: String,
    target_fingerprint: String,
    requires_backup: bool,
}

impl RuntimeMigrationPlan {
    fn has_work(&self) -> bool {
        !self.pending.is_empty() || !self.checksums_backfill.is_empty()
    }
}

fn current_timestamp_millis() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("System clock error: {error}"))
}

fn protection_freshness(
    now_ms: u64,
    last_success_at_ms: Option<u64>,
    interval_ms: u64,
) -> ProtectionFreshness {
    match last_success_at_ms {
        None => ProtectionFreshness::Missing,
        Some(timestamp) if !postgres::timestamp_is_credible(now_ms, timestamp) => {
            ProtectionFreshness::Due
        }
        Some(timestamp) if now_ms.saturating_sub(timestamp) <= interval_ms => {
            ProtectionFreshness::Fresh
        }
        Some(_) => ProtectionFreshness::Due,
    }
}

fn storage_diagnostics(path: &std::path::Path) -> Result<ManagedRuntimeStorageDiagnostics, String> {
    let filesystem_path = path
        .ancestors()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| "Could not resolve a filesystem for WA Studio storage.".to_string())?;
    let filesystem_total_bytes = fs2::total_space(filesystem_path)
        .map_err(|error| format!("Could not inspect WA Studio storage capacity: {error}"))?;
    let filesystem_available_bytes = fs2::available_space(filesystem_path)
        .map_err(|error| format!("Could not inspect WA Studio available storage: {error}"))?;
    let filesystem_available_percent = filesystem_available_bytes
        .saturating_mul(100)
        .checked_div(filesystem_total_bytes)
        .unwrap_or(0)
        .min(100) as u8;
    let pressure = if filesystem_available_bytes <= STORAGE_CRITICAL_AVAILABLE_BYTES
        || filesystem_available_percent <= STORAGE_CRITICAL_AVAILABLE_PERCENT
    {
        StoragePressure::Critical
    } else if filesystem_available_bytes <= STORAGE_WARNING_AVAILABLE_BYTES
        || filesystem_available_percent <= STORAGE_WARNING_AVAILABLE_PERCENT
    {
        StoragePressure::Warning
    } else {
        StoragePressure::Normal
    };
    Ok(ManagedRuntimeStorageDiagnostics {
        filesystem_total_bytes,
        filesystem_available_bytes,
        filesystem_available_percent,
        pressure,
        recovery_point_bytes: 0,
        automatic_recovery_bytes: 0,
        automatic_recovery_budget_bytes: 0,
        quarantined_cluster_count: 0,
        quarantined_cluster_bytes: 0,
    })
}

#[tauri::command]
pub fn get_managed_runtime_state(
    state: State<'_, ManagedRuntimeState>,
) -> Result<ManagedRuntimeSnapshot, String> {
    state.snapshot()
}

#[tauri::command]
pub async fn get_managed_runtime_lifecycle_status(
) -> Result<Option<ManagedRuntimeLifecycleStatus>, String> {
    tauri::async_runtime::spawn_blocking(lifecycle::status)
        .await
        .map_err(|error| format!("Managed Runtime lifecycle status task failed: {error}"))?
}

#[tauri::command]
pub async fn get_managed_runtime_diagnostics(
    app: AppHandle,
) -> Result<ManagedRuntimeDiagnostics, String> {
    let state = app.state::<ManagedRuntimeState>();
    let snapshot = state.snapshot()?;
    let generated_at_ms = current_timestamp_millis()?;
    let process_generation = state.process_generation()?;
    let managed_postgres_running = state.managed_postgres_running()?;
    let config = tauri::async_runtime::spawn_blocking(DesktopRuntimeConfig::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??;
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve WA Desktop data directory: {error}"))?;
    let mut storage = storage_diagnostics(&app_data_directory)?;
    let backup_directory = config
        .as_ref()
        .and_then(|config| config.managed_backup_directory(&app_data_directory));
    let postgres_root = config.as_ref().and_then(|config| match &config.database {
        DesktopDatabaseConfig::Managed { root, .. } => Some(
            root.clone()
                .unwrap_or_else(|| app_data_directory.join("postgresql")),
        ),
        DesktopDatabaseConfig::External { .. } => None,
    });
    let filesystem_total_bytes = storage.filesystem_total_bytes;
    let (backups, last_integrity_check_at_ms, backup_storage) = match backup_directory {
        Some(directory) => tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, String>((
                postgres::list_backups(&directory)?,
                postgres::last_integrity_check_at(&directory, generated_at_ms)?,
                postgres::backup_storage_summary(&directory, filesystem_total_bytes)?,
            ))
        })
        .await
        .map_err(|error| format!("Managed PostgreSQL diagnostics task failed: {error}"))??,
        None => (
            Vec::new(),
            None,
            postgres::BackupStorageSummary {
                recovery_point_bytes: 0,
                automatic_recovery_bytes: 0,
                automatic_recovery_budget_bytes: 0,
            },
        ),
    };
    let quarantine = match postgres_root {
        Some(root) => tauri::async_runtime::spawn_blocking(move || quarantine_inventory(&root))
            .await
            .map_err(|error| format!("Managed PostgreSQL quarantine task failed: {error}"))??,
        None => QuarantineInventory::default(),
    };
    storage.recovery_point_bytes = backup_storage.recovery_point_bytes;
    storage.automatic_recovery_bytes = backup_storage.automatic_recovery_bytes;
    storage.automatic_recovery_budget_bytes = backup_storage.automatic_recovery_budget_bytes;
    storage.quarantined_cluster_count = quarantine.count;
    storage.quarantined_cluster_bytes = quarantine.size_bytes;
    let latest_recovery_point_at_ms = postgres::latest_recovery_point_at(&backups, generated_at_ms);
    Ok(ManagedRuntimeDiagnostics {
        generated_at_ms,
        desktop_product: "wa-studio",
        runtime_service: "wa-runtime",
        runtime_phase: snapshot.phase,
        runtime_version: snapshot.manifest.map(|manifest| manifest.version),
        process_generation,
        managed_postgres_running,
        recovery_point_count: backups.len(),
        latest_recovery_point_at_ms,
        recovery_freshness: protection_freshness(
            generated_at_ms,
            latest_recovery_point_at_ms,
            RECOVERY_FRESHNESS_INTERVAL_MS,
        ),
        last_integrity_check_at_ms,
        integrity_freshness: protection_freshness(
            generated_at_ms,
            last_integrity_check_at_ms,
            postgres::integrity_check_interval_millis(),
        ),
        storage,
    })
}

#[tauri::command]
pub async fn provision_managed_runtime(
    app: AppHandle,
    input: ManagedRuntimeProvisioningInput,
) -> Result<(), String> {
    let state = app.state::<ManagedRuntimeState>();
    let phase = state.snapshot()?.phase;
    if !matches!(
        phase,
        ManagedRuntimePhase::ProvisioningRequired | ManagedRuntimePhase::Degraded
    ) {
        return Err(
            "Managed Runtime can only be provisioned from setup or repaired while degraded."
                .to_string(),
        );
    }
    state.begin_provisioning()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        if phase == ManagedRuntimePhase::ProvisioningRequired {
            provisioning::provision(input)
        } else {
            provisioning::repair(input)
        }
    })
    .await
    .map_err(|error| format!("Managed Runtime provisioning task failed: {error}"))
    .and_then(|result| result);
    state.finish_provisioning();
    result?;
    if phase == ManagedRuntimePhase::Degraded {
        restart_managed_runtime(&app).await?;
    } else {
        initialize(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_managed_runtime_provisioning_profile(
) -> Result<Option<ManagedRuntimeProvisioningProfile>, String> {
    if DesktopRuntimeConfig::from_environment()?.is_some() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(provisioning::profile)
        .await
        .map_err(|error| format!("Managed Runtime profile task failed: {error}"))?
}

#[tauri::command]
pub async fn reconfigure_managed_runtime(
    app: AppHandle,
    input: ManagedRuntimeProvisioningInput,
) -> Result<ManagedRuntimeProvisioningProfile, String> {
    if DesktopRuntimeConfig::from_environment()?.is_some() {
        return Err(
            "Developer environment provisioning cannot be changed from WA Studio.".to_string(),
        );
    }
    let state = app.state::<ManagedRuntimeState>();
    let _maintenance = state.begin_maintenance("Runtime reconfiguration")?;
    let phase = state.snapshot()?.phase;
    if phase != ManagedRuntimePhase::Ready {
        return Err("Managed Runtime must be ready before reconfiguration.".to_string());
    }
    let transport = state.runtime_transport()?;
    let settings = tauri::async_runtime::spawn_blocking(provisioning::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
        .ok_or_else(|| "Managed Runtime provisioning is unavailable.".to_string())?;
    let lifecycle_input = input.clone();
    let mut intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::prepare_reconfiguration(&lifecycle_input)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;
    let drain_transport = transport.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::block_and_drain(
            &drain_transport,
            &settings,
            &mut intent,
            "MANAGED_RUNTIME_RECONFIGURATION",
        )?;
        Ok::<_, String>(intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime drain task failed: {error}"))??;

    if let Some(manifest) = state.snapshot()?.manifest {
        publish_snapshot(
            &app,
            ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Reconfiguring, manifest),
        );
    }
    if let Err(error) = stop_runtime_stack_for_restart(&app).await {
        state.resume_for_restart();
        initialize(&app);
        return Err(error);
    }
    let mut stopped_intent = intent.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::advance(
            &mut stopped_intent,
            secret_store::ManagedRuntimeLifecyclePhase::RuntimeStopped,
        )?;
        Ok::<_, String>(stopped_intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;

    let profile = if intent.phase < secret_store::ManagedRuntimeLifecyclePhase::RemoteMutated {
        let configure_input = input.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            provisioning::reconfigure(configure_input)
        })
        .await
        .map_err(|error| format!("Managed Runtime reconfiguration task failed: {error}"))?
        {
            Ok(profile) => profile,
            Err(error) => {
                state.resume_for_restart();
                initialize(&app);
                return Err(error);
            }
        }
    } else {
        tauri::async_runtime::spawn_blocking(provisioning::profile)
            .await
            .map_err(|error| format!("Managed Runtime profile task failed: {error}"))??
            .ok_or_else(|| "Managed Runtime provisioning profile is unavailable.".to_string())?
    };
    let mut mutated_intent = intent.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::advance(
            &mut mutated_intent,
            secret_store::ManagedRuntimeLifecyclePhase::RemoteMutated,
        )?;
        Ok::<_, String>(mutated_intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;

    state.resume_for_restart();
    initialize(&app);
    let resumed_transport = wait_for_managed_runtime_ready(&app, Duration::from_secs(180)).await?;
    let mut restarted_intent = intent.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::advance(
            &mut restarted_intent,
            secret_store::ManagedRuntimeLifecyclePhase::RuntimeRestarted,
        )?;
        Ok::<_, String>(restarted_intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;
    let replacement_settings = tauri::async_runtime::spawn_blocking(provisioning::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
        .ok_or_else(|| "Managed Runtime replacement settings are unavailable.".to_string())?;
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::verify_connector(&replacement_settings, &mut intent)?;
        Ok::<_, String>(intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime connector verification task failed: {error}"))??;
    tauri::async_runtime::spawn_blocking(move || {
        lifecycle::resume(&resumed_transport, &mut intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime resume task failed: {error}"))??;
    Ok(profile)
}

#[tauri::command]
pub async fn reset_managed_runtime_connection(app: AppHandle) -> Result<(), String> {
    if DesktopRuntimeConfig::from_environment()?.is_some() {
        return Err(
            "Developer environment provisioning cannot be reset from WA Studio.".to_string(),
        );
    }
    let state = app.state::<ManagedRuntimeState>();
    let _maintenance = state.begin_maintenance("Runtime connection reset")?;
    if state.snapshot()?.phase != ManagedRuntimePhase::Ready {
        return Err("Managed Runtime must be ready before resetting its connection.".to_string());
    }
    let transport = state.runtime_transport()?;
    let settings = tauri::async_runtime::spawn_blocking(provisioning::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
        .ok_or_else(|| "Managed Runtime provisioning is unavailable.".to_string())?;
    let mut intent = tauri::async_runtime::spawn_blocking(lifecycle::prepare_reset)
        .await
        .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;
    let drain_transport = transport.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::block_and_drain(
            &drain_transport,
            &settings,
            &mut intent,
            "MANAGED_RUNTIME_CONNECTION_RESET",
        )?;
        Ok::<_, String>(intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime drain task failed: {error}"))??;

    let snapshot = state.snapshot()?;
    let manifest = snapshot
        .manifest
        .ok_or_else(|| "Managed Runtime release metadata is unavailable.".to_string())?;
    publish_snapshot(
        &app,
        ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Resetting, manifest.clone()),
    );
    if let Err(error) = stop_runtime_stack_for_restart(&app).await {
        state.resume_for_restart();
        initialize(&app);
        return Err(error);
    }
    let mut stopped_intent = intent.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::advance(
            &mut stopped_intent,
            secret_store::ManagedRuntimeLifecyclePhase::RuntimeStopped,
        )?;
        Ok::<_, String>(stopped_intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;

    if let Err(error) = tauri::async_runtime::spawn_blocking(provisioning::deprovision)
        .await
        .map_err(|error| format!("Managed Runtime deprovisioning task failed: {error}"))?
    {
        state.resume_for_restart();
        initialize(&app);
        return Err(error);
    }
    let mut completed_intent = intent;
    tauri::async_runtime::spawn_blocking(move || {
        lifecycle::advance(
            &mut completed_intent,
            secret_store::ManagedRuntimeLifecyclePhase::RemoteMutated,
        )?;
        lifecycle::complete_without_resume(&mut completed_intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;
    publish_snapshot(
        &app,
        ManagedRuntimeSnapshot::provisioning_required(manifest),
    );
    Ok(())
}

#[tauri::command]
pub async fn rotate_managed_runtime_connector_credential(
    app: AppHandle,
) -> Result<ManagedRuntimeProvisioningProfile, String> {
    if DesktopRuntimeConfig::from_environment()?.is_some() {
        return Err(
            "Developer environment credentials cannot be rotated from WA Studio.".to_string(),
        );
    }
    let state = app.state::<ManagedRuntimeState>();
    let _maintenance = state.begin_maintenance("connector credential rotation")?;
    if state.snapshot()?.phase != ManagedRuntimePhase::Ready {
        return Err(
            "Managed Runtime must be ready before rotating connector credentials.".to_string(),
        );
    }
    let transport = state.runtime_transport()?;
    let settings = tauri::async_runtime::spawn_blocking(provisioning::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
        .ok_or_else(|| "Managed Runtime provisioning is unavailable.".to_string())?;
    let lifecycle_settings = settings.clone();
    let mut intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::prepare_connector_rotation(&lifecycle_settings)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;
    let drain_transport = transport.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::block_and_drain(
            &drain_transport,
            &settings,
            &mut intent,
            "MANAGED_RUNTIME_CONNECTOR_CREDENTIAL_ROTATION",
        )?;
        Ok::<_, String>(intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime drain task failed: {error}"))??;

    let snapshot = state.snapshot()?;
    let manifest = snapshot
        .manifest
        .ok_or_else(|| "Managed Runtime release metadata is unavailable.".to_string())?;
    publish_snapshot(
        &app,
        ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::RotatingCredentials, manifest),
    );
    if let Err(error) = stop_runtime_stack_for_restart(&app).await {
        state.resume_for_restart();
        initialize(&app);
        return Err(error);
    }
    let mut stopped_intent = intent.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::advance(
            &mut stopped_intent,
            secret_store::ManagedRuntimeLifecyclePhase::RuntimeStopped,
        )?;
        Ok::<_, String>(stopped_intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;

    let profile = if intent.phase < secret_store::ManagedRuntimeLifecyclePhase::RemoteMutated {
        match tauri::async_runtime::spawn_blocking(provisioning::rotate_connector_credential)
            .await
            .map_err(|error| format!("Managed Runtime credential rotation task failed: {error}"))?
        {
            Ok(profile) => profile,
            Err(error) => {
                state.resume_for_restart();
                initialize(&app);
                return Err(error);
            }
        }
    } else {
        tauri::async_runtime::spawn_blocking(provisioning::profile)
            .await
            .map_err(|error| format!("Managed Runtime profile task failed: {error}"))??
            .ok_or_else(|| "Managed Runtime provisioning profile is unavailable.".to_string())?
    };
    let mut mutated_intent = intent.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::advance(
            &mut mutated_intent,
            secret_store::ManagedRuntimeLifecyclePhase::RemoteMutated,
        )?;
        Ok::<_, String>(mutated_intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;

    state.resume_for_restart();
    initialize(&app);
    let resumed_transport = wait_for_managed_runtime_ready(&app, Duration::from_secs(180)).await?;
    let mut restarted_intent = intent.clone();
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::advance(
            &mut restarted_intent,
            secret_store::ManagedRuntimeLifecyclePhase::RuntimeRestarted,
        )?;
        Ok::<_, String>(restarted_intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime lifecycle task failed: {error}"))??;
    let replacement_settings = tauri::async_runtime::spawn_blocking(provisioning::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
        .ok_or_else(|| "Managed Runtime rotated settings are unavailable.".to_string())?;
    intent = tauri::async_runtime::spawn_blocking(move || {
        lifecycle::verify_connector(&replacement_settings, &mut intent)?;
        Ok::<_, String>(intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime connector verification task failed: {error}"))??;
    tauri::async_runtime::spawn_blocking(move || {
        lifecycle::resume(&resumed_transport, &mut intent)
    })
    .await
    .map_err(|error| format!("Managed Runtime resume task failed: {error}"))??;
    Ok(profile)
}

#[tauri::command]
pub async fn list_managed_runtime_backups(
    app: AppHandle,
) -> Result<Vec<ManagedRuntimeBackup>, String> {
    let backup_directory = managed_backup_directory(&app).await?;
    tauri::async_runtime::spawn_blocking(move || postgres::list_backups(&backup_directory))
        .await
        .map_err(|error| format!("Managed PostgreSQL backup listing task failed: {error}"))?
}

#[tauri::command]
pub async fn create_managed_runtime_backup(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ManagedRuntimeState>();
    let maintenance = state.begin_maintenance("manual database backup")?;
    let cancellation = maintenance.cancellation();
    if state.snapshot()?.phase != ManagedRuntimePhase::Ready {
        return Err("Managed Runtime must be ready before creating a manual backup.".to_string());
    }
    let config = load_runtime_config().await?;
    let identity = managed_backup_identity(&config).await?;
    let backup_directory = managed_backup_directory_for_config(&app, &config)?;
    let backup_app = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        postgres::remove_incomplete_backups(&backup_directory)?;
        backup_app
            .state::<ManagedRuntimeState>()
            .create_manual_postgres_backup(&backup_directory, &identity, &cancellation)
    })
    .await
    .map_err(|error| format!("Managed PostgreSQL manual backup task failed: {error}"))??;
    observability::info(
        "managed_postgres.backup_created",
        json!({ "kind": "manual", "backupId": backup_file_name(&path) }),
    );
    Ok(())
}

#[tauri::command]
pub async fn delete_managed_runtime_quarantines(
    app: AppHandle,
) -> Result<ManagedRuntimeQuarantineCleanup, String> {
    let state = app.state::<ManagedRuntimeState>();
    let _maintenance = state.begin_maintenance("retained database cleanup")?;
    if state.snapshot()?.phase != ManagedRuntimePhase::Ready {
        return Err(
            "Managed Runtime must be ready before deleting retained database data.".to_string(),
        );
    }
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve WA Desktop data directory: {error}"))?;
    let config = load_runtime_config().await?;
    let postgres_root = match config.database {
        DesktopDatabaseConfig::External { .. } => {
            return Err("External PostgreSQL databases are not managed by WA Studio.".to_string())
        }
        DesktopDatabaseConfig::Managed { root, .. } => {
            root.unwrap_or_else(|| app_data_directory.join("postgresql"))
        }
    };
    let removed =
        tauri::async_runtime::spawn_blocking(move || remove_quarantined_clusters(&postgres_root))
            .await
            .map_err(|error| {
                format!("Managed PostgreSQL retained-data cleanup task failed: {error}")
            })??;
    observability::info(
        "managed_postgres.quarantines_deleted",
        json!({ "removedCount": removed.count, "removedBytes": removed.size_bytes }),
    );
    Ok(ManagedRuntimeQuarantineCleanup {
        removed_count: removed.count,
        removed_bytes: removed.size_bytes,
    })
}

#[tauri::command]
pub async fn export_managed_runtime_recovery_archive(
    app: AppHandle,
    passphrase: String,
) -> Result<Option<String>, String> {
    let passphrase = recovery_passphrase(passphrase)?;
    if app.state::<ManagedRuntimeState>().snapshot()?.phase != ManagedRuntimePhase::Ready {
        return Err(
            "Managed Runtime must be ready before exporting a recovery archive.".to_string(),
        );
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock error: {error}"))?
        .as_millis();
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("WA Runtime recovery archive", &["age"])
            .set_file_name(format!("wa-runtime-recovery-{timestamp}.dump.age"))
            .blocking_save_file()
    })
    .await
    .map_err(|error| format!("Recovery archive save dialog failed: {error}"))?;
    let Some(destination) = selected else {
        return Ok(None);
    };
    let destination = destination
        .into_path()
        .map_err(|error| format!("Recovery archive destination is invalid: {error}"))?;
    let state = app.state::<ManagedRuntimeState>();
    let maintenance = state.begin_maintenance("recovery archive export")?;
    let cancellation = maintenance.cancellation();
    if state.snapshot()?.phase != ManagedRuntimePhase::Ready {
        return Err(
            "Managed Runtime changed state before the recovery export started.".to_string(),
        );
    }
    let export_app = app.clone();
    let display_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("WA Runtime recovery archive")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        export_app
            .state::<ManagedRuntimeState>()
            .create_portable_postgres_backup(&destination, passphrase, &cancellation)
    })
    .await
    .map_err(|error| format!("Portable PostgreSQL backup task failed: {error}"))??;
    Ok(Some(display_name))
}

#[tauri::command]
pub async fn restore_managed_runtime_backup(
    app: AppHandle,
    backup_id: String,
) -> Result<(), String> {
    let state = app.state::<ManagedRuntimeState>();
    let _maintenance = state.begin_maintenance("database restore")?;
    restore_managed_runtime_backup_inner(&app, backup_id).await
}

async fn restore_managed_runtime_backup_inner(
    app: &AppHandle,
    backup_id: String,
) -> Result<(), String> {
    let state = app.state::<ManagedRuntimeState>();
    let snapshot = state.snapshot()?;
    if !matches!(
        snapshot.phase,
        ManagedRuntimePhase::Ready | ManagedRuntimePhase::Degraded
    ) {
        return Err(
            "Managed Runtime must be ready or degraded before restoring a backup.".to_string(),
        );
    }
    let manifest = snapshot
        .manifest
        .ok_or_else(|| "Managed Runtime release metadata is unavailable.".to_string())?;
    let config = load_runtime_config().await?;
    let identity = managed_backup_identity(&config).await?;
    let backup_directory = managed_backup_directory_for_config(app, &config)?;
    publish_snapshot(
        app,
        ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Restoring, manifest.clone()),
    );

    if snapshot.phase == ManagedRuntimePhase::Degraded {
        return restore_degraded_managed_backup(
            app,
            config,
            backup_directory,
            backup_id,
            manifest,
            identity,
        )
        .await;
    }

    let stop_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stop_app
            .state::<ManagedRuntimeState>()
            .stop_processes_for_restart()
    })
    .await
    .map_err(|error| format!("Managed Runtime stop task failed: {error}"))??;

    let restore_app = app.clone();
    let release_version = manifest.version;
    let restored_backup_id = backup_id.clone();
    let restore_result = tauri::async_runtime::spawn_blocking(move || {
        restore_app
            .state::<ManagedRuntimeState>()
            .restore_postgres_backup(&backup_directory, &backup_id, &release_version, &identity)
    })
    .await
    .map_err(|error| format!("Managed PostgreSQL restore task failed: {error}"))?;
    if let Ok(ref safety_backup) = restore_result {
        observability::info(
            "managed_postgres.backup_restored",
            json!({
                "sourceBackupId": restored_backup_id,
                "safetyBackupId": backup_file_name(safety_backup),
            }),
        );
    }

    let restart_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        restart_app
            .state::<ManagedRuntimeState>()
            .stop_postgres_for_restart()
    })
    .await
    .map_err(|error| format!("Managed PostgreSQL restart task failed: {error}"))??;
    initialize(app);
    restore_result.map(|_| ())
}

#[tauri::command]
pub async fn restore_managed_runtime_recovery_archive(
    app: AppHandle,
    passphrase: String,
) -> Result<bool, String> {
    let passphrase = recovery_passphrase(passphrase)?;
    if app.state::<ManagedRuntimeState>().snapshot()?.phase != ManagedRuntimePhase::Ready {
        return Err(
            "Managed Runtime must be ready before importing a portable recovery archive."
                .to_string(),
        );
    }
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("WA Runtime recovery archive", &["age"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| format!("Recovery archive open dialog failed: {error}"))?;
    let Some(source) = selected else {
        return Ok(false);
    };
    let source = source
        .into_path()
        .map_err(|error| format!("Recovery archive source is invalid: {error}"))?;
    let state = app.state::<ManagedRuntimeState>();
    let _maintenance = state.begin_maintenance("portable database restore")?;
    let snapshot = state.snapshot()?;
    if snapshot.phase != ManagedRuntimePhase::Ready {
        return Err(
            "Managed Runtime changed state before the recovery import started.".to_string(),
        );
    }
    let manifest = snapshot
        .manifest
        .ok_or_else(|| "Managed Runtime release metadata is unavailable.".to_string())?;
    let config = load_runtime_config().await?;
    let identity = managed_backup_identity(&config).await?;
    let backup_directory = managed_backup_directory_for_config(&app, &config)?;
    publish_snapshot(
        &app,
        ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Restoring, manifest.clone()),
    );

    let stop_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stop_app
            .state::<ManagedRuntimeState>()
            .stop_processes_for_restart()
    })
    .await
    .map_err(|error| format!("Managed Runtime stop task failed: {error}"))??;

    let restore_app = app.clone();
    let release_version = manifest.version;
    let restore_result = tauri::async_runtime::spawn_blocking(move || {
        restore_app
            .state::<ManagedRuntimeState>()
            .restore_portable_postgres_backup(
                &source,
                passphrase,
                &backup_directory,
                &release_version,
                &identity,
            )
    })
    .await
    .map_err(|error| format!("Portable PostgreSQL restore task failed: {error}"))?;

    let restart_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        restart_app
            .state::<ManagedRuntimeState>()
            .stop_postgres_for_restart()
    })
    .await
    .map_err(|error| format!("Managed PostgreSQL restart task failed: {error}"))??;
    initialize(&app);
    restore_result.map(|_| true)
}

async fn restore_degraded_managed_backup(
    app: &AppHandle,
    config: DesktopRuntimeConfig,
    backup_directory: PathBuf,
    backup_id: String,
    manifest: RuntimeReleaseManifest,
    identity: age::x25519::Identity,
) -> Result<(), String> {
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve WA Desktop data directory: {error}"))?;
    let (root, password) = match config.database {
        DesktopDatabaseConfig::External { .. } => {
            return Err("External PostgreSQL databases are not managed by WA Studio.".to_string())
        }
        DesktopDatabaseConfig::Managed { root, password, .. } => {
            let password = match password {
                Some(password) => password,
                None => {
                    tauri::async_runtime::spawn_blocking(secret_store::managed_postgres_password)
                        .await
                        .map_err(|error| {
                            format!("Managed PostgreSQL local secret task failed: {error}")
                        })??
                }
            };
            (
                root.unwrap_or_else(|| app_data_directory.join("postgresql")),
                password,
            )
        }
    };
    let staging_directory = std::env::temp_dir()
        .join("wa-runtime-recovery")
        .join(uuid::Uuid::new_v4().to_string());
    let stage_directory = staging_directory.clone();
    let stage_backup_directory = backup_directory.clone();
    let stage_backup_id = backup_id.clone();
    let staged = tauri::async_runtime::spawn_blocking(move || {
        postgres::stage_managed_backup(&stage_backup_directory, &stage_backup_id, &stage_directory)
    })
    .await
    .map_err(|error| format!("Managed PostgreSQL recovery staging task failed: {error}"))??;

    let recovery_app = app.clone();
    let recovery_root = root.clone();
    let recovery_backup_directory = backup_directory.clone();
    let recovery_backup_id = backup_id.clone();
    let staged_for_recovery = staged.clone();
    let recovery = tauri::async_runtime::spawn_blocking(move || {
        let state = recovery_app.state::<ManagedRuntimeState>();
        state.stop_processes_for_restart()?;
        state.stop_postgres_for_restart()?;
        if recovery_root.exists() {
            quarantine_postgres_root(&recovery_root, "degraded-recovery")?;
        }
        state.resume_for_restart();
        state.start_postgres(&recovery_root, password)?;
        let restore_result =
            state.restore_postgres_verified_source(&staged_for_recovery, &identity);
        let retain_result = if restore_result.is_ok() {
            postgres::retain_staged_managed_backup(
                &staged_for_recovery,
                &recovery_backup_directory,
                &recovery_backup_id,
            )
        } else {
            Ok(())
        };
        let stop_result = state.stop_postgres_for_restart();
        restore_result.and(retain_result).and(stop_result)
    })
    .await
    .map_err(|error| format!("Managed PostgreSQL degraded recovery task failed: {error}"))?;

    let _ = fs::remove_file(&staged);
    let _ = fs::remove_dir(&staging_directory);
    match recovery {
        Ok(()) => {
            app.state::<ManagedRuntimeState>().resume_for_restart();
            initialize(app);
            Ok(())
        }
        Err(error) => {
            publish_snapshot(
                app,
                ManagedRuntimeSnapshot::degraded(Some(manifest), error.clone()),
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn reset_managed_runtime_database(app: AppHandle) -> Result<(), String> {
    let snapshot = app.state::<ManagedRuntimeState>().snapshot()?;
    if snapshot.phase != ManagedRuntimePhase::Degraded {
        return Err(
            "Local workspace reset is only available after a Runtime startup failure.".to_string(),
        );
    }
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve WA Desktop data directory: {error}"))?;
    let config = load_runtime_config().await?;
    let postgres_dir = match &config.database {
        DesktopDatabaseConfig::External { .. } => {
            return Err("External PostgreSQL databases cannot be reset by WA Studio.".to_string())
        }
        DesktopDatabaseConfig::Managed { root, .. } => root
            .clone()
            .unwrap_or_else(|| app_data_directory.join("postgresql")),
    };
    let backup_directory = managed_backup_directory_for_config(&app, &config)?;
    if backup_directory.starts_with(&postgres_dir) {
        return Err(
            "Refusing to reset PostgreSQL because its backup directory is inside the database root. Move WA_DESKTOP_BACKUP_ROOT outside WA_DESKTOP_POSTGRES_ROOT."
                .to_string(),
        );
    }
    let reset_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = reset_app.state::<ManagedRuntimeState>();
        state.stop_processes_for_restart()?;
        state.stop_postgres_for_restart()?;
        if postgres_dir.exists() {
            quarantine_postgres_root(&postgres_dir, "operator-reset")?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("Local workspace reset task failed: {error}"))??;
    app.state::<ManagedRuntimeState>().resume_for_restart();
    initialize(&app);
    Ok(())
}

pub fn initialize(app: &AppHandle) {
    let state = app.state::<ManagedRuntimeState>();
    if let Err(error) = state.begin_initialization() {
        observability::warn(
            "managed_runtime.initialization_skipped",
            json!({ "reason": error }),
        );
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = initialize_inner(&app).await {
            let manifest = app
                .state::<ManagedRuntimeState>()
                .snapshot()
                .ok()
                .and_then(|snapshot| snapshot.manifest);
            let cleanup_app = app.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                let state = cleanup_app.state::<ManagedRuntimeState>();
                let process_result = state.stop_processes();
                let postgres_result = state.stop_postgres();
                process_result.and(postgres_result)
            })
            .await
            {
                Err(cleanup_error) => observability::error(
                    "managed_runtime.initialization_cleanup_failed",
                    json!({ "reason": cleanup_error.to_string(), "taskFailed": true }),
                ),
                Ok(Err(cleanup_error)) => observability::error(
                    "managed_runtime.initialization_cleanup_failed",
                    json!({ "reason": cleanup_error, "taskFailed": false }),
                ),
                Ok(Ok(())) => {}
            }
            observability::error(
                "managed_runtime.initialization_failed",
                json!({ "reason": error }),
            );
            publish_snapshot(&app, ManagedRuntimeSnapshot::degraded(manifest, error));
        }
        app.state::<ManagedRuntimeState>().finish_initialization();
    });
}

fn prepare_shutdown(app: &AppHandle) {
    let state = app.state::<ManagedRuntimeState>();
    state.cancel_background_maintenance();
    if let Ok(snapshot) = state.snapshot() {
        if let Some(manifest) = snapshot.manifest {
            publish_snapshot(
                app,
                ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Stopping, manifest),
            );
        }
    }
}

fn report_shutdown_result(result: &Result<(), String>, task_failed: bool) {
    match result {
        Err(error) => observability::error(
            "managed_runtime.shutdown_failed",
            json!({ "reason": error, "taskFailed": task_failed }),
        ),
        Ok(()) => observability::info("managed_runtime.shutdown_completed", json!({})),
    }
}

pub async fn shutdown(app: &AppHandle) -> Result<(), String> {
    prepare_shutdown(app);
    let shutdown_app = app.clone();
    let (result, task_failed) = match tauri::async_runtime::spawn_blocking(move || {
        shutdown_app
            .state::<ManagedRuntimeState>()
            .shutdown_services()
    })
    .await
    {
        Ok(result) => (result, false),
        Err(error) => (
            Err(format!("Managed Runtime shutdown task failed: {error}")),
            true,
        ),
    };
    report_shutdown_result(&result, task_failed);
    result
}

pub fn shutdown_blocking(app: &AppHandle) -> Result<(), String> {
    prepare_shutdown(app);
    let result = app.state::<ManagedRuntimeState>().shutdown_services();
    report_shutdown_result(&result, false);
    result
}

pub fn authorize_app_exit(app: &AppHandle) {
    app.state::<ManagedRuntimeState>().authorize_exit();
}

pub fn recover_from_failed_shutdown(app: &AppHandle, error: &str) {
    let state = app.state::<ManagedRuntimeState>();
    state.finish_failed_exit_shutdown();
    let manifest = state.snapshot().ok().and_then(|snapshot| snapshot.manifest);
    publish_snapshot(
        app,
        ManagedRuntimeSnapshot::degraded(
            manifest,
            format!(
                "WA Studio could not close local services safely. The application remains open so you can retry quitting. {error}"
            ),
        ),
    );
}

pub async fn prepare_for_app_update(
    app: &AppHandle,
    current_version: &str,
    target_version: &str,
) -> Result<std::path::PathBuf, String> {
    let state = app.state::<ManagedRuntimeState>();
    let maintenance = state.begin_maintenance("app update")?;
    let cancellation = maintenance.cancellation();
    let snapshot = state.snapshot()?;
    if snapshot.phase != ManagedRuntimePhase::Ready {
        return Err("Managed Runtime must be ready before installing an app update.".to_string());
    }
    let manifest = snapshot
        .manifest
        .ok_or_else(|| "Managed Runtime release metadata is unavailable.".to_string())?;
    let config = tauri::async_runtime::spawn_blocking(DesktopRuntimeConfig::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
        .ok_or_else(|| "Managed Runtime provisioning is unavailable.".to_string())?;
    if matches!(config.database, DesktopDatabaseConfig::External { .. }) {
        return Err(
            "App updates require managed PostgreSQL so WA Studio can create a verified safety backup."
                .to_string(),
        );
    }
    let identity = match config.backup_identity_override() {
        Some(encoded) => secret_store::parse_backup_identity(&encoded)?,
        None => {
            tauri::async_runtime::spawn_blocking(secret_store::managed_postgres_backup_identity)
                .await
                .map_err(|error| {
                    format!("Managed PostgreSQL local secret task failed: {error}")
                })??
        }
    };
    let backup_directory = managed_backup_directory_for_config(app, &config)?;
    publish_snapshot(
        app,
        ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Updating, manifest),
    );

    let stop_app = app.clone();
    let stop_result = tauri::async_runtime::spawn_blocking(move || {
        stop_app
            .state::<ManagedRuntimeState>()
            .stop_processes_for_restart()
    })
    .await
    .map_err(|error| format!("Managed Runtime stop task failed: {error}"))
    .and_then(|result| result);
    if let Err(error) = stop_result {
        restart_after_failed_app_update(app).await;
        return Err(error);
    }

    let backup_app = app.clone();
    let current_version = current_version.to_string();
    let target_version = target_version.to_string();
    let backup_result = tauri::async_runtime::spawn_blocking(move || {
        backup_app
            .state::<ManagedRuntimeState>()
            .create_postgres_update_backup(
                &backup_directory,
                &current_version,
                &target_version,
                &identity,
                &cancellation,
            )
    })
    .await
    .map_err(|error| format!("Managed PostgreSQL update backup task failed: {error}"))
    .and_then(|result| result);
    let backup_path = match backup_result {
        Ok(path) => path,
        Err(error) => {
            restart_after_failed_app_update(app).await;
            return Err(error);
        }
    };

    let stop_app = app.clone();
    let stop_result = tauri::async_runtime::spawn_blocking(move || {
        stop_app
            .state::<ManagedRuntimeState>()
            .stop_postgres_for_restart()
    })
    .await
    .map_err(|error| format!("Managed PostgreSQL stop task failed: {error}"))
    .and_then(|result| result);
    if let Err(error) = stop_result {
        restart_after_failed_app_update(app).await;
        return Err(error);
    }
    Ok(backup_path)
}

pub async fn restart_after_failed_app_update(app: &AppHandle) {
    let restart_app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        let state = restart_app.state::<ManagedRuntimeState>();
        let process_result = state.stop_processes_for_restart();
        let postgres_result = state.stop_postgres_for_restart();
        process_result.and(postgres_result)
    })
    .await
    {
        Err(error) => observability::error(
            "managed_runtime.failed_update_cleanup_failed",
            json!({ "reason": error.to_string(), "taskFailed": true }),
        ),
        Ok(Err(error)) => observability::error(
            "managed_runtime.failed_update_cleanup_failed",
            json!({ "reason": error, "taskFailed": false }),
        ),
        Ok(Ok(())) => {}
    }
    app.state::<ManagedRuntimeState>().resume_for_restart();
    initialize(app);
}

async fn restart_managed_runtime(app: &AppHandle) -> Result<(), String> {
    let result = stop_runtime_stack_for_restart(app).await;
    app.state::<ManagedRuntimeState>().resume_for_restart();
    initialize(app);
    result
}

async fn wait_for_managed_runtime_ready(
    app: &AppHandle,
    timeout: Duration,
) -> Result<state::RuntimeTransportCredentials, String> {
    let wait_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + timeout;
        loop {
            let state = wait_app.state::<ManagedRuntimeState>();
            let snapshot = state.snapshot()?;
            match snapshot.phase {
                ManagedRuntimePhase::Ready => return state.runtime_transport(),
                ManagedRuntimePhase::Degraded => {
                    return Err(snapshot.error.unwrap_or_else(|| {
                        "Managed Runtime became degraded during restart.".to_string()
                    }));
                }
                ManagedRuntimePhase::ProvisioningRequired => {
                    return Err(
                        "Managed Runtime lost its provisioning state during restart.".to_string(),
                    );
                }
                _ if Instant::now() >= deadline => {
                    return Err(format!(
                        "Managed Runtime did not become ready before the restart deadline (last phase: {:?}).",
                        snapshot.phase,
                    ));
                }
                _ => thread::sleep(Duration::from_millis(250)),
            }
        }
    })
    .await
    .map_err(|error| format!("Managed Runtime readiness task failed: {error}"))?
}

async fn stop_runtime_stack_for_restart(app: &AppHandle) -> Result<(), String> {
    let restart_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = restart_app.state::<ManagedRuntimeState>();
        let process_result = state.stop_processes_for_restart();
        let postgres_result = state.stop_postgres_for_restart();
        process_result.and(postgres_result)
    })
    .await
    .map_err(|error| format!("Managed Runtime restart task failed: {error}"))?
}

async fn initialize_inner(app: &AppHandle) -> Result<(), String> {
    let manifest = inspect_sidecar(app).await?;
    tauri::async_runtime::spawn_blocking(lifecycle::recover_completed_reset)
        .await
        .map_err(|error| format!("Managed Runtime lifecycle recovery task failed: {error}"))??;
    let Some(config) = tauri::async_runtime::spawn_blocking(DesktopRuntimeConfig::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
    else {
        publish_snapshot(app, ManagedRuntimeSnapshot::provisioning_required(manifest));
        return Ok(());
    };
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve WA Desktop resources: {error}"))?;
    let migrations_directory = resource_directory.join("runtime-migrations");
    if !migrations_directory.is_dir() {
        return Err(format!(
            "Bundled Runtime migrations are missing at {}.",
            migrations_directory.display()
        ));
    }
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve WA Desktop data directory: {error}"))?;
    create_dir_all(&app_data_directory)
        .map_err(|error| format!("Could not create WA Desktop data directory: {error}"))?;
    let (database_url, maintenance) = match config.database.clone() {
        DesktopDatabaseConfig::External { url } => (url, None),
        DesktopDatabaseConfig::Managed {
            root,
            backup_root,
            backup_identity,
            password,
        } => {
            publish_snapshot(
                app,
                ManagedRuntimeSnapshot::phase(
                    ManagedRuntimePhase::DatabaseStarting,
                    manifest.clone(),
                ),
            );
            let root = root.unwrap_or_else(|| app_data_directory.join("postgresql"));
            let password = match password {
                Some(password) => password,
                None => {
                    tauri::async_runtime::spawn_blocking(secret_store::managed_postgres_password)
                        .await
                        .map_err(|error| {
                            format!("Managed PostgreSQL local secret task failed: {error}")
                        })??
                }
            };
            let backup_directory = backup_root
                .unwrap_or_else(|| app_data_directory.join("backups").join("postgresql"));
            let database_app = app.clone();
            let (database_url, _) = tauri::async_runtime::spawn_blocking(move || {
                database_app
                    .state::<ManagedRuntimeState>()
                    .start_postgres(&root, password)
            })
            .await
            .map_err(|error| format!("Managed PostgreSQL task failed: {error}"))??;
            let maintenance = Some(ManagedPostgresMaintenanceContext {
                backup_directory,
                backup_identity,
            });
            (database_url, maintenance)
        }
    };
    let migration_path = migrations_directory
        .to_str()
        .ok_or_else(|| "Runtime migration path is not valid UTF-8.".to_string())?;
    let environment =
        config.runtime_environment(migration_path, &database_url, &manifest.openwa_release_tag);
    let migration_plan = run_migration_plan(app, &environment, &app_data_directory).await?;
    observability::info(
        "managed_runtime.migration_plan_inspected",
        json!({
            "databaseState": migration_plan.database_state,
            "pendingCount": migration_plan.pending.len(),
            "checksumBackfillCount": migration_plan.checksums_backfill.len(),
            "requiresBackup": migration_plan.requires_backup,
            "currentFingerprint": migration_plan.current_fingerprint,
            "targetFingerprint": migration_plan.target_fingerprint,
        }),
    );
    if migration_plan.requires_backup {
        if let Some(context) = maintenance.as_ref() {
            create_pre_migration_backup(
                app,
                context,
                &manifest.version,
                &migration_plan.target_fingerprint,
            )
            .await?;
        } else {
            observability::warn(
                "managed_runtime.external_database_migration_unprotected",
                json!({ "pendingCount": migration_plan.pending.len() }),
            );
        }
    }
    if migration_plan.has_work() {
        publish_snapshot(
            app,
            ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Migrating, manifest.clone()),
        );
        run_migrations(app, &environment, &app_data_directory).await?;
    }

    publish_snapshot(
        app,
        ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::RuntimeStarting, manifest.clone()),
    );
    let launch = RuntimeLaunchContext {
        environment,
        working_directory: app_data_directory,
        manifest: manifest.clone(),
        port: config.port,
        api_key: config.api_key.clone(),
    };
    let generation = spawn_runtime(app, &launch)?;
    wait_until_operational(
        app,
        config.port,
        &config.api_key,
        generation.number,
        &generation.instance_id,
    )
    .await?;

    publish_ready_snapshot(app, manifest, config.port, config.api_key)?;
    if let Some(maintenance) = maintenance {
        schedule_background_postgres_maintenance(app, maintenance);
    }
    Ok(())
}

async fn create_pre_migration_backup(
    app: &AppHandle,
    context: &ManagedPostgresMaintenanceContext,
    release_version: &str,
    target_fingerprint: &str,
) -> Result<(), String> {
    let identity = match context.backup_identity.as_ref() {
        Some(encoded) => secret_store::parse_backup_identity(encoded)?,
        None => {
            tauri::async_runtime::spawn_blocking(secret_store::managed_postgres_backup_identity)
                .await
                .map_err(|error| {
                    format!("Managed PostgreSQL local secret task failed: {error}")
                })??
        }
    };
    let backup_directory = context.backup_directory.clone();
    let backup_release = format!(
        "{}-schema-{}",
        release_version,
        target_fingerprint.get(..16).unwrap_or(target_fingerprint),
    );
    let backup_app = app.clone();
    let release_backup_result = tauri::async_runtime::spawn_blocking(move || {
        let state = backup_app.state::<ManagedRuntimeState>();
        let maintenance = state.begin_maintenance("pre-migration database backup")?;
        let cancellation = maintenance.cancellation();
        publish_maintenance(
            &backup_app,
            Some(ManagedRuntimeMaintenance {
                kind: ManagedRuntimeMaintenanceKind::PreMigrationBackup,
                blocking: true,
                cancellable: true,
            }),
        );
        let result = (|| {
            postgres::remove_incomplete_backups(&backup_directory)?;
            state.create_postgres_backup(
                &backup_directory,
                &backup_release,
                &identity,
                &cancellation,
            )
        })();
        publish_maintenance(&backup_app, None);
        result
    })
    .await;
    let release_backup = release_backup_result
        .map_err(|error| format!("Managed PostgreSQL backup task failed: {error}"))??;
    if let Some(path) = release_backup {
        observability::info(
            "managed_postgres.backup_created",
            json!({
                "kind": "pre-migration",
                "backupId": backup_file_name(&path),
                "migrationFingerprint": target_fingerprint,
            }),
        );
    }
    Ok(())
}

fn schedule_background_postgres_maintenance(
    app: &AppHandle,
    context: ManagedPostgresMaintenanceContext,
) {
    let generation = app
        .state::<ManagedRuntimeState>()
        .start_background_maintenance();
    let maintenance_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut delay = BACKGROUND_MAINTENANCE_START_DELAY;
        loop {
            tokio::time::sleep(delay).await;
            if !maintenance_app
                .state::<ManagedRuntimeState>()
                .background_maintenance_is_current(generation)
            {
                break;
            }
            let run_app = maintenance_app.clone();
            let run_context = context.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                run_background_postgres_maintenance(&run_app, &run_context, generation)
            })
            .await;
            report_background_postgres_maintenance(&result);
            if !maintenance_app
                .state::<ManagedRuntimeState>()
                .background_maintenance_is_current(generation)
            {
                break;
            }
            delay =
                background_maintenance_poll_delay(current_timestamp_millis().unwrap_or_default());
        }
        observability::info(
            "managed_postgres.background_maintenance_scheduler_stopped",
            json!({ "generation": generation }),
        );
    });
}

fn run_background_postgres_maintenance(
    app: &AppHandle,
    context: &ManagedPostgresMaintenanceContext,
    generation: u64,
) -> Result<(), String> {
    let state = app.state::<ManagedRuntimeState>();
    if !state.background_maintenance_is_current(generation)
        || state.snapshot()?.phase != ManagedRuntimePhase::Ready
    {
        return Ok(());
    }
    let (integrity_due, automatic_backup_due) =
        state.postgres_background_maintenance_due(&context.backup_directory)?;
    if !integrity_due && !automatic_backup_due {
        return Ok(());
    }
    let guard = match state.begin_maintenance("background database protection") {
        Ok(guard) => guard,
        Err(reason) => {
            observability::info(
                "managed_postgres.background_maintenance_deferred",
                json!({ "reason": reason, "generation": generation }),
            );
            return Ok(());
        }
    };
    if !state.background_maintenance_is_current(generation) {
        return Ok(());
    }
    let cancellation = guard.cancellation();
    let maintenance_result = (|| {
        if integrity_due {
            publish_maintenance(
                app,
                Some(ManagedRuntimeMaintenance {
                    kind: ManagedRuntimeMaintenanceKind::IntegrityCheck,
                    blocking: false,
                    cancellable: true,
                }),
            );
            let integrity_checked =
                state.verify_postgres_integrity_if_due(&context.backup_directory, &cancellation)?;
            if integrity_checked {
                observability::info(
                    "managed_postgres.integrity_check_succeeded",
                    json!({ "tool": "pg_amcheck", "blockingStartup": false }),
                );
            }
        }
        if automatic_backup_due {
            let identity = match context.backup_identity.as_ref() {
                Some(encoded) => secret_store::parse_backup_identity(encoded)?,
                None => secret_store::managed_postgres_backup_identity()?,
            };
            publish_maintenance(
                app,
                Some(ManagedRuntimeMaintenance {
                    kind: ManagedRuntimeMaintenanceKind::AutomaticBackup,
                    blocking: false,
                    cancellable: true,
                }),
            );
            if let Some(path) = state.create_automatic_postgres_backup(
                &context.backup_directory,
                &identity,
                &cancellation,
            )? {
                observability::info(
                    "managed_postgres.backup_created",
                    json!({
                        "kind": "automatic",
                        "backupId": backup_file_name(&path),
                        "blockingStartup": false,
                    }),
                );
            }
        }
        Ok(())
    })();
    publish_maintenance(app, None);
    maintenance_result
}

fn report_background_postgres_maintenance(result: &Result<Result<(), String>, tauri::Error>) {
    match result {
        Err(error) => observability::warn(
            "managed_postgres.background_maintenance_failed",
            json!({ "reason": error.to_string(), "taskFailed": true }),
        ),
        Ok(Err(error)) if error.contains("maintenance was cancelled") => observability::info(
            "managed_postgres.background_maintenance_cancelled",
            json!({}),
        ),
        Ok(Err(error)) => observability::warn(
            "managed_postgres.background_maintenance_failed",
            json!({ "reason": error, "taskFailed": false }),
        ),
        Ok(Ok(())) => {}
    }
}

fn background_maintenance_poll_delay(now_ms: u64) -> Duration {
    let jitter_ceiling_ms = BACKGROUND_MAINTENANCE_MAX_JITTER.as_millis() as u64;
    let jitter_ms = now_ms % (jitter_ceiling_ms + 1);
    BACKGROUND_MAINTENANCE_POLL_INTERVAL + Duration::from_millis(jitter_ms)
}

fn publish_maintenance(app: &AppHandle, maintenance: Option<ManagedRuntimeMaintenance>) {
    let state = app.state::<ManagedRuntimeState>();
    match state.set_maintenance(maintenance) {
        Ok(snapshot) => {
            let _ = app.emit(STATE_CHANGED_EVENT, snapshot);
        }
        Err(error) => observability::error(
            "managed_runtime.maintenance_state_update_failed",
            json!({ "reason": error }),
        ),
    }
}

async fn managed_backup_directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let config = load_runtime_config().await?;
    managed_backup_directory_for_config(app, &config)
}

async fn load_runtime_config() -> Result<DesktopRuntimeConfig, String> {
    tauri::async_runtime::spawn_blocking(DesktopRuntimeConfig::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
        .ok_or_else(|| "Managed Runtime provisioning is unavailable.".to_string())
}

async fn managed_backup_identity(
    config: &DesktopRuntimeConfig,
) -> Result<age::x25519::Identity, String> {
    match config.backup_identity_override() {
        Some(encoded) => secret_store::parse_backup_identity(&encoded),
        None => {
            tauri::async_runtime::spawn_blocking(secret_store::managed_postgres_backup_identity)
                .await
                .map_err(|error| format!("Managed PostgreSQL local secret task failed: {error}"))?
        }
    }
}

fn recovery_passphrase(passphrase: String) -> Result<SecretString, String> {
    if !(16..=1024).contains(&passphrase.chars().count()) {
        return Err(
            "Recovery archive passphrase must contain between 16 and 1024 characters.".to_string(),
        );
    }
    Ok(SecretString::from(passphrase))
}

const QUARANTINE_MANIFEST_FILE: &str = ".wa-studio-quarantine.json";
const QUARANTINE_MANIFEST_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuarantineManifest<'a> {
    format_version: u32,
    created_at_ms: u64,
    reason: &'a str,
}

#[derive(Default)]
struct QuarantineInventory {
    count: usize,
    size_bytes: u64,
}

fn quarantine_postgres_root(root: &Path, reason: &str) -> Result<PathBuf, String> {
    let quarantine = quarantine_path(root, "stale")?;
    fs::rename(root, &quarantine).map_err(|error| {
        format!(
            "Could not quarantine managed PostgreSQL data at {}: {error}",
            quarantine.display()
        )
    })?;
    let created_at_ms = quarantine_timestamp(&quarantine).unwrap_or(current_timestamp_millis()?);
    if let Err(error) = write_quarantine_manifest(&quarantine, created_at_ms, reason) {
        observability::warn(
            "managed_postgres.quarantine_manifest_failed",
            json!({ "reason": reason, "error": error }),
        );
    }
    observability::warn(
        "managed_postgres.data_quarantined",
        json!({
            "reason": reason,
            "quarantine": quarantine.file_name().and_then(|name| name.to_str()),
        }),
    );
    Ok(quarantine)
}

fn write_quarantine_manifest(
    quarantine: &Path,
    created_at_ms: u64,
    reason: &str,
) -> Result<(), String> {
    let manifest = QuarantineManifest {
        format_version: QUARANTINE_MANIFEST_FORMAT_VERSION,
        created_at_ms,
        reason,
    };
    let path = quarantine.join(QUARANTINE_MANIFEST_FILE);
    let partial = quarantine.join(format!("{QUARANTINE_MANIFEST_FILE}.partial"));
    let encoded = serde_json::to_vec(&manifest)
        .map_err(|error| format!("Could not encode PostgreSQL quarantine metadata: {error}"))?;
    let result = (|| {
        let mut file = fs::File::create(&partial)
            .map_err(|error| format!("Could not create PostgreSQL quarantine metadata: {error}"))?;
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not write PostgreSQL quarantine metadata: {error}"))?;
        fs::rename(&partial, &path)
            .map_err(|error| format!("Could not commit PostgreSQL quarantine metadata: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

fn quarantine_inventory(root: &Path) -> Result<QuarantineInventory, String> {
    let mut inventory = QuarantineInventory::default();
    for path in quarantined_cluster_paths(root)? {
        inventory.count += 1;
        inventory.size_bytes = inventory
            .size_bytes
            .saturating_add(directory_size_without_symlinks(&path)?);
    }
    Ok(inventory)
}

fn remove_quarantined_clusters(root: &Path) -> Result<QuarantineInventory, String> {
    let mut removed = QuarantineInventory::default();
    for path in quarantined_cluster_paths(root)? {
        let size_bytes = directory_size_without_symlinks(&path)?;
        fs::remove_dir_all(&path).map_err(|error| {
            format!(
                "Could not delete retained PostgreSQL data at {} after deleting {} earlier item(s): {error}",
                path.display(),
                removed.count,
            )
        })?;
        removed.count += 1;
        removed.size_bytes = removed.size_bytes.saturating_add(size_bytes);
    }
    Ok(removed)
}

fn quarantined_cluster_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let parent = root
        .parent()
        .ok_or_else(|| "Managed PostgreSQL root has no parent directory.".to_string())?;
    let root_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Managed PostgreSQL root name is not valid UTF-8.".to_string())?;
    let prefix = format!("{root_name}-stale-");
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not inspect PostgreSQL quarantines: {error}")),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not inspect PostgreSQL quarantine: {error}"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(&prefix) || quarantine_timestamp(&entry.path()).is_none() {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect PostgreSQL quarantine type: {error}"))?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        paths.push(entry.path());
    }
    paths.sort_unstable();
    Ok(paths)
}

fn directory_size_without_symlinks(path: &Path) -> Result<u64, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect PostgreSQL quarantine storage: {error}"))?;
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
        .map_err(|error| format!("Could not inspect PostgreSQL quarantine storage: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("Could not inspect PostgreSQL quarantine storage: {error}"))?;
        total = total.saturating_add(directory_size_without_symlinks(&entry.path())?);
    }
    Ok(total)
}

fn quarantine_timestamp(path: &Path) -> Option<u64> {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.rsplit_once('-'))
        .and_then(|(_, timestamp)| timestamp.parse().ok())
}

fn quarantine_path(root: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = root
        .parent()
        .ok_or_else(|| "Managed PostgreSQL root has no parent directory.".to_string())?;
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Managed PostgreSQL root name is not valid UTF-8.".to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock error: {error}"))?
        .as_millis();
    Ok(parent.join(format!("{name}-{label}-{timestamp}")))
}

fn managed_backup_directory_for_config(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
) -> Result<std::path::PathBuf, String> {
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve WA Desktop data directory: {error}"))?;
    config
        .managed_backup_directory(&app_data_directory)
        .ok_or_else(|| "External PostgreSQL databases are not managed by WA Studio.".to_string())
}

async fn inspect_sidecar(app: &AppHandle) -> Result<RuntimeReleaseManifest, String> {
    let output = app
        .shell()
        .sidecar("wa-runtime")
        .map_err(|error| format!("Could not resolve WA Runtime sidecar: {error}"))?
        .args(["manifest"])
        .output()
        .await
        .map_err(|error| format!("Could not inspect WA Runtime sidecar: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "WA Runtime manifest command failed.".to_string()
        } else {
            format!("WA Runtime manifest command failed: {stderr}")
        });
    }

    parse_and_validate_manifest(&output.stdout)
}

async fn run_migration_plan(
    app: &AppHandle,
    environment: &[(String, String)],
    working_directory: &Path,
) -> Result<RuntimeMigrationPlan, String> {
    let envelope = config_envelope::prepare(working_directory, environment)?;
    let (mut events, mut child) = app
        .shell()
        .sidecar("wa-runtime")
        .map_err(|error| format!("Could not resolve WA Runtime sidecar: {error}"))?
        .args(["migration-plan"])
        .env_clear()
        .envs(envelope.process_environment())
        .current_dir(working_directory)
        .spawn()
        .map_err(|error| {
            envelope.remove();
            format!("Could not inspect Runtime migrations: {error}")
        })?;
    if let Err(error) = child.write(envelope.key_line().as_bytes()) {
        envelope.remove();
        let _ = child.kill();
        return Err(format!(
            "Could not deliver Runtime migration-plan configuration: {error}"
        ));
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                stdout.extend_from_slice(&line);
                stdout.push(b'\n');
            }
            CommandEvent::Stderr(line) => {
                stderr.extend_from_slice(&line);
                stderr.push(b'\n');
            }
            CommandEvent::Error(error) => {
                stderr.extend_from_slice(error.as_bytes());
                stderr.push(b'\n');
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }
    envelope.remove();
    if exit_code != Some(0) {
        return Err(command_failure("Runtime migration plan", &stderr));
    }
    serde_json::from_slice(&stdout)
        .map_err(|error| format!("Runtime returned an invalid migration plan: {error}"))
}

async fn run_migrations(
    app: &AppHandle,
    environment: &[(String, String)],
    working_directory: &Path,
) -> Result<(), String> {
    let envelope = config_envelope::prepare(working_directory, environment)?;
    let (mut events, mut child) = app
        .shell()
        .sidecar("wa-runtime")
        .map_err(|error| format!("Could not resolve WA Runtime sidecar: {error}"))?
        .args(["migrate"])
        .env_clear()
        .envs(envelope.process_environment())
        .current_dir(working_directory)
        .spawn()
        .map_err(|error| {
            envelope.remove();
            format!("Could not run Runtime migrations: {error}")
        })?;
    if let Err(error) = child.write(envelope.key_line().as_bytes()) {
        envelope.remove();
        let _ = child.kill();
        return Err(format!(
            "Could not deliver Runtime migration configuration: {error}"
        ));
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                stdout.extend_from_slice(&line);
                stdout.push(b'\n');
            }
            CommandEvent::Stderr(line) => {
                stderr.extend_from_slice(&line);
                stderr.push(b'\n');
            }
            CommandEvent::Error(error) => {
                stderr.extend_from_slice(error.as_bytes());
                stderr.push(b'\n');
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }
    envelope.remove();
    if exit_code != Some(0) {
        return Err(command_failure("Runtime migration", &stderr));
    }
    let stdout = String::from_utf8_lossy(&stdout);
    for line in stdout.lines() {
        observability::forward_runtime_line("migrate", "stdout", line.as_bytes());
    }
    Ok(())
}

struct RuntimeGeneration {
    number: u64,
    instance_id: String,
}

#[derive(Clone)]
struct RuntimeLaunchContext {
    environment: Vec<(String, String)>,
    working_directory: PathBuf,
    manifest: RuntimeReleaseManifest,
    port: u16,
    api_key: String,
}

fn spawn_runtime(
    app: &AppHandle,
    launch: &RuntimeLaunchContext,
) -> Result<RuntimeGeneration, String> {
    let generation = app.state::<ManagedRuntimeState>().next_process_generation();
    let instance_id = format!("desktop-{generation}");
    let mut environment = launch.environment.clone();
    environment.push(("RUNTIME_INSTANCE_ID".to_string(), instance_id.clone()));
    let envelope = config_envelope::prepare(&launch.working_directory, &environment)?;
    let (mut events, mut child) = app
        .shell()
        .sidecar("wa-runtime")
        .map_err(|error| format!("Could not resolve WA Runtime sidecar: {error}"))?
        .args(["desktop"])
        .env_clear()
        .envs(envelope.process_environment())
        .current_dir(&launch.working_directory)
        .spawn()
        .map_err(|error| {
            envelope.remove();
            format!("Could not start Runtime desktop generation {generation}: {error}")
        })?;
    if let Err(error) = child.write(envelope.key_line().as_bytes()) {
        envelope.remove();
        let _ = child.kill();
        return Err(format!(
            "Could not deliver Runtime desktop generation {generation} configuration: {error}"
        ));
    }
    let terminated = match app
        .state::<ManagedRuntimeState>()
        .push_process(generation, child)
    {
        Ok(terminated) => terminated,
        Err(error) => {
            envelope.remove();
            return Err(error);
        }
    };

    let app = app.clone();
    let restart_launch = launch.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => log_process_line("desktop", "stdout", &line),
                CommandEvent::Stderr(line) => log_process_line("desktop", "stderr", &line),
                CommandEvent::Error(error) => {
                    observability::error(
                        "managed_runtime.process_error",
                        json!({ "generation": generation, "reason": error.to_string() }),
                    );
                }
                CommandEvent::Terminated(payload) => {
                    terminated.store(true, std::sync::atomic::Ordering::Release);
                    handle_runtime_termination(
                        &app,
                        generation,
                        restart_launch.clone(),
                        format!(
                            "Runtime desktop generation {generation} exited unexpectedly (code {:?}, signal {:?}).",
                            payload.code, payload.signal
                        ),
                    )
                    .await;
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(RuntimeGeneration {
        number: generation,
        instance_id,
    })
}

async fn handle_runtime_termination(
    app: &AppHandle,
    generation: u64,
    launch: RuntimeLaunchContext,
    error: String,
) {
    let state = app.state::<ManagedRuntimeState>();
    let is_current = match state.mark_process_terminated(generation) {
        Ok(current) => current,
        Err(state_error) => {
            publish_snapshot(
                app,
                ManagedRuntimeSnapshot::degraded(Some(launch.manifest), state_error),
            );
            return;
        }
    };
    if !is_current {
        observability::info(
            "managed_runtime.stale_termination_ignored",
            json!({ "generation": generation }),
        );
        return;
    }

    let phase = state.snapshot().map(|snapshot| snapshot.phase);
    if phase
        .as_ref()
        .is_ok_and(|phase| *phase == ManagedRuntimePhase::Ready)
    {
        match state.plan_auto_restart() {
            Ok(AutoRestartPlan::Retry(delay)) => {
                observability::warn(
                    "managed_runtime.restart_scheduled",
                    json!({
                        "generation": generation,
                        "delayMs": delay.as_millis(),
                    }),
                );
                publish_snapshot(
                    app,
                    ManagedRuntimeSnapshot::phase(
                        ManagedRuntimePhase::RuntimeStarting,
                        launch.manifest.clone(),
                    ),
                );
                let wait = tauri::async_runtime::spawn_blocking(move || thread::sleep(delay)).await;
                if let Err(wait_error) = wait {
                    state.finish_auto_restart();
                    publish_snapshot(
                        app,
                        ManagedRuntimeSnapshot::degraded(
                            Some(launch.manifest),
                            format!("Managed Runtime restart delay failed: {wait_error}"),
                        ),
                    );
                    return;
                }
                if !state.auto_restart_is_allowed() {
                    state.finish_auto_restart();
                    return;
                }
                let next_generation = match spawn_runtime(app, &launch) {
                    Ok(generation) => generation,
                    Err(restart_error) => {
                        state.finish_auto_restart();
                        publish_snapshot(
                            app,
                            ManagedRuntimeSnapshot::degraded(Some(launch.manifest), restart_error),
                        );
                        return;
                    }
                };
                let operational = wait_until_operational(
                    app,
                    launch.port,
                    &launch.api_key,
                    next_generation.number,
                    &next_generation.instance_id,
                )
                .await;
                if !state.auto_restart_is_allowed() {
                    state.finish_auto_restart();
                    return;
                }
                if let Err(restart_error) = operational {
                    let stop_app = app.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        stop_app
                            .state::<ManagedRuntimeState>()
                            .stop_processes_for_restart()
                    })
                    .await;
                    state.finish_auto_restart();
                    publish_snapshot(
                        app,
                        ManagedRuntimeSnapshot::degraded(Some(launch.manifest), restart_error),
                    );
                    return;
                }
                state.finish_auto_restart();
                if let Err(ready_error) = publish_ready_snapshot(
                    app,
                    launch.manifest.clone(),
                    launch.port,
                    launch.api_key,
                ) {
                    publish_snapshot(
                        app,
                        ManagedRuntimeSnapshot::degraded(Some(launch.manifest), ready_error),
                    );
                }
            }
            Ok(AutoRestartPlan::Exhausted) => publish_snapshot(
                app,
                ManagedRuntimeSnapshot::degraded(
                    Some(launch.manifest),
                    format!("{error} Automatic restart limit reached (3 attempts in 5 minutes)."),
                ),
            ),
            Ok(AutoRestartPlan::Cancelled) => {}
            Err(state_error) => publish_snapshot(
                app,
                ManagedRuntimeSnapshot::degraded(Some(launch.manifest), state_error),
            ),
        }
        return;
    }

    let should_degrade = phase
        .map(|phase| {
            !matches!(
                phase,
                ManagedRuntimePhase::Stopping
                    | ManagedRuntimePhase::Restoring
                    | ManagedRuntimePhase::Reconfiguring
                    | ManagedRuntimePhase::RotatingCredentials
                    | ManagedRuntimePhase::Resetting
                    | ManagedRuntimePhase::Updating
                    | ManagedRuntimePhase::Degraded
            )
        })
        .unwrap_or(true);
    if should_degrade {
        publish_snapshot(
            app,
            ManagedRuntimeSnapshot::degraded(Some(launch.manifest), error),
        );
    }
}

async fn wait_until_operational(
    app: &AppHandle,
    port: u16,
    api_key: &str,
    generation: u64,
    instance_id: &str,
) -> Result<(), String> {
    let readiness_app = app.clone();
    let api_key = api_key.to_string();
    let instance_id = instance_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(45);
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        while Instant::now() < deadline {
            if !readiness_app
                .state::<ManagedRuntimeState>()
                .process_generation_is_current(generation)?
            {
                return Err(format!(
                    "Managed Runtime generation {generation} exited before becoming operational."
                ));
            }
            if runtime_is_operational(address, &api_key, &instance_id) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(500));
        }
        Err(format!(
            "Managed Runtime generation {generation} did not become operational on 127.0.0.1:{port} within 45 seconds."
        ))
    })
    .await
    .map_err(|error| format!("Runtime operational health task failed: {error}"))?
}

fn runtime_is_operational(address: SocketAddr, api_key: &str, instance_id: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    if api_key.contains('\r') || api_key.contains('\n') {
        return false;
    }
    let request = format!(
        "GET /api/v1/health/operational HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Runtime-Key: {api_key}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && operational_response_matches(&response, instance_id)
}

fn operational_response_matches(response: &str, instance_id: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !headers.starts_with("HTTP/1.1 200") {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .is_some_and(|payload| {
            let status = payload.get("status").and_then(|value| value.as_str());
            let upstream_only_degradation = status == Some("degraded")
                && matches!(
                    payload.get("reason").and_then(|value| value.as_str()),
                    Some(
                        "upstream_status_unknown"
                            | "upstream_unavailable"
                            | "upstream_incompatible"
                    )
                );
            (status == Some("operational") || upstream_only_degradation)
                && payload.get("instanceId").and_then(|value| value.as_str()) == Some(instance_id)
        })
}

fn publish_snapshot(app: &AppHandle, snapshot: ManagedRuntimeSnapshot) {
    if let Err(error) = app.state::<ManagedRuntimeState>().replace(snapshot.clone()) {
        observability::error(
            "managed_runtime.state_update_failed",
            json!({ "reason": error }),
        );
        return;
    }
    observability::info(
        "managed_runtime.phase_changed",
        json!({ "phase": snapshot.phase }),
    );
    let _ = app.emit(STATE_CHANGED_EVENT, snapshot);
}

fn publish_ready_snapshot(
    app: &AppHandle,
    manifest: RuntimeReleaseManifest,
    port: u16,
    api_key: String,
) -> Result<(), String> {
    let base_url = format!("http://127.0.0.1:{port}");
    app.state::<ManagedRuntimeState>()
        .set_runtime_transport(base_url.clone(), api_key)?;
    publish_snapshot(
        app,
        ManagedRuntimeSnapshot::ready(
            manifest,
            ManagedRuntimeConnection {
                base_url,
                transport: ManagedRuntimeTransportKind::Native,
            },
        ),
    );
    Ok(())
}

fn command_failure(operation: &str, stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if stderr.is_empty() {
        format!("{operation} failed.")
    } else {
        format!("{operation} failed: {stderr}")
    }
}

fn backup_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unavailable")
        .to_string()
}

fn log_process_line(role: &str, stream: &str, bytes: &[u8]) {
    observability::forward_runtime_line(role, stream, bytes);
}

fn parse_and_validate_manifest(bytes: &[u8]) -> Result<RuntimeReleaseManifest, String> {
    let manifest: RuntimeReleaseManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("WA Runtime returned an invalid manifest: {error}"))?;

    if manifest.schema_version != 2 {
        return Err(format!(
            "Unsupported WA Runtime manifest schema {}.",
            manifest.schema_version
        ));
    }
    if manifest.service != "wa-runtime" {
        return Err(format!(
            "Unexpected managed Runtime service {}.",
            manifest.service
        ));
    }
    if manifest.contract_version != "v1" {
        return Err(format!(
            "Unsupported WA Runtime contract {}.",
            manifest.contract_version
        ));
    }
    if manifest.openwa_release_tag != OPENWA_RELEASE_TAG {
        return Err(format!(
            "WA Runtime expects OpenWA {}, but WA Studio reviewed {}.",
            manifest.openwa_release_tag, OPENWA_RELEASE_TAG
        ));
    }
    if manifest.openwa_contract_sha256 != OPENWA_CONTRACT_SHA256 {
        return Err("WA Runtime OpenWA contract snapshot does not match WA Studio.".to_string());
    }
    if !manifest
        .profiles
        .iter()
        .any(|profile| profile == "desktop-managed")
    {
        return Err("WA Runtime does not support the desktop-managed profile.".to_string());
    }
    for role in ["desktop", "migration-plan", "migrate"] {
        if !manifest.roles.iter().any(|candidate| candidate == role) {
            return Err(format!("WA Runtime does not provide the {role} role."));
        }
    }
    if !manifest
        .database_backends
        .iter()
        .any(|backend| backend == "postgres")
    {
        return Err("WA Runtime does not support PostgreSQL.".to_string());
    }
    if !manifest
        .queue_backends
        .iter()
        .any(|backend| backend == "postgres")
    {
        return Err("WA Runtime does not support the PostgreSQL queue backend.".to_string());
    }

    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        background_maintenance_poll_delay, operational_response_matches,
        parse_and_validate_manifest, protection_freshness, quarantine_inventory, quarantine_path,
        quarantine_postgres_root, recovery_passphrase, remove_quarantined_clusters,
        storage_diagnostics, BACKGROUND_MAINTENANCE_MAX_JITTER,
        BACKGROUND_MAINTENANCE_POLL_INTERVAL, OPENWA_CONTRACT_SHA256, OPENWA_RELEASE_TAG,
        QUARANTINE_MANIFEST_FILE,
    };
    use crate::managed_runtime::model::{ProtectionFreshness, StoragePressure};
    use serde_json::json;

    fn valid_manifest() -> String {
        json!({
          "schemaVersion": 2,
          "service": "wa-runtime",
          "version": "0.1.0",
          "contractVersion": "v1",
          "openwaReleaseTag": OPENWA_RELEASE_TAG,
          "openwaContractSha256": OPENWA_CONTRACT_SHA256,
          "profiles": ["server", "desktop-managed"],
          "roles": ["api", "worker", "scheduler", "desktop", "migration-plan", "migrate"],
          "databaseBackends": ["postgres"],
          "queueBackends": ["redis", "postgres"]
        })
        .to_string()
    }

    #[test]
    fn accepts_the_managed_runtime_release_contract() {
        let source = valid_manifest();
        let manifest = parse_and_validate_manifest(source.as_bytes()).unwrap();

        assert_eq!(manifest.service, "wa-runtime");
        assert_eq!(manifest.version, "0.1.0");
    }

    #[test]
    fn rejects_the_legacy_runtime_manifest_schema() {
        let manifest = valid_manifest().replace("\"schemaVersion\":2", "\"schemaVersion\":1");

        assert_eq!(
            parse_and_validate_manifest(manifest.as_bytes()).unwrap_err(),
            "Unsupported WA Runtime manifest schema 1."
        );
    }

    #[test]
    fn classifies_protection_freshness_without_clock_underflow() {
        assert_eq!(
            protection_freshness(1_000, None, 100),
            ProtectionFreshness::Missing
        );
        assert_eq!(
            protection_freshness(1_000, Some(900), 100),
            ProtectionFreshness::Fresh
        );
        assert_eq!(
            protection_freshness(1_000, Some(899), 100),
            ProtectionFreshness::Due
        );
        assert_eq!(
            protection_freshness(1_000, Some(1_001), 100),
            ProtectionFreshness::Fresh
        );
        assert_eq!(
            protection_freshness(1_000, Some(1_000_000), 100),
            ProtectionFreshness::Due
        );
    }

    #[test]
    fn bounds_background_maintenance_poll_jitter() {
        let minimum = background_maintenance_poll_delay(0);
        let maximum = background_maintenance_poll_delay(u64::MAX);

        assert_eq!(minimum, BACKGROUND_MAINTENANCE_POLL_INTERVAL);
        assert!(maximum >= BACKGROUND_MAINTENANCE_POLL_INTERVAL);
        assert!(
            maximum <= BACKGROUND_MAINTENANCE_POLL_INTERVAL + BACKGROUND_MAINTENANCE_MAX_JITTER
        );
    }

    #[test]
    fn reports_storage_pressure_for_the_current_filesystem() {
        let directory = tempfile::tempdir().unwrap();
        let diagnostics = storage_diagnostics(&directory.path().join("missing/app-data")).unwrap();
        assert!(diagnostics.filesystem_total_bytes > 0);
        assert!(diagnostics.filesystem_available_bytes <= diagnostics.filesystem_total_bytes);
        assert!(diagnostics.filesystem_available_percent <= 100);
        assert!(matches!(
            diagnostics.pressure,
            StoragePressure::Normal | StoragePressure::Warning | StoragePressure::Critical
        ));
    }

    #[test]
    fn rejects_a_runtime_without_the_managed_profile() {
        let manifest = valid_manifest().replace("[\"server\",\"desktop-managed\"]", "[\"server\"]");

        assert_eq!(
            parse_and_validate_manifest(manifest.as_bytes()).unwrap_err(),
            "WA Runtime does not support the desktop-managed profile."
        );
    }

    #[test]
    fn rejects_an_incompatible_contract() {
        let manifest = valid_manifest().replace("\"v1\"", "\"v2\"");

        assert_eq!(
            parse_and_validate_manifest(manifest.as_bytes()).unwrap_err(),
            "Unsupported WA Runtime contract v2."
        );
    }

    #[test]
    fn rejects_a_runtime_built_for_another_openwa_release() {
        let incompatible_release = "99.0.0";
        let manifest = valid_manifest().replace(OPENWA_RELEASE_TAG, incompatible_release);

        assert_eq!(
            parse_and_validate_manifest(manifest.as_bytes()).unwrap_err(),
            format!(
                "WA Runtime expects OpenWA {incompatible_release}, but WA Studio reviewed {OPENWA_RELEASE_TAG}."
            )
        );
    }

    #[test]
    fn rejects_a_runtime_without_the_postgres_queue_backend() {
        let manifest = valid_manifest().replace("[\"redis\",\"postgres\"]", "[\"redis\"]");

        assert_eq!(
            parse_and_validate_manifest(manifest.as_bytes()).unwrap_err(),
            "WA Runtime does not support the PostgreSQL queue backend."
        );
    }

    #[test]
    fn rejects_a_runtime_without_the_desktop_role() {
        let manifest = valid_manifest().replace("\"desktop\",", "");

        assert_eq!(
            parse_and_validate_manifest(manifest.as_bytes()).unwrap_err(),
            "WA Runtime does not provide the desktop role."
        );
    }

    #[test]
    fn operational_health_must_match_the_spawned_generation() {
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"operational\",\"instanceId\":\"desktop-7\"}";
        let upstream_degraded = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"degraded\",\"reason\":\"upstream_unavailable\",\"instanceId\":\"desktop-7\"}";

        assert!(operational_response_matches(response, "desktop-7"));
        assert!(operational_response_matches(upstream_degraded, "desktop-7"));
        assert!(!operational_response_matches(
            &upstream_degraded.replace("upstream_unavailable", "background_process_degraded"),
            "desktop-7"
        ));
        assert!(!operational_response_matches(response, "desktop-6"));
        assert!(!operational_response_matches(
            &response.replace("200 OK", "503 Service Unavailable"),
            "desktop-7"
        ));
    }

    #[test]
    fn requires_a_substantial_portable_recovery_passphrase() {
        assert!(recovery_passphrase("short".to_string()).is_err());
        assert!(recovery_passphrase("sixteen-characters".to_string()).is_ok());
    }

    #[test]
    fn quarantines_only_as_a_sibling_of_the_managed_cluster() {
        let path = quarantine_path(Path::new("/var/local/wa/postgresql"), "stale").unwrap();

        assert_eq!(path.parent(), Some(Path::new("/var/local/wa")));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("postgresql-stale-"));
    }

    #[test]
    fn catalogs_quarantined_clusters_without_following_unmanaged_directories() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("postgresql");
        std::fs::create_dir_all(root.join("data-v17")).unwrap();
        std::fs::write(root.join("data-v17/record"), [1, 2, 3, 4]).unwrap();

        let quarantine = quarantine_postgres_root(&root, "test-recovery").unwrap();
        std::fs::create_dir_all(directory.path().join("postgresql-stale-not-a-timestamp")).unwrap();
        let inventory = quarantine_inventory(&root).unwrap();

        assert!(!root.exists());
        assert_eq!(inventory.count, 1);
        assert!(inventory.size_bytes >= 4);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(quarantine.join(QUARANTINE_MANIFEST_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["reason"], "test-recovery");
        assert_eq!(manifest["formatVersion"], 1);
    }

    #[test]
    fn deletes_only_cataloged_quarantined_clusters() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("postgresql");
        let first = directory.path().join("postgresql-stale-100");
        let second = directory.path().join("postgresql-stale-200");
        let malformed = directory.path().join("postgresql-stale-not-a-timestamp");
        let unrelated = directory.path().join("another-postgresql-stale-300");
        std::fs::create_dir_all(first.join("data")).unwrap();
        std::fs::create_dir_all(second.join("data")).unwrap();
        std::fs::create_dir_all(&malformed).unwrap();
        std::fs::create_dir_all(&unrelated).unwrap();
        std::fs::write(first.join("data/one"), [1, 2]).unwrap();
        std::fs::write(second.join("data/two"), [3, 4, 5]).unwrap();

        let removed = remove_quarantined_clusters(&root).unwrap();

        assert_eq!(removed.count, 2);
        assert_eq!(removed.size_bytes, 5);
        assert!(!first.exists());
        assert!(!second.exists());
        assert!(malformed.exists());
        assert!(unrelated.exists());
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_quarantine_shaped_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("postgresql");
        let external = directory.path().join("operator-files");
        let shaped_link = directory.path().join("postgresql-stale-300");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("keep"), [1, 2, 3]).unwrap();
        symlink(&external, &shaped_link).unwrap();

        let removed = remove_quarantined_clusters(&root).unwrap();

        assert_eq!(removed.count, 0);
        assert!(shaped_link.exists());
        assert_eq!(std::fs::read(external.join("keep")).unwrap(), [1, 2, 3]);
    }
}
