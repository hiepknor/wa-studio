mod config;
mod model;
mod postgres;
mod provisioning;
mod secret_store;
mod state;

use std::{
    fs::create_dir_all,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use config::{DesktopDatabaseConfig, DesktopRuntimeConfig};
use model::{ManagedRuntimeConnection, ManagedRuntimePhase};
use provisioning::{ManagedRuntimeProvisioningInput, ManagedRuntimeProvisioningProfile};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

pub use model::{ManagedRuntimeBackup, ManagedRuntimeSnapshot, RuntimeReleaseManifest};
pub use state::ManagedRuntimeState;

pub const STATE_CHANGED_EVENT: &str = "managed-runtime://state-changed";

#[tauri::command]
pub fn get_managed_runtime_state(
    state: State<'_, ManagedRuntimeState>,
) -> Result<ManagedRuntimeSnapshot, String> {
    state.snapshot()
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
    if !matches!(
        phase,
        ManagedRuntimePhase::Ready | ManagedRuntimePhase::Degraded
    ) {
        return Err(
            "Managed Runtime must be ready or degraded before reconfiguration.".to_string(),
        );
    }
    let profile = tauri::async_runtime::spawn_blocking(move || provisioning::reconfigure(input))
        .await
        .map_err(|error| format!("Managed Runtime reconfiguration task failed: {error}"))??;
    if let Some(manifest) = state.snapshot()?.manifest {
        publish_snapshot(
            &app,
            ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Reconfiguring, manifest),
        );
    }
    restart_managed_runtime(&app).await?;
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
    if snapshot.phase != ManagedRuntimePhase::Ready {
        return Err("Managed Runtime must be ready before restoring a backup.".to_string());
    }
    let manifest = snapshot
        .manifest
        .ok_or_else(|| "Managed Runtime release metadata is unavailable.".to_string())?;
    let config = tauri::async_runtime::spawn_blocking(DesktopRuntimeConfig::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
        .ok_or_else(|| "Managed Runtime provisioning is unavailable.".to_string())?;
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
            .restore_postgres_backup(&backup_directory, &backup_id, &release_version, &identity)
    })
    .await
    .map_err(|error| format!("Managed PostgreSQL restore task failed: {error}"))?;
    if let Ok(ref safety_backup) = restore_result {
        eprintln!(
            "[managed-postgres] Restored encrypted backup; pre-restore safety backup is at {}.",
            safety_backup.display()
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
pub async fn reset_managed_runtime_database(app: AppHandle) -> Result<(), String> {
    let snapshot = app.state::<ManagedRuntimeState>().snapshot()?;
    if snapshot.phase != ManagedRuntimePhase::Degraded {
        return Err(
            "Local workspace reset is only available after a Runtime startup failure.".to_string(),
        );
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve WA Desktop data directory: {error}"))?;
    let postgres_dir = data_dir.join("postgresql");
    let quarantine = data_dir.join(format!(
        "postgresql-stale-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("System clock error: {error}"))?
            .as_millis()
    ));
    let reset_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = reset_app.state::<ManagedRuntimeState>();
        state.stop_processes_for_restart()?;
        state.stop_postgres_for_restart()?;
        if postgres_dir.exists() {
            std::fs::rename(&postgres_dir, &quarantine)
                .map_err(|error| format!("Could not quarantine local PostgreSQL data: {error}"))?;
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
        eprintln!("[managed-runtime] {error}");
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
                Err(cleanup_error) => eprintln!(
                    "[managed-runtime] Initialization cleanup task failed: {cleanup_error}"
                ),
                Ok(Err(cleanup_error)) => {
                    eprintln!("[managed-runtime] Initialization cleanup failed: {cleanup_error}")
                }
                Ok(Ok(())) => {}
            }
            eprintln!("[managed-runtime] Initialization failed: {error}");
            publish_snapshot(&app, ManagedRuntimeSnapshot::degraded(manifest, error));
        }
        app.state::<ManagedRuntimeState>().finish_initialization();
    });
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<ManagedRuntimeState>();
    if let Ok(snapshot) = state.snapshot() {
        if let Some(manifest) = snapshot.manifest {
            publish_snapshot(
                app,
                ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Stopping, manifest),
            );
        }
    }
    let _ = state.stop_processes();
    let _ = state.stop_postgres();
}

pub async fn prepare_for_app_update(
    app: &AppHandle,
    current_version: &str,
    target_version: &str,
) -> Result<std::path::PathBuf, String> {
    let state = app.state::<ManagedRuntimeState>();
    let _maintenance = state.begin_maintenance("app update")?;
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
        Err(error) => eprintln!("[managed-runtime] Failed-update cleanup task failed: {error}"),
        Ok(Err(error)) => eprintln!("[managed-runtime] Failed-update cleanup failed: {error}"),
        Ok(Ok(())) => {}
    }
    app.state::<ManagedRuntimeState>().resume_for_restart();
    initialize(app);
}

