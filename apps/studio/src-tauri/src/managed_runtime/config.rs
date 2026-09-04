use std::collections::HashMap;
use std::path::PathBuf;

use super::provisioning;

const ENABLE_DEV_RUNTIME: &str = "WA_DESKTOP_DEV_RUNTIME";

#[derive(Clone, Debug)]
pub enum DesktopDatabaseConfig {
    External {
        url: String,
    },
    Managed {
        root: Option<PathBuf>,
        backup_root: Option<PathBuf>,
        backup_identity: Option<String>,
        password: Option<String>,
    },
}

#[derive(Clone, Debug)]
struct DesktopEventInboxConfig {
    base_url: String,
    device_token: String,
    callback_url: String,
}

#[derive(Clone, Debug)]
struct DesktopOpenWaConnectorConfig {
    connector_id: String,
    plugin_version: String,
    instance_id: String,
    ingress_secret: String,
}

#[derive(Clone, Debug)]
pub struct DesktopRuntimeConfig {
    pub port: u16,
    pub api_key: String,
    pub database: DesktopDatabaseConfig,
    node_environment: String,
    openwa_base_url: String,
    openwa_api_key: String,
    openwa_webhook_secret: String,
    openwa_allowed_session_ids: String,
    openwa_compatibility_freshness_ms: Option<u64>,
    openwa_compatibility_probe_interval_ms: Option<u64>,
    allow_live_sends: bool,
    event_inbox: DesktopEventInboxConfig,
    connector: Option<DesktopOpenWaConnectorConfig>,
}

impl DesktopRuntimeConfig {
    pub fn load() -> Result<Option<Self>, String> {
        if let Some(config) = Self::from_environment()? {
            return Ok(Some(config));
        }
        let Some(settings) = provisioning::load()? else {
            return Ok(None);
        };
        let connector = settings
            .connector
            .map(|connector| DesktopOpenWaConnectorConfig {
                connector_id: connector.connector_id,
                plugin_version: connector.plugin_version,
                instance_id: connector.instance_id,
                ingress_secret: connector.ingress_secret,
            });
        Ok(Some(Self {
            port: 34_100,
            api_key: settings.runtime_api_key,
            database: DesktopDatabaseConfig::Managed {
                root: None,
                backup_root: None,
                backup_identity: None,
                password: None,
            },
            node_environment: "production".to_string(),
            openwa_base_url: settings.openwa_base_url,
            openwa_api_key: settings.openwa_api_key,
            openwa_webhook_secret: settings.openwa_webhook_secret,
            openwa_allowed_session_ids: settings.openwa_allowed_session_ids.join(","),
            openwa_compatibility_freshness_ms: None,
            openwa_compatibility_probe_interval_ms: None,
            allow_live_sends: settings.allow_live_sends,
            event_inbox: DesktopEventInboxConfig {
                base_url: settings.event_inbox.base_url,
                device_token: settings.event_inbox.device_token,
                callback_url: settings.event_inbox.callback_url,
            },
            connector,
        }))
    }

    pub fn from_environment() -> Result<Option<Self>, String> {
        if std::env::var(ENABLE_DEV_RUNTIME).ok().as_deref() != Some("1") {
            return Ok(None);
        }

        let required = [
            "WA_DESKTOP_RUNTIME_API_KEY",
            "WA_DESKTOP_OPENWA_BASE_URL",
            "WA_DESKTOP_OPENWA_API_KEY",
            "WA_DESKTOP_OPENWA_WEBHOOK_SECRET",
            "WA_DESKTOP_OPENWA_ALLOWED_SESSION_IDS",
            "WA_DESKTOP_EVENT_INBOX_BASE_URL",
            "WA_DESKTOP_EVENT_INBOX_DEVICE_TOKEN",
            "WA_DESKTOP_EVENT_INBOX_CALLBACK_URL",
        ];
        let values = required
            .iter()
            .filter_map(|name| {
                std::env::var(name)
                    .ok()
                    .map(|value| ((*name).to_string(), value))
            })
            .collect::<HashMap<_, _>>();
        let missing = required
            .iter()
            .filter(|name| !values.contains_key(**name))
            .copied()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(format!(
                "Managed Runtime developer provisioning is incomplete: missing {}.",
                missing.join(", ")
            ));
        }

