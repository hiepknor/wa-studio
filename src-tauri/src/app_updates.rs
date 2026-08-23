use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;

use serde::Serialize;
use tauri::{App, AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::managed_runtime;

const UPDATE_PROGRESS_EVENT: &str = "app-update://progress";
const UPDATE_ENDPOINT: Option<&str> = option_env!("WA_STUDIO_UPDATER_ENDPOINT");
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("WA_STUDIO_UPDATER_PUBLIC_KEY");

#[derive(Clone, Debug)]
struct AppUpdateConfiguration {
    endpoint: Url,
    public_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMetadata {
    version: String,
    current_version: String,
    date: Option<String>,
    notes: Option<String>,
}

impl From<&Update> for AppUpdateMetadata {
    fn from(update: &Update) -> Self {
        Self {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            date: update.date.map(|date| date.to_string()),
            notes: update.body.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateSnapshot {
    enabled: bool,
    current_version: String,
    disabled_reason: Option<String>,
    pending: Option<AppUpdateMetadata>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgress {
    phase: &'static str,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
}

pub struct AppUpdateState {
    configuration: Option<AppUpdateConfiguration>,
    current_version: String,
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
}

impl AppUpdateState {
    fn snapshot(&self) -> Result<AppUpdateSnapshot, String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "App update state lock is poisoned.".to_string())?
            .as_ref()
            .map(AppUpdateMetadata::from);
        Ok(AppUpdateSnapshot {
            enabled: self.configuration.is_some(),
            current_version: self.current_version.clone(),
            disabled_reason: self.configuration.is_none().then(|| {
                "This build has no signed HTTPS update channel. Install a signed release build to enable updates."
                    .to_string()
            }),
            pending,
        })
    }

    fn set_pending(&self, update: Option<Update>) -> Result<(), String> {
        *self
            .pending
            .lock()
            .map_err(|_| "App update state lock is poisoned.".to_string())? = update;
        Ok(())
    }

    fn pending(&self) -> Result<Update, String> {
        self.pending
            .lock()
            .map_err(|_| "App update state lock is poisoned.".to_string())?
            .clone()
            .ok_or_else(|| "Check for an app update before installing it.".to_string())
    }

    fn begin_install(&self) -> Result<InstallGuard<'_>, String> {
        self.installing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "An app update installation is already in progress.".to_string())?;
        Ok(InstallGuard(&self.installing))
    }
}

struct InstallGuard<'a>(&'a AtomicBool);

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub fn initialize(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let configuration = validate_configuration(UPDATE_ENDPOINT, UPDATE_PUBLIC_KEY)
        .map_err(std::io::Error::other)?;
    if let Some(configuration) = &configuration {
        app.handle().plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(configuration.public_key.clone())
                .build(),
        )?;
    }
    app.manage(AppUpdateState {
        configuration,
        current_version: app.package_info().version.to_string(),
        pending: Mutex::new(None),
        installing: AtomicBool::new(false),
    });
    Ok(())
}

#[tauri::command]
pub fn get_app_update_state(state: State<'_, AppUpdateState>) -> Result<AppUpdateSnapshot, String> {
    state.snapshot()
}