async fn restart_managed_runtime(app: &AppHandle) -> Result<(), String> {
    let restart_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = restart_app.state::<ManagedRuntimeState>();
        let process_result = state.stop_processes_for_restart();
        let postgres_result = state.stop_postgres_for_restart();
        process_result.and(postgres_result)
    })
    .await
    .map_err(|error| format!("Managed Runtime restart task failed: {error}"))
    .and_then(|result| result);
    app.state::<ManagedRuntimeState>().resume_for_restart();
    initialize(app);
    result
}

async fn initialize_inner(app: &AppHandle) -> Result<(), String> {
    let manifest = inspect_sidecar(app).await?;
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
    let database_url = match config.database.clone() {
        DesktopDatabaseConfig::External { url } => url,
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
            let release_version = manifest.version.clone();
            let database_app = app.clone();
            let (database_url, database_preexisting) =
                tauri::async_runtime::spawn_blocking(move || {
                    database_app
                        .state::<ManagedRuntimeState>()
                        .start_postgres(&root, password)
                })
                .await
                .map_err(|error| format!("Managed PostgreSQL task failed: {error}"))??;
            if database_preexisting {
                let identity = match backup_identity {
                    Some(encoded) => secret_store::parse_backup_identity(&encoded)?,
                    None => tauri::async_runtime::spawn_blocking(
                        secret_store::managed_postgres_backup_identity,
                    )
                    .await
                    .map_err(|error| {
                        format!("Managed PostgreSQL local secret task failed: {error}")
                    })??,
                };
                let backup_app = app.clone();
                if let Some(path) = tauri::async_runtime::spawn_blocking(move || {
                    backup_app
                        .state::<ManagedRuntimeState>()
                        .create_postgres_backup(&backup_directory, &release_version, &identity)
                })
                .await
                .map_err(|error| format!("Managed PostgreSQL backup task failed: {error}"))??
                {
                    eprintln!(
                        "[managed-postgres] Created and verified encrypted pre-migration backup at {}.",
                        path.display()
                    );
                }
            }
            database_url
        }
    };
    let migration_path = migrations_directory
        .to_str()
        .ok_or_else(|| "Runtime migration path is not valid UTF-8.".to_string())?;
    let environment = config.runtime_environment(migration_path, &database_url);

    publish_snapshot(
        app,
        ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::Migrating, manifest.clone()),
    );
    run_migrations(app, &environment, &app_data_directory).await?;

    publish_snapshot(
        app,
        ManagedRuntimeSnapshot::phase(ManagedRuntimePhase::RuntimeStarting, manifest.clone()),
    );
    for role in ["api", "worker", "scheduler"] {
        spawn_role(
            app,
            role,
            &environment,
            &app_data_directory,
            manifest.clone(),
        )?;
    }
    wait_until_ready(config.port).await?;

    publish_snapshot(
        app,
        ManagedRuntimeSnapshot::ready(
            manifest,
            ManagedRuntimeConnection {
                base_url: format!("http://127.0.0.1:{}", config.port),
                api_key: config.api_key,
            },
        ),
    );
    Ok(())
}

async fn managed_backup_directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let config = tauri::async_runtime::spawn_blocking(DesktopRuntimeConfig::load)
        .await
        .map_err(|error| format!("Managed Runtime configuration task failed: {error}"))??
        .ok_or_else(|| "Managed Runtime provisioning is unavailable.".to_string())?;
    managed_backup_directory_for_config(app, &config)
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