        let port = std::env::var("WA_DESKTOP_RUNTIME_PORT")
            .ok()
            .map(|value| {
                value.parse::<u16>().map_err(|_| {
                    "WA_DESKTOP_RUNTIME_PORT must be an integer between 1 and 65535.".to_string()
                })
            })
            .transpose()?
            .unwrap_or(34_100);
        if port == 0 {
            return Err(
                "WA_DESKTOP_RUNTIME_PORT must be an integer between 1 and 65535.".to_string(),
            );
        }
        let api_key = value(&values, "WA_DESKTOP_RUNTIME_API_KEY")?;
        if api_key.len() < 32 {
            return Err(
                "WA_DESKTOP_RUNTIME_API_KEY must contain at least 32 characters.".to_string(),
            );
        }
        let event_inbox_device_token = value(&values, "WA_DESKTOP_EVENT_INBOX_DEVICE_TOKEN")?;
        if event_inbox_device_token.len() < 32 {
            return Err(
                "WA_DESKTOP_EVENT_INBOX_DEVICE_TOKEN must contain at least 32 characters."
                    .to_string(),
            );
        }
        let database = match optional_environment("WA_DESKTOP_DATABASE_URL")? {
            Some(url) => DesktopDatabaseConfig::External { url },
            None => {
                let password = optional_environment("WA_DESKTOP_DATABASE_PASSWORD")?;
                if password.as_ref().is_some_and(|value| value.len() < 32) {
                    return Err(
                        "WA_DESKTOP_DATABASE_PASSWORD must contain at least 32 characters."
                            .to_string(),
                    );
                }
                DesktopDatabaseConfig::Managed {
                    root: optional_environment("WA_DESKTOP_POSTGRES_ROOT")?.map(PathBuf::from),
                    backup_root: optional_environment("WA_DESKTOP_BACKUP_ROOT")?.map(PathBuf::from),
                    backup_identity: optional_environment("WA_DESKTOP_BACKUP_IDENTITY")?,
                    password,
                }
            }
        };
        let node_environment = optional_environment("WA_DESKTOP_RUNTIME_NODE_ENV")?
            .unwrap_or_else(|| "development".to_string());
        if !matches!(
            node_environment.as_str(),
            "development" | "test" | "production"
        ) {
            return Err(
                "WA_DESKTOP_RUNTIME_NODE_ENV must be development, test, or production.".to_string(),
            );
        }
        let openwa_compatibility_freshness_ms = optional_environment(
            "WA_DESKTOP_OPENWA_COMPATIBILITY_FRESHNESS_MS",
        )?
        .map(|value| {
            value.parse::<u64>().map_err(|_| {
                "WA_DESKTOP_OPENWA_COMPATIBILITY_FRESHNESS_MS must be an integer between 1000 and 300000."
                    .to_string()
            })
        })
        .transpose()?;
        if openwa_compatibility_freshness_ms
            .is_some_and(|value| !(1_000..=300_000).contains(&value))
        {
            return Err(
                "WA_DESKTOP_OPENWA_COMPATIBILITY_FRESHNESS_MS must be an integer between 1000 and 300000."
                    .to_string(),
            );
        }
        let openwa_compatibility_probe_interval_ms = optional_environment(
            "WA_DESKTOP_OPENWA_COMPATIBILITY_PROBE_INTERVAL_MS",
        )?
        .map(|value| {
            value.parse::<u64>().map_err(|_| {
                "WA_DESKTOP_OPENWA_COMPATIBILITY_PROBE_INTERVAL_MS must be an integer between 10000 and 3600000."
                    .to_string()
            })
        })
        .transpose()?;
        if openwa_compatibility_probe_interval_ms
            .is_some_and(|value| !(10_000..=3_600_000).contains(&value))
        {
            return Err(
                "WA_DESKTOP_OPENWA_COMPATIBILITY_PROBE_INTERVAL_MS must be an integer between 10000 and 3600000."
                    .to_string(),
            );
        }
        let connector_values = [
            optional_environment("WA_DESKTOP_OPENWA_CONNECTOR_ID")?,
            optional_environment("WA_DESKTOP_OPENWA_CONNECTOR_PLUGIN_VERSION")?,
            optional_environment("WA_DESKTOP_OPENWA_CONNECTOR_INSTANCE_ID")?,
            optional_environment("WA_DESKTOP_OPENWA_CONNECTOR_INGRESS_SECRET")?,
        ];
        let connector = match connector_values {
            [None, None, None, None] => None,
            [Some(connector_id), Some(plugin_version), Some(instance_id), Some(ingress_secret)] => {
                if uuid::Uuid::parse_str(&connector_id).is_err()
                    || plugin_version.is_empty()
                    || instance_id.is_empty()
                    || ingress_secret.len() < 32
                {
                    return Err(
                        "Managed Runtime developer connector provisioning is invalid.".to_string(),
                    );
                }
                Some(DesktopOpenWaConnectorConfig {
                    connector_id,
                    plugin_version,
                    instance_id,
                    ingress_secret,
                })
            }
            _ => {
                return Err(
                    "Managed Runtime developer connector provisioning is incomplete.".to_string(),
                )
            }
        };
        let allow_live_sends =
            std::env::var("WA_DESKTOP_ALLOW_LIVE_SENDS").ok().as_deref() == Some("true");
        if node_environment == "production" && allow_live_sends && connector.is_none() {
            return Err(
                "Production live sends require a fully provisioned OpenWA connector.".to_string(),
            );
        }