#[tauri::command]
pub async fn check_for_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<AppUpdateSnapshot, String> {
    let Some(configuration) = state.configuration.clone() else {
        return state.snapshot();
    };
    if state.installing.load(Ordering::Acquire) {
        return Err("An app update installation is already in progress.".to_string());
    }
    let updater = app
        .updater_builder()
        .endpoints(vec![configuration.endpoint])
        .map_err(|error| format!("Could not configure the signed update endpoint: {error}"))?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Could not initialize the app updater: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Could not check for a signed app update: {error}"))?;
    state.set_pending(update)?;
    state.snapshot()
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
    acknowledge_runtime_interruption: bool,
) -> Result<(), String> {
    if !acknowledge_runtime_interruption {
        return Err(
            "Confirm that the update may pause active local campaigns before installing."
                .to_string(),
        );
    }
    if state.configuration.is_none() {
        return Err("This build has no signed app update channel.".to_string());
    }
    let _install_guard = state.begin_install()?;
    let update = state.pending()?;
    emit_progress(&app, "downloading", Some(0), None);
    let progress_app = app.clone();
    let finished_app = app.clone();
    let mut downloaded = 0_u64;
    let bytes = update
        .download(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                emit_progress(
                    &progress_app,
                    "downloading",
                    Some(downloaded),
                    content_length,
                );
            },
            move || emit_progress(&finished_app, "downloaded", None, None),
        )
        .await
        .map_err(|error| format!("Could not download or verify the signed app update: {error}"))?;

    emit_progress(&app, "backingUp", None, None);
    let backup_path =
        managed_runtime::prepare_for_app_update(&app, &update.current_version, &update.version)
            .await?;
    eprintln!(
        "[app-update] Created and verified pre-update backup at {}.",
        backup_path.display()
    );
    emit_progress(&app, "installing", None, None);
    if let Err(error) = update.install(bytes) {
        managed_runtime::restart_after_failed_app_update(&app).await;
        return Err(format!(
            "Could not install the signed app update; the existing local stack is restarting: {error}"
        ));
    }
    emit_progress(&app, "restarting", None, None);
    app.restart();
}

fn emit_progress(
    app: &AppHandle,
    phase: &'static str,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
) {
    let _ = app.emit(
        UPDATE_PROGRESS_EVENT,
        AppUpdateProgress {
            phase,
            downloaded_bytes,
            total_bytes,
        },
    );
}

fn validate_configuration(
    endpoint: Option<&str>,
    public_key: Option<&str>,
) -> Result<Option<AppUpdateConfiguration>, String> {
    let (endpoint, public_key) =
        match (endpoint, public_key) {
            (None, None) => return Ok(None),
            (Some(_), None) => return Err(
                "WA_STUDIO_UPDATER_PUBLIC_KEY is required when an update endpoint is configured."
                    .to_string(),
            ),
            (None, Some(_)) => return Err(
                "WA_STUDIO_UPDATER_ENDPOINT is required when an updater public key is configured."
                    .to_string(),
            ),
            (Some(endpoint), Some(public_key)) => (endpoint.trim(), public_key.trim()),
        };
    let endpoint = Url::parse(endpoint)
        .map_err(|error| format!("WA_STUDIO_UPDATER_ENDPOINT is invalid: {error}"))?;
    if endpoint.scheme() != "https" || endpoint.host_str().is_none() {
        return Err("WA_STUDIO_UPDATER_ENDPOINT must be an absolute HTTPS URL.".to_string());
    }
    if !endpoint.username().is_empty() || endpoint.password().is_some() {
        return Err("WA_STUDIO_UPDATER_ENDPOINT cannot contain credentials.".to_string());
    }
    if endpoint.fragment().is_some() {
        return Err("WA_STUDIO_UPDATER_ENDPOINT cannot contain a fragment.".to_string());
    }
    if public_key.len() < 32 {
        return Err("WA_STUDIO_UPDATER_PUBLIC_KEY is too short.".to_string());
    }
    Ok(Some(AppUpdateConfiguration {
        endpoint,
        public_key: public_key.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::validate_configuration;

    #[test]
    fn updater_is_disabled_only_when_both_build_values_are_absent() {
        assert!(validate_configuration(None, None).unwrap().is_none());
        assert!(
            validate_configuration(Some("https://updates.example.test/latest.json"), None).is_err()
        );
        assert!(validate_configuration(None, Some(&"k".repeat(64))).is_err());
    }

    #[test]
    fn updater_requires_https_without_embedded_credentials() {
        let key = "k".repeat(64);
        assert!(validate_configuration(
            Some("https://updates.example.test/{{target}}/{{arch}}/{{current_version}}"),
            Some(&key),
        )
        .is_ok());
        assert!(validate_configuration(
            Some("http://updates.example.test/latest.json"),
            Some(&key)
        )
        .is_err());
        assert!(validate_configuration(
            Some("https://user:secret@updates.example.test/latest.json"),
            Some(&key),
        )
        .is_err());
    }
}