async fn run_migrations(
    app: &AppHandle,
    environment: &[(String, String)],
    working_directory: &Path,
) -> Result<(), String> {
    let output = app
        .shell()
        .sidecar("wa-runtime")
        .map_err(|error| format!("Could not resolve WA Runtime sidecar: {error}"))?
        .args(["migrate"])
        .envs(environment.iter().cloned())
        .current_dir(working_directory)
        .output()
        .await
        .map_err(|error| format!("Could not run Runtime migrations: {error}"))?;
    if !output.status.success() {
        return Err(command_failure("Runtime migration", &output.stderr));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.trim().is_empty() {
        eprintln!("[wa-runtime:migrate] {}", stdout.trim());
    }
    Ok(())
}

fn spawn_role(
    app: &AppHandle,
    role: &'static str,
    environment: &[(String, String)],
    working_directory: &Path,
    manifest: RuntimeReleaseManifest,
) -> Result<(), String> {
    let (mut events, child) = app
        .shell()
        .sidecar("wa-runtime")
        .map_err(|error| format!("Could not resolve WA Runtime sidecar: {error}"))?
        .args([role])
        .envs(environment.iter().cloned())
        .current_dir(working_directory)
        .spawn()
        .map_err(|error| format!("Could not start Runtime {role}: {error}"))?;
    app.state::<ManagedRuntimeState>().push_process(child)?;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => log_process_line(role, "stdout", &line),
                CommandEvent::Stderr(line) => log_process_line(role, "stderr", &line),
                CommandEvent::Error(error) => {
                    eprintln!("[wa-runtime:{role}] process error: {error}");
                }
                CommandEvent::Terminated(payload) => {
                    let state = app.state::<ManagedRuntimeState>();
                    let should_degrade = state
                        .snapshot()
                        .map(|snapshot| {
                            !matches!(
                                snapshot.phase,
                                ManagedRuntimePhase::Stopping
                                    | ManagedRuntimePhase::Restoring
                                    | ManagedRuntimePhase::Reconfiguring
                                    | ManagedRuntimePhase::Updating
                                    | ManagedRuntimePhase::Degraded
                            )
                        })
                        .unwrap_or(true);
                    if should_degrade {
                        publish_snapshot(
                            &app,
                            ManagedRuntimeSnapshot::degraded(
                                Some(manifest),
                                format!(
                                    "Runtime {role} exited unexpectedly (code {:?}, signal {:?}).",
                                    payload.code, payload.signal
                                ),
                            ),
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

async fn wait_until_ready(port: u16) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(45);
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        while Instant::now() < deadline {
            if runtime_is_ready(address) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(500));
        }
        Err(format!(
            "Managed Runtime did not become ready on 127.0.0.1:{port} within 45 seconds."
        ))
    })
    .await
    .map_err(|error| format!("Runtime readiness task failed: {error}"))?
}

fn runtime_is_ready(address: SocketAddr) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let request =
        b"GET /api/v1/health/ready HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("\"status\":\"ready\"")
}

fn publish_snapshot(app: &AppHandle, snapshot: ManagedRuntimeSnapshot) {
    if let Err(error) = app.state::<ManagedRuntimeState>().replace(snapshot.clone()) {
        eprintln!("Could not update managed Runtime state: {error}");
        return;
    }
    let _ = app.emit(STATE_CHANGED_EVENT, snapshot);
}

fn command_failure(operation: &str, stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if stderr.is_empty() {
        format!("{operation} failed.")
    } else {
        format!("{operation} failed: {stderr}")
    }
}

fn log_process_line(role: &str, stream: &str, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    if !line.trim().is_empty() {
        eprintln!("[wa-runtime:{role}:{stream}] {}", line.trim());
    }
}

fn parse_and_validate_manifest(bytes: &[u8]) -> Result<RuntimeReleaseManifest, String> {
    let manifest: RuntimeReleaseManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("WA Runtime returned an invalid manifest: {error}"))?;

    if manifest.schema_version != 1 {
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
    if !manifest
        .profiles
        .iter()
        .any(|profile| profile == "desktop-managed")
    {
        return Err("WA Runtime does not support the desktop-managed profile.".to_string());
    }
    for role in ["api", "worker", "scheduler", "migrate"] {
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
    use super::parse_and_validate_manifest;

    const VALID_MANIFEST: &str = r#"{
      "schemaVersion": 1,
      "service": "wa-runtime",
      "version": "0.1.0",
      "contractVersion": "v1",
      "profiles": ["server", "desktop-managed"],
      "roles": ["api", "worker", "scheduler", "migrate"],
      "databaseBackends": ["postgres"],
      "queueBackends": ["redis", "postgres"]
    }"#;

    #[test]
    fn accepts_the_managed_runtime_release_contract() {
        let manifest = parse_and_validate_manifest(VALID_MANIFEST.as_bytes()).unwrap();

        assert_eq!(manifest.service, "wa-runtime");
        assert_eq!(manifest.version, "0.1.0");
    }

    #[test]
    fn rejects_a_runtime_without_the_managed_profile() {
        let manifest = VALID_MANIFEST.replace("[\"server\", \"desktop-managed\"]", "[\"server\"]");

        assert_eq!(
            parse_and_validate_manifest(manifest.as_bytes()).unwrap_err(),
            "WA Runtime does not support the desktop-managed profile."
        );
    }

    #[test]
    fn rejects_an_incompatible_contract() {
        let manifest = VALID_MANIFEST.replace("\"v1\"", "\"v2\"");

        assert_eq!(
            parse_and_validate_manifest(manifest.as_bytes()).unwrap_err(),
            "Unsupported WA Runtime contract v2."
        );
    }

    #[test]
    fn rejects_a_runtime_without_the_postgres_queue_backend() {
        let manifest = VALID_MANIFEST.replace("[\"redis\", \"postgres\"]", "[\"redis\"]");

        assert_eq!(
            parse_and_validate_manifest(manifest.as_bytes()).unwrap_err(),
            "WA Runtime does not support the PostgreSQL queue backend."
        );
    }
}
