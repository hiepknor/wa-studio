use std::{
    thread,
    time::{Duration, Instant},
};

use reqwest::{blocking::Client, redirect::Policy, StatusCode};
use ring::digest::{digest, SHA256};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    model::{
        ManagedRuntimeLifecycleOperation as PublicLifecycleOperation,
        ManagedRuntimeLifecyclePhase as PublicLifecyclePhase, ManagedRuntimeLifecycleStatus,
    },
    provisioning::{ManagedRuntimeProvisioningInput, ProvisionedRuntimeSettings},
    secret_store::{
        self, ManagedRuntimeLifecycleIntent, ManagedRuntimeLifecycleOperation,
        ManagedRuntimeLifecyclePhase,
    },
    state::RuntimeTransportCredentials,
};

const DEFAULT_DRAIN_TIMEOUT: Duration = Duration::from_secs(180);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(500);
const CONNECTOR_PROTOCOL_VERSION: u8 = 1;
const CONNECTOR_JOURNAL_SCHEMA_VERSION: u8 = 1;

pub fn status() -> Result<Option<ManagedRuntimeLifecycleStatus>, String> {
    let Some(intent) = secret_store::load_managed_runtime_lifecycle_intent()? else {
        return Ok(None);
    };
    Ok(Some(ManagedRuntimeLifecycleStatus {
        operation: match intent.operation {
            ManagedRuntimeLifecycleOperation::Reconfigure => PublicLifecycleOperation::Reconfigure,
            ManagedRuntimeLifecycleOperation::Reset => PublicLifecycleOperation::Reset,
            ManagedRuntimeLifecycleOperation::RotateConnectorCredential => {
                PublicLifecycleOperation::RotateConnectorCredential
            }
        },
        phase: match intent.phase {
            ManagedRuntimeLifecyclePhase::Prepared => PublicLifecyclePhase::Prepared,
            ManagedRuntimeLifecyclePhase::WorkspaceBlocked => {
                PublicLifecyclePhase::WorkspaceBlocked
            }
            ManagedRuntimeLifecyclePhase::RuntimeDrained => PublicLifecyclePhase::RuntimeDrained,
            ManagedRuntimeLifecyclePhase::RuntimeStopped => PublicLifecyclePhase::RuntimeStopped,
            ManagedRuntimeLifecyclePhase::RemoteMutated => PublicLifecyclePhase::RemoteMutated,
            ManagedRuntimeLifecyclePhase::RuntimeRestarted => {
                PublicLifecyclePhase::RuntimeRestarted
            }
            ManagedRuntimeLifecyclePhase::Verified => PublicLifecyclePhase::Verified,
            ManagedRuntimeLifecyclePhase::Resumed => PublicLifecyclePhase::Resumed,
        },
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeQuiescence {
    drained: bool,
    processing_message_jobs: u64,
    unsettled_connector_commands: u64,
    active_safety_leases: u64,
    checked_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SafetyScopeResponse {
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorStatusResponse {
    protocol_version: u8,
    generated_at: String,
    sessions: Vec<ConnectorSessionStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorSessionStatus {
    session_id: String,
    binding: Option<ConnectorBindingStatus>,
    connector: Option<ConnectorHeartbeatStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorBindingStatus {
    connector_id: String,
    webhook_id: String,
    generation: u64,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorHeartbeatStatus {
    connector_id: String,
    token_generation: u64,
    plugin_version: String,
    protocol_version: u8,
    journal_schema_version: u8,
    binding_generation: u64,
    pending_count: u64,
    oldest_pending_seconds: Option<u64>,
    storage_utilization: f64,
    blocked_reason: Option<String>,
    observed_at: String,
}

#[derive(Serialize)]
struct WorkspaceControlRequest<'a> {
    action: &'a str,
    reason: Option<&'a str>,
}

pub fn prepare_reconfiguration(
    input: &ManagedRuntimeProvisioningInput,
) -> Result<ManagedRuntimeLifecycleIntent, String> {
    let target_fingerprint = reconfiguration_fingerprint(input);
    if let Some(mut intent) = secret_store::load_managed_runtime_lifecycle_intent()? {
        if intent.operation != ManagedRuntimeLifecycleOperation::Reconfigure {
            return Err(
                "Another Managed Runtime lifecycle operation requires recovery before reconfiguration."
                    .to_string(),
            );
        }
        if intent.phase == ManagedRuntimeLifecyclePhase::Resumed {
            secret_store::clear_managed_runtime_lifecycle_intent()?;
        } else if intent.target_fingerprint == target_fingerprint {
            return Ok(intent);
        } else if reconfiguration_target_may_change(intent.phase) {
            intent.target_fingerprint = target_fingerprint;
            secret_store::save_managed_runtime_lifecycle_intent(&intent)?;
            return Ok(intent);
        } else {
            return Err(
                "The Managed Runtime reconfiguration target cannot change after remote mutation."
                    .to_string(),
            );
        }
    }
    let intent = ManagedRuntimeLifecycleIntent {
        schema_version: 1,
        operation_id: Uuid::new_v4().to_string(),
        operation: ManagedRuntimeLifecycleOperation::Reconfigure,
        phase: ManagedRuntimeLifecyclePhase::Prepared,
        target_fingerprint,
        block_idempotency_key: Uuid::new_v4().to_string(),
        resume_idempotency_key: Uuid::new_v4().to_string(),
        baseline_connector_observed_at: None,
    };
    secret_store::save_managed_runtime_lifecycle_intent(&intent)?;
    Ok(intent)
}

fn reconfiguration_target_may_change(phase: ManagedRuntimeLifecyclePhase) -> bool {
    phase <= ManagedRuntimeLifecyclePhase::RuntimeStopped
}

pub fn prepare_reset() -> Result<ManagedRuntimeLifecycleIntent, String> {
    let target_fingerprint = sha256_hex(b"managed-runtime-reset:v1");
    if let Some(intent) = secret_store::load_managed_runtime_lifecycle_intent()? {
        if intent.operation != ManagedRuntimeLifecycleOperation::Reset
            || intent.target_fingerprint != target_fingerprint
        {
            return Err(
                "Another Managed Runtime lifecycle operation requires recovery before reset."
                    .to_string(),
            );
        }
        if intent.phase == ManagedRuntimeLifecyclePhase::Resumed {
            secret_store::clear_managed_runtime_lifecycle_intent()?;
        } else {
            return Ok(intent);
        }
    }
    let intent = ManagedRuntimeLifecycleIntent {
        schema_version: 1,
        operation_id: Uuid::new_v4().to_string(),
        operation: ManagedRuntimeLifecycleOperation::Reset,
        phase: ManagedRuntimeLifecyclePhase::Prepared,
        target_fingerprint,
        block_idempotency_key: Uuid::new_v4().to_string(),
        resume_idempotency_key: Uuid::new_v4().to_string(),
        baseline_connector_observed_at: None,
    };
    secret_store::save_managed_runtime_lifecycle_intent(&intent)?;
    Ok(intent)
}

pub fn prepare_connector_rotation(
    settings: &ProvisionedRuntimeSettings,
) -> Result<ManagedRuntimeLifecycleIntent, String> {
    let connector = settings.connector.as_ref().ok_or_else(|| {
        "Managed Runtime connector settings are unavailable for rotation.".to_string()
    })?;
    let target_fingerprint = sha256_hex(
        format!(
            "managed-runtime-connector-rotation:v1\0{}\0{}",
            connector.connector_id, connector.token_generation,
        )
        .as_bytes(),
    );
    if let Some(intent) = secret_store::load_managed_runtime_lifecycle_intent()? {
        if intent.operation != ManagedRuntimeLifecycleOperation::RotateConnectorCredential {
            return Err(
                "Another Managed Runtime lifecycle operation requires recovery before credential rotation."
                    .to_string(),
            );
        }
        if intent.phase == ManagedRuntimeLifecyclePhase::Resumed {
            secret_store::clear_managed_runtime_lifecycle_intent()?;
        } else {
            return Ok(intent);
        }
    }
    let intent = ManagedRuntimeLifecycleIntent {
        schema_version: 1,
        operation_id: Uuid::new_v4().to_string(),
        operation: ManagedRuntimeLifecycleOperation::RotateConnectorCredential,
        phase: ManagedRuntimeLifecyclePhase::Prepared,
        target_fingerprint,
        block_idempotency_key: Uuid::new_v4().to_string(),
        resume_idempotency_key: Uuid::new_v4().to_string(),
        baseline_connector_observed_at: None,
    };
    secret_store::save_managed_runtime_lifecycle_intent(&intent)?;
    Ok(intent)
}

pub fn advance(
    intent: &mut ManagedRuntimeLifecycleIntent,
    phase: ManagedRuntimeLifecyclePhase,
) -> Result<(), String> {
    if phase > intent.phase {
        intent.phase = phase;
        secret_store::save_managed_runtime_lifecycle_intent(intent)?;
    }
    Ok(())
}

pub fn complete() -> Result<(), String> {
    secret_store::clear_managed_runtime_lifecycle_intent()
}

pub fn complete_without_resume(intent: &mut ManagedRuntimeLifecycleIntent) -> Result<(), String> {
    advance(intent, ManagedRuntimeLifecyclePhase::Verified)?;
    complete()
}

pub fn recover_completed_reset() -> Result<(), String> {
    let Some(intent) = secret_store::load_managed_runtime_lifecycle_intent()? else {
        return Ok(());
    };
    if intent.operation == ManagedRuntimeLifecycleOperation::Reset
        && secret_store::load_managed_runtime_credentials()?.is_none()
        && secret_store::load_managed_runtime_cleanup_intent()?.is_none()
    {
        secret_store::clear_managed_runtime_lifecycle_intent()?;
    }
    Ok(())
}

pub fn block_and_drain(
    transport: &RuntimeTransportCredentials,
    settings: &ProvisionedRuntimeSettings,
    intent: &mut ManagedRuntimeLifecycleIntent,
    reason: &str,
) -> Result<(), String> {
    let client = lifecycle_client()?;
    mutate_workspace(
        &client,
        transport,
        &intent.block_idempotency_key,
        "BLOCK",
        Some(reason),
    )?;
    advance(intent, ManagedRuntimeLifecyclePhase::WorkspaceBlocked)?;
    intent.baseline_connector_observed_at = wait_for_drain(
        &client,
        transport,
        settings,
        DEFAULT_DRAIN_TIMEOUT,
        DEFAULT_POLL_INTERVAL,
    )?;
    secret_store::save_managed_runtime_lifecycle_intent(intent)?;
    advance(intent, ManagedRuntimeLifecyclePhase::RuntimeDrained)
}

pub fn resume(
    transport: &RuntimeTransportCredentials,
    intent: &mut ManagedRuntimeLifecycleIntent,
) -> Result<(), String> {
    let client = lifecycle_client()?;
    mutate_workspace(
        &client,
        transport,
        &intent.resume_idempotency_key,
        "RESUME",
        None,
    )?;
    advance(intent, ManagedRuntimeLifecyclePhase::Resumed)?;
    complete()
}

pub fn verify_connector(
    settings: &ProvisionedRuntimeSettings,
    intent: &mut ManagedRuntimeLifecycleIntent,
) -> Result<(), String> {
    let Some(expected) = settings.connector.as_ref() else {
        return advance(intent, ManagedRuntimeLifecyclePhase::Verified);
    };
    let client = lifecycle_client()?;
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let status = connector_status(&client, settings)?;
        let session = status
            .sessions
            .iter()
            .find(|candidate| candidate.session_id == connector_session_id(settings));
        let binding = session.and_then(|candidate| candidate.binding.as_ref());
        let heartbeat = session.and_then(|candidate| candidate.connector.as_ref());
        let exact_binding = binding.is_some_and(|binding| {
            binding.connector_id == expected.connector_id
                && heartbeat
                    .is_some_and(|heartbeat| heartbeat.binding_generation == binding.generation)
        });
        let fresh_heartbeat = heartbeat.is_some_and(|heartbeat| {
            intent
                .baseline_connector_observed_at
                .as_deref()
                .is_none_or(|baseline| heartbeat.observed_at != baseline)
        });
        let healthy = exact_binding
            && fresh_heartbeat
            && heartbeat.is_some_and(|heartbeat| {
                heartbeat.connector_id == expected.connector_id
                    && heartbeat.token_generation == expected.token_generation
                    && heartbeat.plugin_version == expected.plugin_version
                    && heartbeat.protocol_version == CONNECTOR_PROTOCOL_VERSION
                    && heartbeat.journal_schema_version == CONNECTOR_JOURNAL_SCHEMA_VERSION
                    && heartbeat.pending_count == 0
                    && heartbeat.blocked_reason.is_none()
            });
        if healthy {
            return advance(intent, ManagedRuntimeLifecyclePhase::Verified);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "WA Studio Connector did not publish a fresh healthy heartbeat for connector {} before the verification deadline.",
                expected.connector_id,
            ));
        }
        thread::sleep(DEFAULT_POLL_INTERVAL);
    }
}

fn mutate_workspace(
    client: &Client,
    transport: &RuntimeTransportCredentials,
    idempotency_key: &str,
    action: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    let response = client
        .post(format!(
            "{}/api/v1/openwa-safety/workspace/control",
            transport.base_url
        ))
        .header("X-Runtime-Key", &transport.api_key)
        .header("Idempotency-Key", idempotency_key)
        .json(&WorkspaceControlRequest { action, reason })
        .send()
        .map_err(|error| format!("Could not {action} Managed Runtime safety: {error}"))?;
    if response.status() != StatusCode::OK {
        return Err(format!(
            "Managed Runtime rejected workspace {action} with HTTP {}.",
            response.status()
        ));
    }
    let state: SafetyScopeResponse = response.json().map_err(|error| {
        format!("Managed Runtime returned invalid workspace safety state: {error}")
    })?;
    if action == "BLOCK" && state.status != "BLOCKED" {
        return Err(
            "Managed Runtime did not preserve the workspace maintenance block.".to_string(),
        );
    }
    Ok(())
}

fn wait_for_drain(
    client: &Client,
    transport: &RuntimeTransportCredentials,
    settings: &ProvisionedRuntimeSettings,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<Option<String>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let runtime = runtime_quiescence(client, transport)?;
        let runtime_diagnostic = format!(
            "jobs={}, commands={}, leases={}, checkedAt={}",
            runtime.processing_message_jobs,
            runtime.unsettled_connector_commands,
            runtime.active_safety_leases,
            runtime.checked_at,
        );
        let (connector_drained, connector_diagnostic, connector_observed_at) = match settings
            .connector
            .as_ref()
        {
            Some(connector) => {
                let status = connector_status(client, settings)?;
                let session = status
                    .sessions
                    .iter()
                    .find(|candidate| candidate.session_id == connector_session_id(settings));
                let binding = session.and_then(|candidate| candidate.binding.as_ref());
                let heartbeat = session.and_then(|candidate| candidate.connector.as_ref());
                let binding_matches = binding.is_some_and(|binding| {
                    binding.connector_id == connector.connector_id
                        && heartbeat.is_some_and(|heartbeat| {
                            heartbeat.binding_generation == binding.generation
                        })
                });
                let drained = binding_matches
                    && heartbeat.is_some_and(|heartbeat| {
                        heartbeat.connector_id == connector.connector_id
                            && heartbeat.token_generation == connector.token_generation
                            && heartbeat.plugin_version == connector.plugin_version
                            && heartbeat.protocol_version == CONNECTOR_PROTOCOL_VERSION
                            && heartbeat.journal_schema_version == CONNECTOR_JOURNAL_SCHEMA_VERSION
                            && heartbeat.pending_count == 0
                    });
                let diagnostic = match (binding, heartbeat) {
                    (Some(binding), Some(heartbeat)) => format!(
                        "connector={}, pending={}, oldestPending={:?}, storage={}, blocked={:?}, binding={}:{}@{}, webhook={}, observedAt={}, generatedAt={}",
                        heartbeat.connector_id,
                        heartbeat.pending_count,
                        heartbeat.oldest_pending_seconds,
                        heartbeat.storage_utilization,
                        heartbeat.blocked_reason,
                        binding.connector_id,
                        binding.generation,
                        binding.updated_at,
                        binding.webhook_id,
                        heartbeat.observed_at,
                        status.generated_at,
                    ),
                    _ => format!(
                        "connector heartbeat or binding unavailable, generatedAt={}",
                        status.generated_at,
                    ),
                };
                (
                    drained,
                    diagnostic,
                    heartbeat.map(|heartbeat| heartbeat.observed_at.clone()),
                )
            }
            None => (true, "connector not configured".to_string(), None),
        };
        if runtime.drained && connector_drained {
            return Ok(connector_observed_at);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Managed Runtime did not drain before the maintenance deadline ({}, {}).",
                runtime_diagnostic, connector_diagnostic,
            ));
        }
        thread::sleep(poll_interval);
    }
}

fn runtime_quiescence(
    client: &Client,
    transport: &RuntimeTransportCredentials,
) -> Result<RuntimeQuiescence, String> {
    let response = client
        .get(format!(
            "{}/api/v1/openwa-safety/workspace/quiescence",
            transport.base_url
        ))
        .header("X-Runtime-Key", &transport.api_key)
        .send()
        .map_err(|error| format!("Could not inspect Managed Runtime quiescence: {error}"))?;
    if response.status() != StatusCode::OK {
        return Err(format!(
            "Managed Runtime quiescence probe returned HTTP {}.",
            response.status()
        ));
    }
    response
        .json()
        .map_err(|error| format!("Managed Runtime returned invalid quiescence state: {error}"))
}

fn connector_status(
    client: &Client,
    settings: &ProvisionedRuntimeSettings,
) -> Result<ConnectorStatusResponse, String> {
    let response = client
        .get(format!(
            "{}/api/v1/event-inbox/connectors/status",
            settings.event_inbox.base_url
        ))
        .bearer_auth(&settings.event_inbox.device_token)
        .send()
        .map_err(|error| format!("Could not inspect connector drain state: {error}"))?;
    if response.status() != StatusCode::OK {
        return Err(format!(
            "Event Inbox connector status returned HTTP {}.",
            response.status()
        ));
    }
    let status: ConnectorStatusResponse = response
        .json()
        .map_err(|error| format!("Event Inbox returned invalid connector status: {error}"))?;
    if !connector_status_protocol_supported(status.protocol_version) {
        return Err("Event Inbox returned an unsupported connector status protocol.".to_string());
    }
    Ok(status)
}

fn connector_status_protocol_supported(protocol_version: u8) -> bool {
    protocol_version == CONNECTOR_PROTOCOL_VERSION
}

fn connector_session_id(settings: &ProvisionedRuntimeSettings) -> &str {
    settings
        .openwa_allowed_session_ids
        .first()
        .map(String::as_str)
        .unwrap_or_default()
}

fn lifecycle_client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| {
            format!("Could not initialize Managed Runtime lifecycle transport: {error}")
        })
}

