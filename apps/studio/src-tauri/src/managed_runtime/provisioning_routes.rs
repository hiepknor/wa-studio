use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

use dirs::data_dir;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const STORE_DIRECTORY: &str = "dev.hiepknor.wastudio";
const ROUTES_FILE: &str = "managed-runtime-routes.json";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeRoute {
    pub openwa_base_url: String,
    pub event_inbox_base_url: Option<String>,
    pub connector_id: String,
    pub token_generation: u64,
    pub session_scope: Option<String>,
    pub ingress_instance_id: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedRuntimeRoutes {
    schema_version: u8,
    active: Option<ManagedRuntimeRoute>,
    provisioning: Option<ManagedRuntimeRoute>,
    cleanup: Option<ManagedRuntimeRoute>,
}

pub fn active() -> Result<Option<ManagedRuntimeRoute>, String> {
    Ok(load()?.active)
}

pub fn provisioning() -> Result<Option<ManagedRuntimeRoute>, String> {
    Ok(load()?.provisioning)
}

pub fn cleanup() -> Result<Option<ManagedRuntimeRoute>, String> {
    Ok(load()?.cleanup)
}

pub fn save_active(route: ManagedRuntimeRoute) -> Result<(), String> {
    update(|routes| routes.active = Some(route))
}

pub fn save_provisioning(route: ManagedRuntimeRoute) -> Result<(), String> {
    update(|routes| routes.provisioning = Some(route))
}

pub fn save_cleanup(route: ManagedRuntimeRoute) -> Result<(), String> {
    update(|routes| routes.cleanup = Some(route))
}

pub fn clear_active() -> Result<(), String> {
    update(|routes| routes.active = None)
}

pub fn clear_provisioning() -> Result<(), String> {
    update(|routes| routes.provisioning = None)
}

pub fn clear_cleanup() -> Result<(), String> {
    update(|routes| routes.cleanup = None)
}

fn update(mutate: impl FnOnce(&mut ManagedRuntimeRoutes)) -> Result<(), String> {
    let mut routes = load()?;
    mutate(&mut routes);
    save(&routes)
}

fn load() -> Result<ManagedRuntimeRoutes, String> {
    let path = routes_path()?;
    load_from(&path)
}

fn load_from(path: &std::path::Path) -> Result<ManagedRuntimeRoutes, String> {
    let encoded = match fs::read_to_string(path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManagedRuntimeRoutes {
                schema_version: 1,
                ..ManagedRuntimeRoutes::default()
            });
        }
        Err(error) => {
            return Err(format!(
                "Could not read Managed Runtime routing metadata: {error}"
            ));
        }
    };
    let routes: ManagedRuntimeRoutes = serde_json::from_str(&encoded)
        .map_err(|_| "Managed Runtime routing metadata is invalid.".to_string())?;
    if routes.schema_version != 1 {
        return Err("Managed Runtime routing metadata has an unsupported format.".to_string());
    }
    Ok(routes)
}

fn save(routes: &ManagedRuntimeRoutes) -> Result<(), String> {
    let path = routes_path()?;
    save_to(&path, routes)
}

fn save_to(path: &std::path::Path, routes: &ManagedRuntimeRoutes) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "Managed Runtime routing directory is invalid.".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create Managed Runtime routing directory: {error}"))?;
    let temporary = directory.join(format!(".{ROUTES_FILE}.{}.tmp", Uuid::new_v4()));
    let encoded = serde_json::to_vec(routes)
        .map_err(|error| format!("Could not encode Managed Runtime routing metadata: {error}"))?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), String> {
        let mut file = options.open(&temporary).map_err(|error| {
            format!("Could not create Managed Runtime routing metadata: {error}")
        })?;
        file.write_all(&encoded).map_err(|error| {
            format!("Could not write Managed Runtime routing metadata: {error}")
        })?;
        file.sync_all().map_err(|error| {
            format!("Could not flush Managed Runtime routing metadata: {error}")
        })?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not replace Managed Runtime routing metadata: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn routes_path() -> Result<PathBuf, String> {
    data_dir()
        .map(|directory| directory.join(STORE_DIRECTORY).join(ROUTES_FILE))
        .ok_or_else(|| "Could not resolve the WA Studio application data directory.".to_string())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{load_from, save_to, ManagedRuntimeRoute, ManagedRuntimeRoutes};

    fn route(generation: u64) -> ManagedRuntimeRoute {
        ManagedRuntimeRoute {
            openwa_base_url: "https://openwa.example.test".to_string(),
            event_inbox_base_url: Some("https://events.example.test".to_string()),
            connector_id: "00000000-0000-4000-8000-000000000003".to_string(),
            token_generation: generation,
            session_scope: Some("00000000-0000-4000-8000-000000000001".to_string()),
            ingress_instance_id: "wa-studio-00000000-0000-4000-8000-000000000003".to_string(),
        }
    }

    #[test]
    fn atomically_replaces_routing_metadata_without_storing_credentials() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("routes.json");
        let mut routes = ManagedRuntimeRoutes {
            schema_version: 1,
            active: Some(route(1)),
            ..ManagedRuntimeRoutes::default()
        };
        save_to(&path, &routes).unwrap();
        routes.active = Some(route(2));
        save_to(&path, &routes).unwrap();

        assert_eq!(load_from(&path).unwrap(), routes);
        let encoded = std::fs::read_to_string(path).unwrap();
        for forbidden in [
            "apiKey",
            "deviceToken",
            "connectorToken",
            "webhookSecret",
            "ingressSecret",
        ] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[test]
    fn rejects_unknown_or_unsupported_routing_metadata() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("routes.json");
        std::fs::write(&path, r#"{"schemaVersion":2,"unexpected":true}"#).unwrap();

        assert!(load_from(&path).is_err());
    }
}