        Ok(Some(Self {
            port,
            api_key,
            database,
            node_environment,
            openwa_base_url: value(&values, "WA_DESKTOP_OPENWA_BASE_URL")?,
            openwa_api_key: value(&values, "WA_DESKTOP_OPENWA_API_KEY")?,
            openwa_webhook_secret: value(&values, "WA_DESKTOP_OPENWA_WEBHOOK_SECRET")?,
            openwa_allowed_session_ids: value(&values, "WA_DESKTOP_OPENWA_ALLOWED_SESSION_IDS")?,
            openwa_compatibility_freshness_ms,
            openwa_compatibility_probe_interval_ms,
            allow_live_sends,
            event_inbox: DesktopEventInboxConfig {
                base_url: value(&values, "WA_DESKTOP_EVENT_INBOX_BASE_URL")?,
                device_token: event_inbox_device_token,
                callback_url: value(&values, "WA_DESKTOP_EVENT_INBOX_CALLBACK_URL")?,
            },
            connector,
        }))
    }

    pub fn runtime_environment(
        &self,
        migrations_directory: &str,
        database_url: &str,
        openwa_release_tag: &str,
    ) -> Vec<(String, String)> {
        let mut environment = vec![
            ("NODE_ENV".to_string(), self.node_environment.clone()),
            ("RUNTIME_PROFILE".to_string(), "desktop-managed".to_string()),
            (
                "WA_STUDIO_VERSION".to_string(),
                env!("CARGO_PKG_VERSION").to_string(),
            ),
            (
                "RUNTIME_STORAGE_POLICY_VERSION".to_string(),
                "1".to_string(),
            ),
            (
                "RUNTIME_MESSAGE_STORAGE_MODE".to_string(),
                "disabled".to_string(),
            ),
            (
                "RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED".to_string(),
                "true".to_string(),
            ),
            (
                "RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED".to_string(),
                "true".to_string(),
            ),
            ("RUNTIME_INBOX_RETENTION_DAYS".to_string(), "7".to_string()),
            (
                "RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS".to_string(),
                "20000".to_string(),
            ),
            (
                "RUNTIME_WEBHOOK_SPOOL_MAX_BYTES".to_string(),
                "268435456".to_string(),
            ),
            ("RUNTIME_BIND_HOST".to_string(), "127.0.0.1".to_string()),
            ("PORT".to_string(), self.port.to_string()),
            ("DATABASE_URL".to_string(), database_url.to_string()),
            ("QUEUE_BACKEND".to_string(), "postgres".to_string()),
            (
                "GATEWAY_TARGETED_RECONCILIATION_ENABLED".to_string(),
                "true".to_string(),
            ),
            (
                "GATEWAY_SYNC_NOTIFY_WAKEUP_ENABLED".to_string(),
                "true".to_string(),
            ),
            (
                "RUNTIME_PARENT_PID".to_string(),
                std::process::id().to_string(),
            ),
            ("RUNTIME_API_KEY".to_string(), self.api_key.clone()),
            (
                "RUNTIME_MIGRATIONS_DIR".to_string(),
                migrations_directory.to_string(),
            ),
            ("OPENWA_BASE_URL".to_string(), self.openwa_base_url.clone()),
            ("OPENWA_API_KEY".to_string(), self.openwa_api_key.clone()),
            (
                "OPENWA_RELEASE_TAG".to_string(),
                openwa_release_tag.to_string(),
            ),
            (
                "OPENWA_WEBHOOK_SECRET".to_string(),
                self.openwa_webhook_secret.clone(),
            ),
            (
                "OPENWA_ALLOWED_SESSION_IDS".to_string(),
                self.openwa_allowed_session_ids.clone(),
            ),
            (
                "ALLOW_LIVE_SENDS".to_string(),
                self.allow_live_sends.to_string(),
            ),
            (
                "EVENT_INBOX_BASE_URL".to_string(),
                self.event_inbox.base_url.clone(),
            ),
            (
                "EVENT_INBOX_DEVICE_TOKEN".to_string(),
                self.event_inbox.device_token.clone(),
            ),
            (
                "OPENWA_WEBHOOK_RECONCILIATION_ENABLED".to_string(),
                "true".to_string(),
            ),
            (
                "OPENWA_WEBHOOK_CALLBACK_URL".to_string(),
                self.event_inbox.callback_url.clone(),
            ),
            (
                "EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS".to_string(),
                self.connector.is_some().to_string(),
            ),
        ];
        if let Some(connector) = self.connector.as_ref() {
            environment.extend([
                (
                    "OPENWA_CONNECTOR_ID".to_string(),
                    connector.connector_id.clone(),
                ),
                (
                    "OPENWA_CONNECTOR_PLUGIN_VERSION".to_string(),
                    connector.plugin_version.clone(),
                ),
                (
                    "OPENWA_CONNECTOR_INSTANCE_ID".to_string(),
                    connector.instance_id.clone(),
                ),
                (
                    "OPENWA_CONNECTOR_INGRESS_SECRET".to_string(),
                    connector.ingress_secret.clone(),
                ),
            ]);
        }
        if let Some(freshness_ms) = self.openwa_compatibility_freshness_ms {
            environment.push((
                "OPENWA_COMPATIBILITY_FRESHNESS_MS".to_string(),
                freshness_ms.to_string(),
            ));
        }
        if let Some(probe_interval_ms) = self.openwa_compatibility_probe_interval_ms {
            environment.push((
                "OPENWA_COMPATIBILITY_PROBE_INTERVAL_MS".to_string(),
                probe_interval_ms.to_string(),
            ));
        }
        environment
    }

    pub fn managed_backup_directory(
        &self,
        app_data_directory: &std::path::Path,
    ) -> Option<PathBuf> {
        match &self.database {
            DesktopDatabaseConfig::External { .. } => None,
            DesktopDatabaseConfig::Managed { backup_root, .. } => Some(
                backup_root
                    .clone()
                    .unwrap_or_else(|| app_data_directory.join("backups").join("postgresql")),
            ),
        }
    }

    pub fn backup_identity_override(&self) -> Option<String> {
        match &self.database {
            DesktopDatabaseConfig::External { .. } => None,
            DesktopDatabaseConfig::Managed {
                backup_identity, ..
            } => backup_identity.clone(),
        }
    }
}