fn reconfiguration_fingerprint(input: &ManagedRuntimeProvisioningInput) -> String {
    let canonical = format!(
        "v1\0{}\0{}\0{}",
        input.openwa_base_url.trim(),
        input.openwa_api_key,
        input.allow_live_sends,
    );
    sha256_hex(canonical.as_bytes())
}

fn sha256_hex(value: &[u8]) -> String {
    digest(&SHA256, value)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        connector_status_protocol_supported, reconfiguration_fingerprint,
        reconfiguration_target_may_change,
    };
    use crate::managed_runtime::{
        provisioning::ManagedRuntimeProvisioningInput, secret_store::ManagedRuntimeLifecyclePhase,
    };

    #[test]
    fn reconfiguration_fingerprint_covers_credentials_and_live_policy() {
        let base = ManagedRuntimeProvisioningInput {
            openwa_base_url: "https://openwa.example.test".to_string(),
            openwa_api_key: "a".repeat(32),
            allow_live_sends: false,
        };
        assert_eq!(reconfiguration_fingerprint(&base).len(), 64);
        assert_ne!(
            reconfiguration_fingerprint(&base),
            reconfiguration_fingerprint(&ManagedRuntimeProvisioningInput {
                allow_live_sends: true,
                ..base.clone()
            }),
        );
        assert_ne!(
            reconfiguration_fingerprint(&base),
            reconfiguration_fingerprint(&ManagedRuntimeProvisioningInput {
                openwa_api_key: "b".repeat(32),
                ..base
            }),
        );
    }

    #[test]
    fn connector_status_uses_the_connector_protocol_version() {
        assert!(connector_status_protocol_supported(1));
        assert!(!connector_status_protocol_supported(2));
    }

    #[test]
    fn reconfiguration_target_is_mutable_only_before_remote_mutation() {
        assert!(reconfiguration_target_may_change(
            ManagedRuntimeLifecyclePhase::Prepared,
        ));
        assert!(reconfiguration_target_may_change(
            ManagedRuntimeLifecyclePhase::RuntimeStopped,
        ));
        assert!(!reconfiguration_target_may_change(
            ManagedRuntimeLifecyclePhase::RemoteMutated,
        ));
        assert!(!reconfiguration_target_may_change(
            ManagedRuntimeLifecyclePhase::Resumed,
        ));
    }
}