fn value(values: &HashMap<String, String>, name: &str) -> Result<String, String> {
    values
        .get(name)
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Managed Runtime developer provisioning has an empty {name}."))
}

fn optional_environment(name: &str) -> Result<Option<String>, String> {
    match std::env::var(name) {
        Ok(value) if value.trim().is_empty() => Err(format!(
            "Managed Runtime developer provisioning has an empty {name}."
        )),
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(format!("Could not read {name}: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DesktopDatabaseConfig, DesktopEventInboxConfig, DesktopOpenWaConnectorConfig,
        DesktopRuntimeConfig,
    };

    fn config(allow_live_sends: bool) -> DesktopRuntimeConfig {
        DesktopRuntimeConfig {
            port: 34_100,
            api_key: "runtime-key-with-at-least-32-characters".to_string(),
            database: DesktopDatabaseConfig::Managed {
                root: None,
                backup_root: None,
                backup_identity: None,
                password: None,
            },
            node_environment: "production".to_string(),
            openwa_base_url: "https://openwa.example.test".to_string(),
            openwa_api_key: "openwa-secret".to_string(),
            openwa_webhook_secret: "webhook-secret-with-at-least-32-characters".to_string(),
            openwa_allowed_session_ids: "00000000-0000-4000-8000-000000000001".to_string(),
            openwa_compatibility_freshness_ms: None,
            openwa_compatibility_probe_interval_ms: None,
            allow_live_sends,
            event_inbox: DesktopEventInboxConfig {
                base_url: "https://events.example.test".to_string(),
                device_token: "device-token-with-at-least-thirty-two-characters".to_string(),
                callback_url: "https://events.example.test/api/v1/webhooks/openwa".to_string(),
            },
            connector: Some(DesktopOpenWaConnectorConfig {
                connector_id: "00000000-0000-4000-8000-000000000002".to_string(),
                plugin_version: "0.1.0".to_string(),
                instance_id: "wa-studio-connector-1".to_string(),
                ingress_secret: "connector-ingress-secret-with-at-least-32-characters".to_string(),
            }),
        }
    }

    #[test]
    fn builds_one_atomic_local_runtime_and_event_inbox_environment() {
        let environment = config(false).runtime_environment(
            "/app/runtime-migrations",
            "postgresql://runtime:secret@127.0.0.1/runtime",
            "0.22.0",
        );

        assert!(
            environment.contains(&("RUNTIME_PROFILE".to_string(), "desktop-managed".to_string()))
        );
        assert!(environment.contains(&(
            "WA_STUDIO_VERSION".to_string(),
            env!("CARGO_PKG_VERSION").to_string()
        )));
        assert!(environment.contains(&(
            "RUNTIME_STORAGE_POLICY_VERSION".to_string(),
            "1".to_string()
        )));
        assert!(environment.contains(&(
            "RUNTIME_MESSAGE_STORAGE_MODE".to_string(),
            "disabled".to_string()
        )));
        assert!(environment.contains(&(
            "RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED".to_string(),
            "true".to_string()
        )));
        assert!(environment.contains(&(
            "RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED".to_string(),
            "true".to_string()
        )));
        assert!(
            environment.contains(&("RUNTIME_INBOX_RETENTION_DAYS".to_string(), "7".to_string()))
        );
        assert!(environment.contains(&(
            "RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS".to_string(),
            "20000".to_string()
        )));
        assert!(environment.contains(&(
            "RUNTIME_WEBHOOK_SPOOL_MAX_BYTES".to_string(),
            "268435456".to_string()
        )));
        assert!(environment.contains(&("RUNTIME_BIND_HOST".to_string(), "127.0.0.1".to_string())));
        assert!(environment.contains(&("QUEUE_BACKEND".to_string(), "postgres".to_string())));
        assert!(environment.contains(&(
            "GATEWAY_TARGETED_RECONCILIATION_ENABLED".to_string(),
            "true".to_string()
        )));
        assert!(environment.contains(&(
            "GATEWAY_SYNC_NOTIFY_WAKEUP_ENABLED".to_string(),
            "true".to_string()
        )));
        assert!(environment.contains(&(
            "EVENT_INBOX_BASE_URL".to_string(),
            "https://events.example.test".to_string()
        )));
        assert!(environment.contains(&(
            "EVENT_INBOX_DEVICE_TOKEN".to_string(),
            "device-token-with-at-least-thirty-two-characters".to_string()
        )));
        assert!(environment.contains(&(
            "OPENWA_WEBHOOK_RECONCILIATION_ENABLED".to_string(),
            "true".to_string()
        )));
        assert!(environment.contains(&(
            "OPENWA_WEBHOOK_CALLBACK_URL".to_string(),
            "https://events.example.test/api/v1/webhooks/openwa".to_string()
        )));
        assert!(environment.contains(&(
            "EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS".to_string(),
            "true".to_string()
        )));
        assert!(environment.contains(&(
            "OPENWA_CONNECTOR_ID".to_string(),
            "00000000-0000-4000-8000-000000000002".to_string()
        )));
        assert!(environment.contains(&(
            "OPENWA_CONNECTOR_PLUGIN_VERSION".to_string(),
            "0.1.0".to_string()
        )));
        assert!(environment.contains(&(
            "OPENWA_CONNECTOR_INSTANCE_ID".to_string(),
            "wa-studio-connector-1".to_string()
        )));
        assert!(environment.contains(&(
            "OPENWA_CONNECTOR_INGRESS_SECRET".to_string(),
            "connector-ingress-secret-with-at-least-32-characters".to_string()
        )));
        assert!(!environment.iter().any(|(name, _)| name == "REDIS_URL"));
        assert!(!environment
            .iter()
            .any(|(name, _)| name.starts_with("WEBHOOK_RELAY_")));
    }

    #[test]
    fn live_sends_require_an_explicit_true_value() {
        let environment = config(true).runtime_environment(
            "/app/runtime-migrations",
            "postgresql://runtime:secret@127.0.0.1/runtime",
            "0.22.0",
        );
        assert!(environment.contains(&("ALLOW_LIVE_SENDS".to_string(), "true".to_string())));
    }

    #[test]
    fn forwards_valid_developer_compatibility_timing_overrides() {
        let mut config = config(false);
        config.openwa_compatibility_freshness_ms = Some(1_500);
        config.openwa_compatibility_probe_interval_ms = Some(10_000);

        let environment = config.runtime_environment(
            "/app/runtime-migrations",
            "postgresql://runtime:secret@127.0.0.1/runtime",
            "0.22.0",
        );

        assert!(environment.contains(&(
            "OPENWA_COMPATIBILITY_FRESHNESS_MS".to_string(),
            "1500".to_string(),
        )));
        assert!(environment.contains(&(
            "OPENWA_COMPATIBILITY_PROBE_INTERVAL_MS".to_string(),
            "10000".to_string(),
        )));
    }
}
