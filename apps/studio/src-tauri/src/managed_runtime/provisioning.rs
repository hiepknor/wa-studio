use std::{collections::HashSet, time::Duration};

use reqwest::{blocking::Client, redirect::Policy};
use ring::digest::{digest, SHA256};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use super::release::{
    OPENWA_CONNECTOR_PLUGIN_ID, OPENWA_CONNECTOR_PLUGIN_URL, OPENWA_CONNECTOR_PLUGIN_VERSION,
    OPENWA_RELEASE_TAG,
};
use super::{
    provisioning_routes::{self, ManagedRuntimeRoute},
    secret_store,
};

const EVENT_INBOX_PROTOCOL_V1: u8 = 1;
const EVENT_INBOX_PROTOCOL_V2: u8 = 2;
const MAX_SECRET_LENGTH: usize = 4_096;
const MAX_SESSION_COUNT: usize = 1_000;

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeProvisioningInput {
    pub openwa_base_url: String,
    pub openwa_api_key: String,
    #[serde(default)]
    pub allow_live_sends: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProvisionedEventInboxSettings {
    pub base_url: String,
    pub device_token: String,
    pub callback_url: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProvisionedOpenWaConnectorSettings {
    pub connector_id: String,
    pub token_generation: u64,
    pub plugin_version: String,
    pub instance_id: String,
    pub ingress_secret: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProvisionedRuntimeSettings {
    pub runtime_api_key: String,
    pub device_id: String,
    pub openwa_base_url: String,
    pub openwa_api_key: String,
    pub openwa_webhook_secret: String,
    pub openwa_allowed_session_ids: Vec<String>,
    pub allow_live_sends: bool,
    pub event_inbox: ProvisionedEventInboxSettings,
    pub connector: Option<ProvisionedOpenWaConnectorSettings>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeProvisioningProfile {
    pub openwa_base_url: String,
    pub openwa_allowed_session_ids: Vec<String>,
    pub allow_live_sends: bool,
    pub event_inbox_base_url: String,
    pub connector_plugin_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenWaHealth {
    #[serde(default)]
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenWaSession {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StudioDiscovery {
    protocol_version: u8,
    event_inbox_url: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DiscoveredEventInbox {
    protocol_version: u8,
    base_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequest<'a> {
    openwa_base_url: &'a str,
    openwa_api_key: &'a str,
    device_id: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingResponse {
    protocol_version: u8,
    event_inbox_base_url: String,
    callback_url: String,
    device_token: String,
    webhook_secret: String,
    session_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedConnectorCredentialRequest<'a> {
    session_ids: &'a [String],
    secret_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparedConnectorCredentialResponse {
    protocol_version: u8,
    connector_id: String,
    token_generation: u64,
    session_ids: Vec<String>,
    outcome: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWaPlugin {
    id: String,
    version: String,
    status: String,
    ingress_capable: bool,
    session_scoped: bool,
    #[serde(default)]
    active_sessions: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWaPluginAction {
    success: bool,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWaPluginHealth {
    healthy: bool,
    message: Option<String>,
}

const CONNECTOR_BINDING_PENDING_HEALTH: &str = "binding is not synchronized";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWaIntegrationInstance {
    plugin_id: String,
    instance_id: String,
    session_scope: Option<String>,
    enabled: bool,
}

pub fn load() -> Result<Option<ProvisionedRuntimeSettings>, String> {
    let Some(credentials) = secret_store::load_managed_runtime_credentials()? else {
        return Ok(None);
    };
    validate_stored_credentials(&credentials)?;
    clear_completed_intent(&credentials)?;
    let allow_live_sends = connector_protected_live_sends(&credentials);
    Ok(Some(ProvisionedRuntimeSettings {
        runtime_api_key: credentials.runtime_api_key,
        device_id: credentials.device_id,
        openwa_base_url: credentials.openwa_base_url,
        openwa_api_key: credentials.openwa_api_key,
        openwa_webhook_secret: credentials.openwa_webhook_secret,
        openwa_allowed_session_ids: credentials.openwa_allowed_session_ids,
        allow_live_sends,
        event_inbox: ProvisionedEventInboxSettings {
            base_url: credentials.event_inbox_base_url,
            device_token: credentials.event_inbox_device_token,
            callback_url: credentials.event_inbox_callback_url,
        },
        connector: credentials
            .connector
            .map(|connector| ProvisionedOpenWaConnectorSettings {
                connector_id: connector.connector_id,
                token_generation: connector.token_generation,
                plugin_version: connector.plugin_version,
                instance_id: connector.ingress_instance_id,
                ingress_secret: connector.ingress_secret,
            }),
    }))
}

fn clear_completed_intent(
    credentials: &secret_store::ManagedRuntimeCredentials,
) -> Result<(), String> {
    let Some(intent) = secret_store::load_managed_runtime_provisioning_intent()? else {
        return Ok(());
    };
    let Some(connector) = credentials.connector.as_ref() else {
        return Ok(());
    };
    if intent.runtime_api_key == credentials.runtime_api_key
        && intent.device_id == credentials.device_id
        && intent.openwa_base_url == credentials.openwa_base_url
        && intent.openwa_api_key == credentials.openwa_api_key
        && intent.allow_live_sends == credentials.allow_live_sends
        && intent.connector_id == connector.connector_id
        && intent.connector_token_generation == connector.token_generation
        && intent.ingress_instance_id == connector.ingress_instance_id
        && intent.ingress_secret == connector.ingress_secret
        && connector_secret(
            &connector.connector_token,
            &connector.connector_id,
            connector.token_generation,
        )? == intent.connector_secret
    {
        secret_store::clear_managed_runtime_provisioning_intent()?;
    }
    Ok(())
}

fn persist_provisioning_route(
    openwa_base_url: &str,
    intent: &secret_store::ManagedRuntimeProvisioningIntent,
) -> Result<ManagedRuntimeRoute, String> {
    let expected = ManagedRuntimeRoute {
        openwa_base_url: openwa_base_url.to_string(),
        event_inbox_base_url: None,
        connector_id: intent.connector_id.clone(),
        token_generation: intent.connector_token_generation,
        session_scope: None,
        ingress_instance_id: intent.ingress_instance_id.clone(),
    };
    provisioning_routes::save_provisioning(expected.clone())?;
    let route = load_provisioning_route()?;
    if route != expected {
        return Err(
            "Managed Runtime provisioning routing metadata changed unexpectedly.".to_string(),
        );
    }
    Ok(route)
}

fn persist_active_route(
    credentials: &secret_store::ManagedRuntimeCredentials,
) -> Result<ManagedRuntimeRoute, String> {
    let connector = credentials
        .connector
        .as_ref()
        .ok_or_else(|| "Managed Runtime connector routing metadata is unavailable.".to_string())?;
    let expected = ManagedRuntimeRoute {
        openwa_base_url: credentials.openwa_base_url.clone(),
        event_inbox_base_url: Some(credentials.event_inbox_base_url.clone()),
        connector_id: connector.connector_id.clone(),
        token_generation: connector.token_generation,
        session_scope: Some(connector.session_id.clone()),
        ingress_instance_id: connector.ingress_instance_id.clone(),
    };
    provisioning_routes::save_active(expected.clone())?;
    let route = provisioning_routes::active()?.ok_or_else(|| {
        "Managed Runtime active routing metadata could not be loaded.".to_string()
    })?;
    validate_complete_route(&route)?;
    if route != expected {
        return Err("Managed Runtime active routing metadata changed unexpectedly.".to_string());
    }
    Ok(route)
}

fn persist_cleanup_route(
    credentials: &secret_store::ManagedRuntimeCredentials,
) -> Result<ManagedRuntimeRoute, String> {
    let connector = credentials.connector.as_ref();
    let expected = ManagedRuntimeRoute {
        openwa_base_url: credentials.openwa_base_url.clone(),
        event_inbox_base_url: Some(credentials.event_inbox_base_url.clone()),
        connector_id: connector
            .map(|connector| connector.connector_id.clone())
            .unwrap_or_else(|| Uuid::nil().to_string()),
        token_generation: connector
            .map(|connector| connector.token_generation)
            .unwrap_or(1),
        session_scope: connector
            .map(|connector| connector.session_id.clone())
            .or_else(|| credentials.openwa_allowed_session_ids.first().cloned()),
        ingress_instance_id: connector
            .map(|connector| connector.ingress_instance_id.clone())
            .unwrap_or_else(|| "legacy-unprovisioned".to_string()),
    };
    provisioning_routes::save_cleanup(expected.clone())?;
    let route = provisioning_routes::cleanup()?.ok_or_else(|| {
        "Managed Runtime cleanup routing metadata could not be loaded.".to_string()
    })?;
    validate_complete_route(&route)?;
    if route != expected {
        return Err("Managed Runtime cleanup routing metadata changed unexpectedly.".to_string());
    }
    Ok(route)
}

fn load_provisioning_route() -> Result<ManagedRuntimeRoute, String> {
    let route = provisioning_routes::provisioning()?.ok_or_else(|| {
        "Managed Runtime provisioning routing metadata could not be loaded.".to_string()
    })?;
    validate_route(&route)?;
    Ok(route)
}

fn validate_route(route: &ManagedRuntimeRoute) -> Result<(), String> {
    if normalize_origin(&route.openwa_base_url, "OpenWA")? != route.openwa_base_url
        || Uuid::parse_str(&route.connector_id).is_err()
        || route.token_generation == 0
        || route.ingress_instance_id.is_empty()
        || route.ingress_instance_id.len() > 256
    {
        return Err("Managed Runtime routing metadata is invalid.".to_string());
    }
    if let Some(event_inbox_base_url) = route.event_inbox_base_url.as_deref() {
        if normalize_origin(event_inbox_base_url, "Event Inbox")? != event_inbox_base_url {
            return Err("Managed Runtime Event Inbox routing metadata is invalid.".to_string());
        }
    }
    if route
        .session_scope
        .as_deref()
        .is_some_and(|scope| Uuid::parse_str(scope).is_err())
    {
        return Err("Managed Runtime session routing metadata is invalid.".to_string());
    }
    Ok(())
}

fn validate_complete_route(route: &ManagedRuntimeRoute) -> Result<(), String> {
    validate_route(route)?;
    if route.event_inbox_base_url.is_none() || route.session_scope.is_none() {
        return Err("Managed Runtime routing metadata is incomplete.".to_string());
    }
    Ok(())
}

pub fn provision(input: ManagedRuntimeProvisioningInput) -> Result<(), String> {
    let normalized = normalize(input)?;
    let intent = prepare_new_or_resume_intent(&normalized)?;
    finish_provisioning(&normalized, intent).map(|_| ())
}

pub fn profile() -> Result<Option<ManagedRuntimeProvisioningProfile>, String> {
    Ok(load()?.map(|settings| profile_from(&settings)))
}

pub fn reconfigure(
    input: ManagedRuntimeProvisioningInput,
) -> Result<ManagedRuntimeProvisioningProfile, String> {
    let current = secret_store::load_managed_runtime_credentials()?.ok_or_else(|| {
        "Managed Runtime has no stored production profile to reconfigure.".to_string()
    })?;
    validate_stored_credentials(&current)?;
    let normalized = normalize(input)?;

    if let Some(mut cleanup) = secret_store::load_managed_runtime_cleanup_intent()? {
        if cleanup.operation != secret_store::ManagedRuntimeCleanupOperation::Replace {
            return Err(
                "A Managed Runtime reset requires recovery before reconfiguration.".to_string(),
            );
        }
        if cleanup.source != current {
            if current.openwa_base_url != normalized.openwa_base_url
                || current.openwa_api_key != normalized.openwa_api_key
            {
                return Err(
                    "The staged Managed Runtime replacement does not match this request."
                        .to_string(),
                );
            }
            execute_cleanup(&mut cleanup, Some(&current))?;
            secret_store::clear_managed_runtime_cleanup_intent()?;
            provisioning_routes::clear_cleanup()?;
            return Ok(profile_from_credentials(&current));
        }
    }

    if can_reconfigure_in_place(&current, &normalized) {
        let route = persist_active_route(&current)?;
        assert_stored_session_access(
            &route,
            &normalized.openwa_api_key,
            &current.openwa_allowed_session_ids,
        )?;
        let mut updated = current;
        updated.openwa_api_key = normalized.openwa_api_key;
        updated.allow_live_sends = normalized.allow_live_sends;
        secret_store::save_managed_runtime_credentials(&updated)?;
        secret_store::clear_managed_runtime_provisioning_intent()?;
        return Ok(profile_from_credentials(&updated));
    }

    let mut cleanup = prepare_cleanup(secret_store::ManagedRuntimeCleanupOperation::Replace)?;
    let intent = prepare_reconfiguration_intent(&normalized, &current)?;
    let replacement = finish_provisioning(&normalized, intent)?;
    execute_cleanup(&mut cleanup, Some(&replacement))?;
    secret_store::clear_managed_runtime_cleanup_intent()?;
    provisioning_routes::clear_cleanup()?;
    Ok(profile_from_credentials(&replacement))
}

fn connector_protected_live_sends(credentials: &secret_store::ManagedRuntimeCredentials) -> bool {
    credentials.allow_live_sends && credentials.connector.is_some()
}

fn can_reconfigure_in_place(
    current: &secret_store::ManagedRuntimeCredentials,
    input: &ManagedRuntimeProvisioningInput,
) -> bool {
    current.connector.is_some() && current.openwa_base_url == input.openwa_base_url
}

pub fn deprovision() -> Result<(), String> {
    let mut intent = prepare_cleanup(secret_store::ManagedRuntimeCleanupOperation::Reset)?;
    execute_cleanup(&mut intent, None)?;
    secret_store::clear_managed_runtime_credentials()?;
    secret_store::clear_managed_runtime_provisioning_intent()?;
    secret_store::clear_managed_runtime_cleanup_intent()?;
    provisioning_routes::clear_cleanup()?;
    provisioning_routes::clear_provisioning()?;
    provisioning_routes::clear_active()
}

pub fn rotate_connector_credential() -> Result<ManagedRuntimeProvisioningProfile, String> {
    let mut current = secret_store::load_managed_runtime_credentials()?.ok_or_else(|| {
        "Managed Runtime has no stored connector credential to rotate.".to_string()
    })?;
    validate_stored_credentials(&current)?;
    let connector = current.connector.as_ref().ok_or_else(|| {
        "Managed Runtime connector credentials are unavailable for rotation.".to_string()
    })?;
    let intent = match secret_store::load_managed_runtime_connector_rotation_intent()? {
        Some(intent) => {
            if intent.connector_id != connector.connector_id
                || !matches!(
                    connector.token_generation,
                    generation if generation == intent.source_generation
                        || generation == intent.target_generation
                )
            {
                return Err(
                    "The prepared connector rotation does not match the active connector."
                        .to_string(),
                );
            }
            intent
        }
        None => {
            let target_generation = connector.token_generation.checked_add(1).ok_or_else(|| {
                "Managed Runtime connector credential generation is exhausted.".to_string()
            })?;
            let intent = secret_store::ManagedRuntimeConnectorRotationIntent {
                schema_version: 1,
                connector_id: connector.connector_id.clone(),
                source_generation: connector.token_generation,
                target_generation,
                connector_secret: secret_store::random_connector_secret()?,
            };
            secret_store::save_managed_runtime_connector_rotation_intent(&intent)?;
            intent
        }
    };
    if connector.token_generation == intent.target_generation {
        persist_active_route(&current)?;
        provisioning_routes::clear_provisioning()?;
        secret_store::clear_managed_runtime_connector_rotation_intent()?;
        return Ok(profile_from_credentials(&current));
    }

    let mut route = persist_active_route(&current)?;
    let paired = PairingResponse {
        protocol_version: EVENT_INBOX_PROTOCOL_V2,
        event_inbox_base_url: current.event_inbox_base_url.clone(),
        callback_url: current.event_inbox_callback_url.clone(),
        device_token: current.event_inbox_device_token.clone(),
        webhook_secret: current.openwa_webhook_secret.clone(),
        session_ids: current.openwa_allowed_session_ids.clone(),
    };
    let prepared = secret_store::ManagedRuntimeProvisioningIntent {
        schema_version: 1,
        runtime_api_key: current.runtime_api_key.clone(),
        device_id: current.device_id.clone(),
        openwa_base_url: current.openwa_base_url.clone(),
        openwa_api_key: current.openwa_api_key.clone(),
        allow_live_sends: current.allow_live_sends,
        connector_id: intent.connector_id.clone(),
        connector_secret: intent.connector_secret.clone(),
        connector_token_generation: intent.target_generation,
        ingress_instance_id: connector.ingress_instance_id.clone(),
        ingress_secret: connector.ingress_secret.clone(),
    };
    route.token_generation = intent.target_generation;
    provisioning_routes::save_provisioning(route.clone())?;
    let expected_route = route;
    let route = load_provisioning_route()?;
    if route != expected_route {
        return Err("Managed Runtime rotation routing metadata changed unexpectedly.".to_string());
    }
    let connector_token = put_prepared_connector_credential(&route, &prepared, &paired)?;
    let config = connector_config(&route, &connector_token)?;
    ensure_connector_plugin(&route, &current.openwa_api_key, &connector_token)?;
    ensure_ingress_instance(&route, &current.openwa_api_key, &prepared, &config)?;
    let updated = current.connector.as_mut().ok_or_else(|| {
        "Managed Runtime connector credentials disappeared during rotation.".to_string()
    })?;
    updated.token_generation = intent.target_generation;
    updated.connector_token = connector_token;
    secret_store::save_managed_runtime_credentials(&current)?;
    provisioning_routes::save_active(route)?;
    provisioning_routes::clear_provisioning()?;
    secret_store::clear_managed_runtime_connector_rotation_intent()?;
    Ok(profile_from_credentials(&current))
}

fn prepare_cleanup(
    operation: secret_store::ManagedRuntimeCleanupOperation,
) -> Result<secret_store::ManagedRuntimeCleanupIntent, String> {
    if let Some(intent) = secret_store::load_managed_runtime_cleanup_intent()? {
        if intent.operation != operation {
            return Err(
                "Another Managed Runtime cleanup operation requires recovery first.".to_string(),
            );
        }
        return Ok(intent);
    }
    let source = secret_store::load_managed_runtime_credentials()?.ok_or_else(|| {
        "Managed Runtime has no stored production profile to disconnect.".to_string()
    })?;
    validate_stored_credentials(&source)?;
    persist_cleanup_route(&source)?;
    let intent = secret_store::ManagedRuntimeCleanupIntent {
        schema_version: 1,
        operation_id: Uuid::new_v4().to_string(),
        operation,
        phase: secret_store::ManagedRuntimeCleanupPhase::Prepared,
        source,
    };
    secret_store::save_managed_runtime_cleanup_intent(&intent)?;
    Ok(intent)
}

fn execute_cleanup(
    intent: &mut secret_store::ManagedRuntimeCleanupIntent,
    replacement: Option<&secret_store::ManagedRuntimeCredentials>,
) -> Result<(), String> {
    let route = persist_cleanup_route(&intent.source)?;
    if intent.phase < secret_store::ManagedRuntimeCleanupPhase::OpenWaCleaned {
        cleanup_openwa_resources(&route, &intent.source, replacement)?;
        intent.phase = secret_store::ManagedRuntimeCleanupPhase::OpenWaCleaned;
        secret_store::save_managed_runtime_cleanup_intent(intent)?;
    }
    if intent.phase < secret_store::ManagedRuntimeCleanupPhase::RemoteCleaned {
        revoke_event_inbox_connector(&route, &intent.source)?;
        intent.phase = secret_store::ManagedRuntimeCleanupPhase::RemoteCleaned;
        secret_store::save_managed_runtime_cleanup_intent(intent)?;
    }
    if intent.phase < secret_store::ManagedRuntimeCleanupPhase::DeviceRevoked {
        revoke_event_inbox_device(&route, &intent.source)?;
        intent.phase = secret_store::ManagedRuntimeCleanupPhase::DeviceRevoked;
        secret_store::save_managed_runtime_cleanup_intent(intent)?;
    }
    Ok(())
}

fn cleanup_openwa_resources(
    route: &ManagedRuntimeRoute,
    credentials: &secret_store::ManagedRuntimeCredentials,
    replacement: Option<&secret_store::ManagedRuntimeCredentials>,
) -> Result<(), String> {
    let Some(connector) = credentials.connector.as_ref() else {
        return Ok(());
    };
    let client = connection_probe_client()?;
    let instance = client
        .delete(format!(
            "{}/api/integration/plugins/{}/instances/{}",
            route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID, route.ingress_instance_id,
        ))
        .header("x-api-key", &credentials.openwa_api_key)
        .send()
        .map_err(|error| format!("Could not remove the OpenWA connector ingress: {error}"))?;
    if !instance.status().is_success() && instance.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "OpenWA could not remove the connector ingress (HTTP {}).",
            instance.status()
        ));
    }

    let preserves_session = replacement.is_some_and(|replacement| {
        replacement.openwa_base_url == credentials.openwa_base_url
            && replacement
                .connector
                .as_ref()
                .is_some_and(|candidate| candidate.session_id == connector.session_id)
    });
    if preserves_session {
        return Ok(());
    }

    let Some(plugin) = get_openwa_plugin(&client, route, &credentials.openwa_api_key)? else {
        return Ok(());
    };
    validate_connector_plugin(&plugin)?;
    let active_sessions = plugin.active_sessions.ok_or_else(|| {
        "OpenWA did not expose the connector session activation state; refusing a destructive cleanup."
            .to_string()
    })?;
    require_success(
        client
            .put(format!(
                "{}/api/plugins/{}/config/{}",
                route.openwa_base_url,
                OPENWA_CONNECTOR_PLUGIN_ID,
                route.session_scope.as_deref().ok_or_else(|| {
                    "Managed Runtime cleanup session routing is unavailable.".to_string()
                })?,
            ))
            .header("x-api-key", &credentials.openwa_api_key)
            .json(&serde_json::json!({ "config": {} }))
            .send(),
        "clear the WA Studio Connector session configuration",
    )?;
    let remaining = active_sessions
        .into_iter()
        .filter(|session_id| session_id != &connector.session_id)
        .collect::<Vec<_>>();
    require_success(
        client
            .put(format!(
                "{}/api/plugins/{}/sessions",
                route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID,
            ))
            .header("x-api-key", &credentials.openwa_api_key)
            .json(&serde_json::json!({ "sessions": &remaining }))
            .send(),
        "remove the managed session from the WA Studio Connector",
    )?;
    if remaining.is_empty() && plugin.status == "enabled" {
        require_success(
            client
                .post(format!(
                    "{}/api/plugins/{}/disable",
                    route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID,
                ))
                .header("x-api-key", &credentials.openwa_api_key)
                .send(),
            "disable the unused WA Studio Connector",
        )?;
    }
    if remaining.is_empty() {
        put_connector_config(
            &client,
            route,
            &credentials.openwa_api_key,
            ConnectorConfigScope::Base,
            &serde_json::json!({
                "eventInboxBaseUrl": "https://retired.invalid",
                "connectorToken": "retired",
                "sessionId": "00000000-0000-0000-0000-000000000000",
                "heartbeatIntervalSeconds": 10,
                "storagePressureThreshold": 0.75,
            }),
            "retired base configuration",
        )?;
    }
    Ok(())
}

fn revoke_event_inbox_connector(
    route: &ManagedRuntimeRoute,
    credentials: &secret_store::ManagedRuntimeCredentials,
) -> Result<(), String> {
    let Some(connector) = credentials.connector.as_ref() else {
        return Ok(());
    };
    let response = connection_probe_client()?
        .post(format!(
            "{}/api/v1/event-inbox/connectors/revoke",
            route.event_inbox_base_url.as_deref().ok_or_else(|| {
                "Managed Runtime Event Inbox cleanup routing is unavailable.".to_string()
            })?,
        ))
        .bearer_auth(&credentials.event_inbox_device_token)
        .json(&serde_json::json!({ "connectorId": connector.connector_id }))
        .send()
        .map_err(|error| format!("Could not revoke the Event Inbox connector: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Event Inbox could not revoke the connector (HTTP {}).",
            response.status()
        ));
    }
    Ok(())
}

fn revoke_event_inbox_device(
    route: &ManagedRuntimeRoute,
    credentials: &secret_store::ManagedRuntimeCredentials,
) -> Result<(), String> {
    let response = connection_probe_client()?
        .post(format!(
            "{}/api/v1/event-inbox/devices/revoke",
            route.event_inbox_base_url.as_deref().ok_or_else(|| {
                "Managed Runtime Event Inbox cleanup routing is unavailable.".to_string()
            })?,
        ))
        .bearer_auth(&credentials.event_inbox_device_token)
        .send()
        .map_err(|error| format!("Could not revoke the Event Inbox device: {error}"))?;
    if !response.status().is_success() && response.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Err(format!(
            "Event Inbox could not revoke the device (HTTP {}).",
            response.status()
        ));
    }
    Ok(())
}

pub fn repair(input: ManagedRuntimeProvisioningInput) -> Result<(), String> {
    let normalized = normalize(input)?;
    if let Some(intent) = secret_store::load_managed_runtime_provisioning_intent()? {
        return finish_provisioning(&normalized, intent).map(|_| ());
    }
    match secret_store::load_managed_runtime_credentials()? {
        Some(current) => {
            finish_provisioning(&normalized, prepare_repair_intent(&normalized, &current)?)
                .map(|_| ())
        }
        None => finish_provisioning(&normalized, prepare_new_intent(&normalized)?).map(|_| ()),
    }
}

fn prepare_repair_intent(
    input: &ManagedRuntimeProvisioningInput,
    current: &secret_store::ManagedRuntimeCredentials,
) -> Result<secret_store::ManagedRuntimeProvisioningIntent, String> {
    if let Some(mut intent) = secret_store::load_managed_runtime_provisioning_intent()? {
        assert_repair_origin(input, current)?;
        if intent.openwa_base_url != input.openwa_base_url {
            return Err(
                "An incomplete repair targets another OpenWA origin. Complete or reset it before changing servers."
                    .to_string(),
            );
        }
        intent.openwa_api_key = input.openwa_api_key.clone();
        intent.allow_live_sends = input.allow_live_sends;
        secret_store::save_managed_runtime_provisioning_intent(&intent)?;
        return Ok(intent);
    }
    let intent = repair_intent_from_credentials(input, current)?;
    secret_store::save_managed_runtime_provisioning_intent(&intent)?;
    Ok(intent)
}

fn repair_intent_from_credentials(
    input: &ManagedRuntimeProvisioningInput,
    current: &secret_store::ManagedRuntimeCredentials,
) -> Result<secret_store::ManagedRuntimeProvisioningIntent, String> {
    assert_repair_origin(input, current)?;
    let (connector_id, connector_secret, token_generation, ingress_instance_id, ingress_secret) =
        match current.connector.as_ref() {
            Some(connector) => (
                connector.connector_id.clone(),
                connector_secret(
                    &connector.connector_token,
                    &connector.connector_id,
                    connector.token_generation,
                )?,
                connector.token_generation,
                connector.ingress_instance_id.clone(),
                connector.ingress_secret.clone(),
            ),
            None => {
                let connector_id = Uuid::new_v4().to_string();
                (
                    connector_id.clone(),
                    secret_store::random_connector_secret()?,
                    1,
                    format!("wa-studio-{connector_id}"),
                    secret_store::random_secret(64),
                )
            }
        };
    Ok(secret_store::ManagedRuntimeProvisioningIntent {
        schema_version: 1,
        runtime_api_key: current.runtime_api_key.clone(),
        device_id: current.device_id.clone(),
        openwa_base_url: input.openwa_base_url.clone(),
        openwa_api_key: input.openwa_api_key.clone(),
        allow_live_sends: input.allow_live_sends,
        connector_id,
        connector_secret,
        connector_token_generation: token_generation,
        ingress_instance_id,
        ingress_secret,
    })
}

fn assert_repair_origin(
    input: &ManagedRuntimeProvisioningInput,
    current: &secret_store::ManagedRuntimeCredentials,
) -> Result<(), String> {
    if current.openwa_base_url == input.openwa_base_url {
        return Ok(());
    }
    Err(
        "A degraded Managed Runtime can only be repaired against its stored OpenWA origin. Reset the connection before changing servers."
            .to_string(),
    )
}

fn normalize(
    input: ManagedRuntimeProvisioningInput,
) -> Result<ManagedRuntimeProvisioningInput, String> {
    Ok(ManagedRuntimeProvisioningInput {
        openwa_base_url: normalize_origin(&input.openwa_base_url, "OpenWA")?,
        openwa_api_key: non_empty_secret("OpenWA API key", input.openwa_api_key, 1)?,
        allow_live_sends: input.allow_live_sends,
    })
}

fn prepare_new_or_resume_intent(
    input: &ManagedRuntimeProvisioningInput,
) -> Result<secret_store::ManagedRuntimeProvisioningIntent, String> {
    match secret_store::load_managed_runtime_provisioning_intent()? {
        Some(mut intent) => {
            if intent.openwa_base_url != input.openwa_base_url {
                return Err(
                    "An incomplete provisioning operation targets another OpenWA origin. Repair or explicitly reset that operation before changing servers."
                        .to_string(),
                );
            }
            intent.openwa_api_key = input.openwa_api_key.clone();
            intent.allow_live_sends = input.allow_live_sends;
            secret_store::save_managed_runtime_provisioning_intent(&intent)?;
            Ok(intent)
        }
        None => prepare_new_intent(input),
    }
}

fn prepare_new_intent(
    input: &ManagedRuntimeProvisioningInput,
) -> Result<secret_store::ManagedRuntimeProvisioningIntent, String> {
    let connector_id = Uuid::new_v4().to_string();
    let intent = secret_store::ManagedRuntimeProvisioningIntent {
        schema_version: 1,
        runtime_api_key: secret_store::random_secret(48),
        device_id: Uuid::new_v4().to_string(),
        openwa_base_url: input.openwa_base_url.clone(),
        openwa_api_key: input.openwa_api_key.clone(),
        allow_live_sends: input.allow_live_sends,
        connector_id: connector_id.clone(),
        connector_secret: secret_store::random_connector_secret()?,
        connector_token_generation: 1,
        ingress_instance_id: format!("wa-studio-{connector_id}"),
        ingress_secret: secret_store::random_secret(64),
    };
    secret_store::save_managed_runtime_provisioning_intent(&intent)?;
    Ok(intent)
}

fn prepare_reconfiguration_intent(
    input: &ManagedRuntimeProvisioningInput,
    current: &secret_store::ManagedRuntimeCredentials,
) -> Result<secret_store::ManagedRuntimeProvisioningIntent, String> {
    if let Some(mut intent) = secret_store::load_managed_runtime_provisioning_intent()? {
        if intent.openwa_base_url != input.openwa_base_url {
            return Err(
                "An incomplete provisioning operation targets another OpenWA origin. Repair or explicitly reset that operation before changing servers."
                    .to_string(),
            );
        }
        intent.openwa_api_key = input.openwa_api_key.clone();
        intent.allow_live_sends = input.allow_live_sends;
        secret_store::save_managed_runtime_provisioning_intent(&intent)?;
        return Ok(intent);
    }
    let connector_id = Uuid::new_v4().to_string();
    let intent = secret_store::ManagedRuntimeProvisioningIntent {
        schema_version: 1,
        runtime_api_key: current.runtime_api_key.clone(),
        device_id: Uuid::new_v4().to_string(),
        openwa_base_url: input.openwa_base_url.clone(),
        openwa_api_key: input.openwa_api_key.clone(),
        allow_live_sends: input.allow_live_sends,
        connector_id: connector_id.clone(),
        connector_secret: secret_store::random_connector_secret()?,
        connector_token_generation: 1,
        ingress_instance_id: format!("wa-studio-{connector_id}"),
        ingress_secret: secret_store::random_secret(64),
    };
    secret_store::save_managed_runtime_provisioning_intent(&intent)?;
    Ok(intent)
}

fn finish_provisioning(
    input: &ManagedRuntimeProvisioningInput,
    intent: secret_store::ManagedRuntimeProvisioningIntent,
) -> Result<secret_store::ManagedRuntimeCredentials, String> {
    if intent.openwa_base_url != input.openwa_base_url {
        return Err(
            "Managed Runtime provisioning intent does not match the requested OpenWA origin."
                .to_string(),
        );
    }
    let mut route = persist_provisioning_route(&input.openwa_base_url, &intent)?;
    preflight_connector_plugin(&route, &input.openwa_api_key)?;
    let discovered = discover_event_inbox(&route)?;
    let mut paired = pair_event_inbox(
        &route,
        &input.openwa_api_key,
        &intent.device_id,
        &discovered,
    )?;
    let session_scope = validate_pairing_route(&paired, &discovered)?;
    route.event_inbox_base_url = Some(discovered.base_url.clone());
    route.session_scope = Some(session_scope);
    provisioning_routes::save_provisioning(route.clone())?;
    let expected_route = route;
    let route = load_provisioning_route()?;
    if route != expected_route {
        return Err("Managed Runtime pairing routing metadata changed unexpectedly.".to_string());
    }
    paired.session_ids = vec![route.session_scope.clone().ok_or_else(|| {
        "Managed Runtime provisioning session routing is unavailable.".to_string()
    })?];
    let paired = validate_pairing_secrets(paired)?;
    let connector_token = put_prepared_connector_credential(&route, &intent, &paired)?;
    let config = connector_config(&route, &connector_token)?;
    ensure_connector_plugin(&route, &input.openwa_api_key, &connector_token)?;
    ensure_ingress_instance(&route, &input.openwa_api_key, &intent, &config)?;
    let session_scope = route.session_scope.clone().ok_or_else(|| {
        "Managed Runtime provisioning session routing is unavailable.".to_string()
    })?;
    let replacement = credentials(
        input,
        intent.runtime_api_key,
        intent.device_id,
        paired,
        &route,
        secret_store::ManagedOpenWaConnectorCredentials {
            connector_id: intent.connector_id,
            token_generation: intent.connector_token_generation,
            connector_token,
            session_id: session_scope,
            plugin_version: OPENWA_CONNECTOR_PLUGIN_VERSION.to_string(),
            ingress_instance_id: intent.ingress_instance_id,
            ingress_secret: intent.ingress_secret,
        },
    )?;
    secret_store::save_managed_runtime_credentials(&replacement)?;
    provisioning_routes::save_active(route)?;
    provisioning_routes::clear_provisioning()?;
    secret_store::clear_managed_runtime_provisioning_intent()?;
    Ok(replacement)
}

fn put_prepared_connector_credential(
    route: &ManagedRuntimeRoute,
    intent: &secret_store::ManagedRuntimeProvisioningIntent,
    paired: &PairingResponse,
) -> Result<String, String> {
    let client = connection_probe_client()?;
    let session_ids = vec![route
        .session_scope
        .clone()
        .ok_or_else(|| "Managed Runtime connector session routing is unavailable.".to_string())?];
    let event_inbox_base_url = route
        .event_inbox_base_url
        .as_deref()
        .ok_or_else(|| "Managed Runtime Event Inbox routing is unavailable.".to_string())?;
    let response = client
        .put(format!(
            "{}/api/v1/event-inbox/connectors/credentials/{}/generations/{}",
            event_inbox_base_url, route.connector_id, route.token_generation,
        ))
        .bearer_auth(&paired.device_token)
        .json(&PreparedConnectorCredentialRequest {
            session_ids: &session_ids,
            secret_sha256: sha256_hex(intent.connector_secret.as_bytes()),
        })
        .send()
        .map_err(|error| {
            format!("Could not provision the Event Inbox connector credential: {error}")
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "Event Inbox connector credential provisioning was rejected with HTTP {}.",
            response.status()
        ));
    }
    let provisioned: PreparedConnectorCredentialResponse = response.json().map_err(|error| {
        format!("Event Inbox returned an invalid connector credential response: {error}")
    })?;
    if provisioned.protocol_version != EVENT_INBOX_PROTOCOL_V1
        || provisioned.connector_id != intent.connector_id
        || provisioned.token_generation != intent.connector_token_generation
        || provisioned.session_ids != session_ids
        || !matches!(
            provisioned.outcome.as_str(),
            "CREATED" | "UNCHANGED" | "ROTATED"
        )
    {
        return Err(
            "Event Inbox connector credential response did not match the prepared intent."
                .to_string(),
        );
    }
    Ok(format!(
        "wac1.{}.{}.{}",
        intent.connector_id, intent.connector_token_generation, intent.connector_secret,
    ))
}

fn ensure_connector_plugin(
    route: &ManagedRuntimeRoute,
    openwa_api_key: &str,
    connector_token: &str,
) -> Result<(), String> {
    let client = connection_probe_client()?;
    let plugin = get_or_install_connector_plugin(&client, route, openwa_api_key)?;
    validate_connector_plugin(&plugin)?;
    assert_exclusive_connector_instance(&client, route, openwa_api_key)?;

    plugin.active_sessions.as_ref().ok_or_else(|| {
        "OpenWA did not expose the connector session activation state; refusing to replace it."
            .to_string()
    })?;
    let session_scope = route
        .session_scope
        .as_deref()
        .ok_or_else(|| "Managed Runtime connector session routing is unavailable.".to_string())?;

    require_success(
        client
            .put(format!(
                "{}/api/plugins/{}/sessions",
                route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID,
            ))
            .header("x-api-key", openwa_api_key)
            .json(&serde_json::json!({ "sessions": [session_scope] }))
            .send(),
        "activate the WA Studio Connector exclusively for its managed session",
    )?;
    let connector_config = connector_config(route, connector_token)?;
    // OpenWA 0.23.3 starts one sandbox worker with the base config; per-session config is injected
    // only while dispatching a hook or ingress delivery. Keep both layers identical so lifecycle
    // initialization and scoped dispatch resolve the same immutable connector identity.
    put_connector_config(
        &client,
        route,
        openwa_api_key,
        ConnectorConfigScope::Base,
        &connector_config,
        "base lifecycle configuration",
    )?;
    put_connector_config(
        &client,
        route,
        openwa_api_key,
        ConnectorConfigScope::Session,
        &connector_config,
        "managed-session configuration",
    )?;
    if plugin.status != "enabled" {
        let enabled = client
            .post(format!(
                "{}/api/plugins/{}/enable",
                route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID,
            ))
            .header("x-api-key", openwa_api_key)
            .send()
            .map_err(|error| format!("Could not enable the WA Studio Connector: {error}"))?;
        if !enabled.status().is_success() {
            return Err(format!(
                "OpenWA could not enable the WA Studio Connector (HTTP {}).",
                enabled.status()
            ));
        }
    }
    let health = client
        .get(format!(
            "{}/api/plugins/{}/health",
            route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID,
        ))
        .header("x-api-key", openwa_api_key)
        .send()
        .map_err(|error| format!("Could not read WA Studio Connector health: {error}"))?;
    if !health.status().is_success() {
        return Err(format!(
            "OpenWA connector health probe returned HTTP {}.",
            health.status()
        ));
    }
    let health: OpenWaPluginHealth = health.json().map_err(|error| {
        format!("OpenWA returned an invalid connector health response: {error}")
    })?;
    // The desired binding is Runtime-owned: it can only be published after the
    // provisioning profile is committed and the local Runtime starts. Accept
    // that one constrained bootstrap state here; Runtime readiness remains
    // fail-closed until reconciliation and connector heartbeats make it healthy.
    let binding_pending =
        !health.healthy && health.message.as_deref() == Some(CONNECTOR_BINDING_PENDING_HEALTH);
    if !health.healthy && !binding_pending {
        return Err(format!(
            "WA Studio Connector is not healthy: {}",
            health
                .message
                .unwrap_or_else(|| "no reason was reported".to_string()),
        ));
    }
    Ok(())
}

fn connector_config(
    route: &ManagedRuntimeRoute,
    connector_token: &str,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "eventInboxBaseUrl": route.event_inbox_base_url.as_deref().ok_or_else(|| {
            "Managed Runtime Event Inbox routing is unavailable.".to_string()
        })?,
        "connectorToken": connector_token,
        "sessionId": route.session_scope.as_deref().ok_or_else(|| {
            "Managed Runtime connector session routing is unavailable.".to_string()
        })?,
        "heartbeatIntervalSeconds": 10,
        "storagePressureThreshold": 0.75,
    }))
}

fn preflight_connector_plugin(
    route: &ManagedRuntimeRoute,
    openwa_api_key: &str,
) -> Result<(), String> {
    let client = connection_probe_client()?;
    assert_compatible_release_with_client(
        &client,
        &route.openwa_base_url,
        openwa_api_key,
        OPENWA_RELEASE_TAG,
    )?;
    let plugin = get_or_install_connector_plugin(&client, route, openwa_api_key)?;
    validate_connector_plugin(&plugin)?;
    assert_exclusive_connector_instance(&client, route, openwa_api_key)
}

fn get_or_install_connector_plugin(
    client: &Client,
    route: &ManagedRuntimeRoute,
    openwa_api_key: &str,
) -> Result<OpenWaPlugin, String> {
    if let Some(plugin) = get_openwa_plugin(client, route, openwa_api_key)? {
        return Ok(plugin);
    }
    let package_url = validated_connector_plugin_url()?.ok_or_else(|| {
        format!(
            "OpenWA connector {} is not installed. Install WA Studio Connector {} before provisioning from a development build.",
            OPENWA_CONNECTOR_PLUGIN_ID, OPENWA_CONNECTOR_PLUGIN_VERSION,
        )
    })?;
    let installed = client
        .post(format!("{}/api/plugins/install-url", route.openwa_base_url))
        .header("x-api-key", openwa_api_key)
        .json(&serde_json::json!({ "url": package_url }))
        .send()
        .map_err(|error| format!("Could not install the WA Studio Connector: {error}"))?;
    if !installed.status().is_success() {
        return Err(format!(
            "OpenWA rejected the WA Studio Connector package with HTTP {}.",
            installed.status()
        ));
    }
    installed
        .json()
        .map_err(|error| format!("OpenWA returned invalid WA Studio Connector metadata: {error}"))
}

fn assert_exclusive_connector_instance(
    client: &Client,
    route: &ManagedRuntimeRoute,
    openwa_api_key: &str,
) -> Result<(), String> {
    let response = client
        .get(format!(
            "{}/api/integration/plugins/{}/instances",
            route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID,
        ))
        .header("x-api-key", openwa_api_key)
        .send()
        .map_err(|error| format!("Could not inspect WA Studio Connector ownership: {error}"))?;
    if !response.status().is_success() {
        return Err(openwa_control_plane_http_error(
            response.status(),
            "connector ownership inspection",
        ));
    }
    let instances: Vec<OpenWaIntegrationInstance> = response.json().map_err(|error| {
        format!("OpenWA returned invalid connector ownership metadata: {error}")
    })?;
    if instances
        .iter()
        .any(|instance| instance.instance_id != route.ingress_instance_id)
    {
        return Err(
            "OpenWA already has a WA Studio Connector ingress owned by another workspace. Disconnect that workspace before provisioning this one."
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ConnectorConfigScope {
    Base,
    Session,
}

fn put_connector_config(
    client: &Client,
    route: &ManagedRuntimeRoute,
    openwa_api_key: &str,
    target: ConnectorConfigScope,
    config: &serde_json::Value,
    scope: &str,
) -> Result<(), String> {
    let url = match target {
        ConnectorConfigScope::Base => format!(
            "{}/api/plugins/{}/config",
            route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID,
        ),
        ConnectorConfigScope::Session => format!(
            "{}/api/plugins/{}/config/{}",
            route.openwa_base_url,
            OPENWA_CONNECTOR_PLUGIN_ID,
            route.session_scope.as_deref().ok_or_else(|| {
                "Managed Runtime connector session routing is unavailable.".to_string()
            })?,
        ),
    };
    let configured = client
        .put(url)
        .header("x-api-key", openwa_api_key)
        .json(&serde_json::json!({ "config": config }))
        .send()
        .map_err(|error| format!("Could not configure the WA Studio Connector {scope}: {error}"))?;
    if !configured.status().is_success() {
        return Err(format!(
            "OpenWA rejected the WA Studio Connector {scope} with HTTP {}.",
            configured.status()
        ));
    }
    let action: OpenWaPluginAction = configured
        .json()
        .map_err(|error| format!("OpenWA returned an invalid connector {scope} result: {error}"))?;
    if !action.success {
        return Err(format!(
            "OpenWA refused the connector {scope}: {}",
            action.message
        ));
    }
    Ok(())
}

fn get_openwa_plugin(
    client: &Client,
    route: &ManagedRuntimeRoute,
    openwa_api_key: &str,
) -> Result<Option<OpenWaPlugin>, String> {
    let response = client
        .get(format!(
            "{}/api/plugins/{}",
            route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID,
        ))
        .header("x-api-key", openwa_api_key)
        .send()
        .map_err(|error| format!("Could not inspect the WA Studio Connector: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(openwa_control_plane_http_error(
            response.status(),
            "connector inspection",
        ));
    }
    response
        .json()
        .map(Some)
        .map_err(|error| format!("OpenWA returned invalid connector metadata: {error}"))
}

fn openwa_control_plane_http_error(status: reqwest::StatusCode, operation: &str) -> String {
    if matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return format!(
            "OpenWA {operation} requires a valid unscoped API key with the ADMIN role."
        );
    }
    format!("OpenWA {operation} returned HTTP {status}.")
}

fn validate_connector_plugin(plugin: &OpenWaPlugin) -> Result<(), String> {
    if plugin.id != OPENWA_CONNECTOR_PLUGIN_ID
        || plugin.version != OPENWA_CONNECTOR_PLUGIN_VERSION
        || !plugin.ingress_capable
        || !plugin.session_scoped
        || plugin.status == "error"
    {
        return Err(format!(
            "OpenWA has an incompatible WA Studio Connector; expected {} {} with session-scoped ingress support.",
            OPENWA_CONNECTOR_PLUGIN_ID, OPENWA_CONNECTOR_PLUGIN_VERSION,
        ));
    }
    Ok(())
}

fn ensure_ingress_instance(
    route: &ManagedRuntimeRoute,
    openwa_api_key: &str,
    intent: &secret_store::ManagedRuntimeProvisioningIntent,
    config: &serde_json::Value,
) -> Result<(), String> {
    let client = connection_probe_client()?;
    let session_scope = route
        .session_scope
        .as_deref()
        .ok_or_else(|| "Managed Runtime connector session routing is unavailable.".to_string())?;
    let collection = format!(
        "{}/api/integration/plugins/{}/instances",
        route.openwa_base_url, OPENWA_CONNECTOR_PLUGIN_ID,
    );
    let created = client
        .post(&collection)
        .header("x-api-key", openwa_api_key)
        .json(&serde_json::json!({
            "instanceId": route.ingress_instance_id,
            "sessionScope": session_scope,
            "secret": intent.ingress_secret,
            "config": config,
        }))
        .send()
        .map_err(|error| format!("Could not create the OpenWA connector ingress: {error}"))?;
    let instance = if created.status().is_success() {
        created.json().map_err(|error| {
            format!("OpenWA returned invalid connector ingress metadata: {error}")
        })?
    } else if created.status() == reqwest::StatusCode::CONFLICT {
        let existing = client
            .get(format!("{collection}/{}", route.ingress_instance_id))
            .header("x-api-key", openwa_api_key)
            .send()
            .map_err(|error| {
                format!("Could not recover the existing connector ingress: {error}")
            })?;
        if !existing.status().is_success() {
            return Err(format!(
                "OpenWA connector ingress recovery returned HTTP {}.",
                existing.status()
            ));
        }
        existing.json().map_err(|error| {
            format!("OpenWA returned invalid existing connector ingress metadata: {error}")
        })?
    } else {
        return Err(format!(
            "OpenWA rejected the connector ingress with HTTP {}.",
            created.status()
        ));
    };
    validate_ingress_instance(&instance, intent, session_scope)?;
    let enabled = client
        .patch(format!("{collection}/{}", route.ingress_instance_id))
        .header("x-api-key", openwa_api_key)
        .json(&serde_json::json!({
            "enabled": true,
            "sessionScope": session_scope,
            "config": config,
        }))
        .send()
        .map_err(|error| format!("Could not enable the OpenWA connector ingress: {error}"))?;
    if !enabled.status().is_success() {
        return Err(format!(
            "OpenWA could not enable the connector ingress (HTTP {}).",
            enabled.status()
        ));
    }
    let enabled: OpenWaIntegrationInstance = enabled
        .json()
        .map_err(|error| format!("OpenWA returned invalid enabled ingress metadata: {error}"))?;
    validate_ingress_instance(&enabled, intent, session_scope)?;
    if !enabled.enabled {
        return Err("OpenWA connector ingress remained disabled after provisioning.".to_string());
    }
    Ok(())
}

fn validate_ingress_instance(
    instance: &OpenWaIntegrationInstance,
    intent: &secret_store::ManagedRuntimeProvisioningIntent,
    session_id: &str,
) -> Result<(), String> {
    if instance.plugin_id != OPENWA_CONNECTOR_PLUGIN_ID
        || instance.instance_id != intent.ingress_instance_id
        || instance.session_scope.as_deref() != Some(session_id)
    {
        return Err(
            "OpenWA connector ingress does not match the prepared provisioning intent.".to_string(),
        );
    }
    Ok(())
}

fn require_success(
    result: Result<reqwest::blocking::Response, reqwest::Error>,
    operation: &str,
) -> Result<(), String> {
    let response = result.map_err(|error| format!("Could not {operation}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "OpenWA could not {operation} (HTTP {}).",
            response.status()
        ));
    }
    Ok(())
}

fn validated_connector_plugin_url() -> Result<Option<String>, String> {
    let Some(value) = OPENWA_CONNECTOR_PLUGIN_URL else {
        return Ok(None);
    };
    let url = Url::parse(value)
        .map_err(|_| "The embedded WA Studio Connector package URL is invalid.".to_string())?;
    let digest = url
        .fragment()
        .and_then(|fragment| fragment.strip_prefix("sha256="));
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || digest.is_none_or(|value| {
            value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit())
        })
    {
        return Err(
            "The embedded WA Studio Connector package URL is not HTTPS and SHA-256 pinned."
                .to_string(),
        );
    }
    Ok(Some(value.to_string()))
}

fn connector_secret(token: &str, connector_id: &str, generation: u64) -> Result<String, String> {
    let expected_prefix = format!("wac1.{connector_id}.{generation}.");
    let Some(secret) = token.strip_prefix(&expected_prefix) else {
        return Err("Stored connector credential identity is invalid.".to_string());
    };
    if secret.len() != 43
        || !secret
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Stored connector credential secret is invalid.".to_string());
    }
    Ok(secret.to_string())
}

fn sha256_hex(value: &[u8]) -> String {
    digest(&SHA256, value)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn normalize_origin(value: &str, name: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 2_048 {
        return Err(format!(
            "{name} base URL must be between 1 and 2048 characters."
        ));
    }
    let url = Url::parse(value).map_err(|_| format!("{name} base URL is invalid."))?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(format!(
            "{name} base URL must be an origin without credentials, path, query, or fragment."
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| format!("{name} base URL must include a host."))?;
    let loopback = matches!(host, "127.0.0.1" | "::1" | "localhost");
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(format!(
            "{name} must use HTTPS unless it runs on this device's loopback interface."
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn non_empty_secret(name: &str, value: String, minimum: usize) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.len() < minimum || value.len() > MAX_SECRET_LENGTH {
        return Err(format!(
            "{name} must contain between {minimum} and {MAX_SECRET_LENGTH} characters."
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{name} cannot contain control characters."));
    }
    Ok(value)
}

fn discover_event_inbox(route: &ManagedRuntimeRoute) -> Result<DiscoveredEventInbox, String> {
    let client = connection_probe_client()?;
    let discovery = client
        .get(format!("{}/.well-known/wa-studio", route.openwa_base_url))
        .send()
        .map_err(|error| format!("Could not discover the WA Event Inbox: {error}"))?;
    if !discovery.status().is_success() {
        return Err(format!(
            "WA Studio discovery returned HTTP {}.",
            discovery.status()
        ));
    }
    let discovery: StudioDiscovery = discovery
        .json()
        .map_err(|error| format!("WA Studio discovery response is invalid: {error}"))?;
    if !supports_event_inbox_protocol(discovery.protocol_version) {
        return Err("WA Studio discovery protocol is incompatible.".to_string());
    }
    Ok(DiscoveredEventInbox {
        protocol_version: discovery.protocol_version,
        base_url: normalize_origin(&discovery.event_inbox_url, "Event Inbox")?,
    })
}

fn pair_event_inbox(
    route: &ManagedRuntimeRoute,
    openwa_api_key: &str,
    device_id: &str,
    discovered: &DiscoveredEventInbox,
) -> Result<PairingResponse, String> {
    Uuid::parse_str(device_id).map_err(|_| "Managed Runtime device ID is invalid.".to_string())?;
    let client = connection_probe_client()?;
    let pairing = client
        .post(format!("{}/api/v1/event-inbox/pair", discovered.base_url))
        .json(&PairingRequest {
            openwa_base_url: &route.openwa_base_url,
            openwa_api_key,
            device_id,
        })
        .send()
        .map_err(|error| format!("Could not pair with the WA Event Inbox: {error}"))?;
    if !pairing.status().is_success() {
        return Err(format!(
            "WA Event Inbox pairing was rejected with HTTP {}.",
            pairing.status()
        ));
    }
    let pairing: PairingResponse = pairing
        .json()
        .map_err(|error| format!("WA Event Inbox pairing response is invalid: {error}"))?;
    Ok(pairing)
}

fn connection_probe_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("Could not initialize the OpenWA connection probe: {error}"))
}

fn assert_compatible_release_with_client(
    client: &Client,
    openwa_base_url: &str,
    openwa_api_key: &str,
    expected_release: &str,
) -> Result<(), String> {
    let health = client
        .get(format!("{openwa_base_url}/api/health"))
        .header("x-api-key", openwa_api_key)
        .send()
        .map_err(|error| format!("Could not reach OpenWA health endpoint: {error}"))?;
    if !health.status().is_success() {
        return Err(format!(
            "OpenWA health probe was rejected with HTTP {}.",
            health.status()
        ));
    }
    let health: OpenWaHealth = health
        .json()
        .map_err(|error| format!("OpenWA returned an invalid health response: {error}"))?;
    let version = health.version.ok_or_else(|| {
        "OpenWA did not disclose its release. Verify that the API key is valid and permitted from this device."
            .to_string()
    })?;
    if version != expected_release {
        return Err(format!(
            "OpenWA release mismatch: expected {expected_release}, received {version}."
        ));
    }
    Ok(())
}

fn assert_stored_session_access(
    route: &ManagedRuntimeRoute,
    openwa_api_key: &str,
    expected_session_ids: &[String],
) -> Result<(), String> {
    let client = connection_probe_client()?;
    assert_compatible_release_with_client(
        &client,
        &route.openwa_base_url,
        openwa_api_key,
        OPENWA_RELEASE_TAG,
    )?;
    let response = client
        .get(format!("{}/api/sessions?limit=1000", route.openwa_base_url))
        .header("x-api-key", openwa_api_key)
        .send()
        .map_err(|error| format!("Could not verify the stored OpenWA session scope: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "OpenWA session scope verification returned HTTP {}.",
            response.status()
        ));
    }
    let sessions: Vec<OpenWaSession> = response
        .json()
        .map_err(|error| format!("OpenWA returned invalid session metadata: {error}"))?;
    let visible = sessions
        .into_iter()
        .map(|session| session.id)
        .collect::<HashSet<_>>();
    if expected_session_ids
        .iter()
        .any(|session_id| !visible.contains(session_id))
    {
        return Err(
            "The stored OpenWA session is no longer available to this API key; use staged reconfiguration."
                .to_string(),
        );
    }
    Ok(())
}

fn validate_pairing_route(
    pairing: &PairingResponse,
    discovered: &DiscoveredEventInbox,
) -> Result<String, String> {
    if !supports_event_inbox_protocol(pairing.protocol_version)
        || pairing.protocol_version != discovered.protocol_version
    {
        return Err("WA Event Inbox protocol is incompatible.".to_string());
    }
    let event_inbox_base_url = normalize_origin(&pairing.event_inbox_base_url, "Event Inbox")?;
    if event_inbox_base_url != discovered.base_url {
        return Err("WA Event Inbox pairing origin does not match discovery.".to_string());
    }
    let expected_callback = format!("{}/api/v1/webhooks/openwa", discovered.base_url);
    if pairing.callback_url != expected_callback {
        return Err("WA Event Inbox returned an unexpected OpenWA callback URL.".to_string());
    }
    if pairing.session_ids.is_empty() || pairing.session_ids.len() > MAX_SESSION_COUNT {
        return Err("WA Event Inbox returned an invalid session scope.".to_string());
    }
    let mut seen = HashSet::new();
    let session_ids = pairing
        .session_ids
        .iter()
        .map(|value| {
            Uuid::parse_str(value.trim())
                .map(|id| id.to_string())
                .map_err(|_| "WA Event Inbox returned an invalid session ID.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect::<Vec<_>>();
    if session_ids.len() != 1 {
        return Err(
            "Connector protocol v1 requires the OpenWA API key to expose exactly one session."
                .to_string(),
        );
    }
    Ok(session_ids[0].clone())
}

fn validate_pairing_secrets(mut pairing: PairingResponse) -> Result<PairingResponse, String> {
    pairing.device_token = non_empty_secret("Event Inbox device token", pairing.device_token, 32)?;
    pairing.webhook_secret = non_empty_secret("OpenWA webhook secret", pairing.webhook_secret, 32)?;
    Ok(pairing)
}

fn supports_event_inbox_protocol(protocol: u8) -> bool {
    matches!(protocol, EVENT_INBOX_PROTOCOL_V1 | EVENT_INBOX_PROTOCOL_V2)
}

fn credentials(
    input: &ManagedRuntimeProvisioningInput,
    runtime_api_key: String,
    device_id: String,
    paired: PairingResponse,
    route: &ManagedRuntimeRoute,
    connector: secret_store::ManagedOpenWaConnectorCredentials,
) -> Result<secret_store::ManagedRuntimeCredentials, String> {
    Ok(secret_store::ManagedRuntimeCredentials {
        schema_version: 3,
        runtime_api_key,
        device_id,
        openwa_base_url: input.openwa_base_url.clone(),
        openwa_api_key: input.openwa_api_key.clone(),
        openwa_webhook_secret: paired.webhook_secret,
        openwa_allowed_session_ids: paired.session_ids,
        event_inbox_base_url: route
            .event_inbox_base_url
            .clone()
            .ok_or_else(|| "Managed Runtime Event Inbox routing is unavailable.".to_string())?,
        event_inbox_device_token: paired.device_token,
        event_inbox_callback_url: paired.callback_url,
        allow_live_sends: input.allow_live_sends,
        connector: Some(connector),
    })
}

fn validate_stored_credentials(
    credentials: &secret_store::ManagedRuntimeCredentials,
) -> Result<(), String> {
    normalize_origin(&credentials.openwa_base_url, "OpenWA")?;
    let event_inbox = normalize_origin(&credentials.event_inbox_base_url, "Event Inbox")?;
    if credentials.event_inbox_callback_url != format!("{event_inbox}/api/v1/webhooks/openwa") {
        return Err("Managed Runtime Event Inbox callback is invalid.".to_string());
    }
    Uuid::parse_str(&credentials.device_id)
        .map_err(|_| "Managed Runtime device ID is invalid.".to_string())?;
    if credentials.openwa_allowed_session_ids.is_empty()
        || credentials.openwa_allowed_session_ids.len() > MAX_SESSION_COUNT
        || credentials
            .openwa_allowed_session_ids
            .iter()
            .any(|id| Uuid::parse_str(id).is_err())
    {
        return Err("Managed Runtime session scope is invalid.".to_string());
    }
    if let Some(connector) = credentials.connector.as_ref() {
        if credentials.openwa_allowed_session_ids.len() != 1
            || connector.session_id != credentials.openwa_allowed_session_ids[0]
            || Uuid::parse_str(&connector.connector_id).is_err()
            || connector.token_generation == 0
            || connector.ingress_instance_id.is_empty()
            || connector.ingress_instance_id.len() > 256
            || connector.ingress_secret.len() < 32
            || connector.plugin_version != OPENWA_CONNECTOR_PLUGIN_VERSION
        {
            return Err("Managed Runtime connector credentials are invalid.".to_string());
        }
        connector_secret(
            &connector.connector_token,
            &connector.connector_id,
            connector.token_generation,
        )?;
    } else if credentials.schema_version == 3 {
        return Err("Managed Runtime connector credentials are missing.".to_string());
    }
    Ok(())
}

fn profile_from(settings: &ProvisionedRuntimeSettings) -> ManagedRuntimeProvisioningProfile {
    ManagedRuntimeProvisioningProfile {
        openwa_base_url: settings.openwa_base_url.clone(),
        openwa_allowed_session_ids: settings.openwa_allowed_session_ids.clone(),
        allow_live_sends: settings.allow_live_sends,
        event_inbox_base_url: settings.event_inbox.base_url.clone(),
        connector_plugin_version: settings
            .connector
            .as_ref()
            .map(|connector| connector.plugin_version.clone()),
    }
}

fn profile_from_credentials(
    credentials: &secret_store::ManagedRuntimeCredentials,
) -> ManagedRuntimeProvisioningProfile {
    ManagedRuntimeProvisioningProfile {
        openwa_base_url: credentials.openwa_base_url.clone(),
        openwa_allowed_session_ids: credentials.openwa_allowed_session_ids.clone(),
        allow_live_sends: credentials.allow_live_sends,
        event_inbox_base_url: credentials.event_inbox_base_url.clone(),
        connector_plugin_version: credentials
            .connector
            .as_ref()
            .map(|connector| connector.plugin_version.clone()),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc::{self, Receiver},
        thread,
    };

    use super::{
        can_reconfigure_in_place, cleanup_openwa_resources, connector_config,
        connector_protected_live_sends, connector_secret, ensure_connector_plugin,
        ensure_ingress_instance, normalize, preflight_connector_plugin,
        put_prepared_connector_credential, repair_intent_from_credentials,
        revoke_event_inbox_connector, revoke_event_inbox_device, sha256_hex,
        supports_event_inbox_protocol, validate_connector_plugin, validate_ingress_instance,
        validate_pairing_route, validate_pairing_secrets, DiscoveredEventInbox,
        ManagedRuntimeProvisioningInput, OpenWaIntegrationInstance, OpenWaPlugin, PairingResponse,
        CONNECTOR_BINDING_PENDING_HEALTH, OPENWA_CONNECTOR_PLUGIN_ID,
        OPENWA_CONNECTOR_PLUGIN_VERSION, OPENWA_RELEASE_TAG,
    };
    use crate::managed_runtime::provisioning_routes::ManagedRuntimeRoute;
    use crate::managed_runtime::secret_store::{
        ManagedOpenWaConnectorCredentials, ManagedRuntimeCredentials,
        ManagedRuntimeProvisioningIntent,
    };

    fn input() -> ManagedRuntimeProvisioningInput {
        ManagedRuntimeProvisioningInput {
            openwa_base_url: "https://openwa.example.test/".to_string(),
            openwa_api_key: "openwa-key".to_string(),
            allow_live_sends: false,
        }
    }

    #[test]
    fn connect_input_contains_only_openwa_credentials_and_send_policy() {
        let normalized = normalize(input()).unwrap();
        assert_eq!(normalized.openwa_base_url, "https://openwa.example.test");
        assert_eq!(normalized.openwa_api_key, "openwa-key");
        assert!(!normalized.allow_live_sends);
    }

    #[test]
    fn legacy_profile_fails_closed_and_requires_staged_connector_migration() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let mut legacy =
            stored_credentials("https://openwa.example.test", session_id, connector_id);
        legacy.schema_version = 2;
        legacy.connector = None;
        legacy.allow_live_sends = true;
        let normalized = ManagedRuntimeProvisioningInput {
            openwa_base_url: legacy.openwa_base_url.clone(),
            openwa_api_key: "rotated-openwa-key".to_string(),
            allow_live_sends: true,
        };

        assert!(!connector_protected_live_sends(&legacy));
        assert!(!can_reconfigure_in_place(&legacy, &normalized));

        legacy.schema_version = 3;
        legacy.connector =
            stored_credentials(&legacy.openwa_base_url, session_id, connector_id).connector;
        assert!(connector_protected_live_sends(&legacy));
        assert!(can_reconfigure_in_place(&legacy, &normalized));
    }

    #[test]
    fn degraded_legacy_profile_stages_a_new_connector_without_changing_local_identity() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let mut legacy =
            stored_credentials("https://openwa.example.test", session_id, connector_id);
        legacy.schema_version = 2;
        legacy.connector = None;
        legacy.allow_live_sends = true;
        let normalized = ManagedRuntimeProvisioningInput {
            openwa_base_url: legacy.openwa_base_url.clone(),
            openwa_api_key: "rotated-openwa-key".to_string(),
            allow_live_sends: false,
        };

        let intent = repair_intent_from_credentials(&normalized, &legacy).unwrap();

        assert_eq!(intent.runtime_api_key, legacy.runtime_api_key);
        assert_eq!(intent.device_id, legacy.device_id);
        assert_eq!(intent.openwa_base_url, legacy.openwa_base_url);
        assert!(!intent.allow_live_sends);
        assert_eq!(intent.connector_token_generation, 1);
        assert!(uuid::Uuid::parse_str(&intent.connector_id).is_ok());
        assert_eq!(
            intent.ingress_instance_id,
            format!("wa-studio-{}", intent.connector_id),
        );
        assert!(!intent.connector_secret.is_empty());
        assert!(!intent.ingress_secret.is_empty());
    }

    #[test]
    fn degraded_connector_profile_reuses_its_remote_identity_for_repair() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let current = stored_credentials("https://openwa.example.test", session_id, connector_id);
        let connector = current.connector.as_ref().unwrap();
        let normalized = ManagedRuntimeProvisioningInput {
            openwa_base_url: current.openwa_base_url.clone(),
            openwa_api_key: "rotated-openwa-key".to_string(),
            allow_live_sends: false,
        };

        let intent = repair_intent_from_credentials(&normalized, &current).unwrap();

        assert_eq!(intent.connector_id, connector.connector_id);
        assert_eq!(
            intent.connector_token_generation,
            connector.token_generation
        );
        assert_eq!(intent.ingress_instance_id, connector.ingress_instance_id);
        assert_eq!(intent.ingress_secret, connector.ingress_secret);
        assert_eq!(
            intent.connector_secret,
            connector_secret(
                &connector.connector_token,
                &connector.connector_id,
                connector.token_generation,
            )
            .unwrap(),
        );
    }

    #[test]
    fn degraded_profile_repair_rejects_an_openwa_origin_change() {
        let current = stored_credentials(
            "https://openwa.example.test",
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000003",
        );
        let moved = ManagedRuntimeProvisioningInput {
            openwa_base_url: "https://other-openwa.example.test".to_string(),
            openwa_api_key: "other-openwa-key".to_string(),
            allow_live_sends: false,
        };

        assert!(repair_intent_from_credentials(&moved, &current).is_err());
    }

    #[test]
    fn rejects_insecure_remote_and_ambiguous_openwa_urls() {
        let mut insecure = input();
        insecure.openwa_base_url = "http://openwa.example.test".to_string();
        assert!(normalize(insecure).is_err());
        let mut path = input();
        path.openwa_base_url = "https://openwa.example.test/api".to_string();
        assert!(normalize(path).is_err());
    }

    #[test]
    fn accepts_only_a_pairing_bound_to_the_discovered_origin_and_callback() {
        assert!(supports_event_inbox_protocol(1));
        assert!(supports_event_inbox_protocol(2));
        assert!(!supports_event_inbox_protocol(3));
        let valid = PairingResponse {
            protocol_version: 2,
            event_inbox_base_url: "https://events.example.test".to_string(),
            callback_url: "https://events.example.test/api/v1/webhooks/openwa".to_string(),
            device_token: "device-token-with-at-least-thirty-two-characters".to_string(),
            webhook_secret: "webhook-secret-with-at-least-thirty-two-characters".to_string(),
            session_ids: vec!["00000000-0000-4000-8000-000000000001".to_string()],
        };
        let discovered = DiscoveredEventInbox {
            protocol_version: 2,
            base_url: "https://events.example.test".to_string(),
        };
        assert!(validate_pairing_route(&valid, &discovered).is_ok());
        assert!(validate_pairing_secrets(valid).is_ok());

        let wrong_origin = PairingResponse {
            protocol_version: 2,
            event_inbox_base_url: "https://attacker.example.test".to_string(),
            callback_url: "https://attacker.example.test/api/v1/webhooks/openwa".to_string(),
            device_token: "device-token-with-at-least-thirty-two-characters".to_string(),
            webhook_secret: "webhook-secret-with-at-least-thirty-two-characters".to_string(),
            session_ids: vec!["00000000-0000-4000-8000-000000000001".to_string()],
        };
        assert!(validate_pairing_route(&wrong_origin, &discovered).is_err());
    }

    #[test]
    fn validates_prepared_connector_identity_without_exposing_secret_material() {
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let secret = "a".repeat(43);
        let token = format!("wac1.{connector_id}.2.{secret}");
        assert_eq!(connector_secret(&token, connector_id, 2).unwrap(), secret);
        assert!(connector_secret(&token, connector_id, 1).is_err());
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    }

    #[test]
    fn requires_the_exact_session_scoped_ingress_connector_release() {
        let plugin = OpenWaPlugin {
            id: OPENWA_CONNECTOR_PLUGIN_ID.to_string(),
            version: OPENWA_CONNECTOR_PLUGIN_VERSION.to_string(),
            status: "enabled".to_string(),
            ingress_capable: true,
            session_scoped: true,
            active_sessions: Some(vec![]),
        };
        assert!(validate_connector_plugin(&plugin).is_ok());
        assert!(validate_connector_plugin(&OpenWaPlugin {
            version: "999.0.0".to_string(),
            ..plugin
        })
        .is_err());

        let session_id = "00000000-0000-4000-8000-000000000001";
        let intent = ManagedRuntimeProvisioningIntent {
            schema_version: 1,
            runtime_api_key: "r".repeat(48),
            device_id: "00000000-0000-4000-8000-000000000002".to_string(),
            openwa_base_url: "https://openwa.example.test".to_string(),
            openwa_api_key: "openwa-key".to_string(),
            allow_live_sends: false,
            connector_id: "00000000-0000-4000-8000-000000000003".to_string(),
            connector_secret: "s".repeat(43),
            connector_token_generation: 1,
            ingress_instance_id: "wa-studio-00000000-0000-4000-8000-000000000003".to_string(),
            ingress_secret: "i".repeat(64),
        };
        assert!(validate_ingress_instance(
            &OpenWaIntegrationInstance {
                plugin_id: OPENWA_CONNECTOR_PLUGIN_ID.to_string(),
                instance_id: intent.ingress_instance_id.clone(),
                session_scope: Some(session_id.to_string()),
                enabled: true,
            },
            &intent,
            session_id,
        )
        .is_ok());
    }

    #[test]
    fn replays_a_prepared_connector_credential_without_sending_the_secret() {
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let session_id = "00000000-0000-4000-8000-000000000001";
        let secret = "z".repeat(43);
        let response = |outcome: &str| {
            format!(
                "{{\"protocolVersion\":1,\"connectorId\":\"{connector_id}\",\"tokenGeneration\":1,\"sessionIds\":[\"{session_id}\"],\"outcome\":\"{outcome}\"}}"
            )
        };
        let (base_url, requests, server) = mock_http_server(vec![
            (200, response("CREATED")),
            (200, response("UNCHANGED")),
        ]);
        let intent = provisioning_intent(&base_url, connector_id, &secret);
        let pairing = pairing(&base_url, session_id);
        let route = route(&base_url, session_id, connector_id);

        let first = put_prepared_connector_credential(&route, &intent, &pairing).unwrap();
        let replay = put_prepared_connector_credential(&route, &intent, &pairing).unwrap();

        assert_eq!(first, replay);
        for _ in 0..2 {
            let request = requests.recv().unwrap();
            assert!(request.starts_with(&format!(
                "PUT /api/v1/event-inbox/connectors/credentials/{connector_id}/generations/1 "
            )));
            assert!(request.contains(&sha256_hex(secret.as_bytes())));
            assert!(!request.contains(&secret));
        }
        server.join().unwrap();
    }

    #[test]
    fn recovers_a_prepared_ingress_after_a_lost_create_response() {
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let session_id = "00000000-0000-4000-8000-000000000001";
        let instance_id = format!("wa-studio-{connector_id}");
        let instance = |enabled: bool| {
            format!(
                "{{\"pluginId\":\"{OPENWA_CONNECTOR_PLUGIN_ID}\",\"instanceId\":\"{instance_id}\",\"sessionScope\":\"{session_id}\",\"enabled\":{enabled}}}"
            )
        };
        let (base_url, requests, server) = mock_http_server(vec![
            (409, "{\"message\":\"already exists\"}".to_string()),
            (200, instance(false)),
            (200, instance(true)),
        ]);
        let intent = provisioning_intent(&base_url, connector_id, &"z".repeat(43));
        let route = route(&base_url, session_id, connector_id);
        let config =
            connector_config(&route, &format!("wac1.{connector_id}.1.{}", "z".repeat(43))).unwrap();

        ensure_ingress_instance(&route, "openwa-key", &intent, &config).unwrap();

        let create = requests.recv().unwrap();
        let recover = requests.recv().unwrap();
        let enable = requests.recv().unwrap();
        assert!(create.starts_with(&format!(
            "POST /api/integration/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/instances "
        )));
        assert!(create.contains(&intent.ingress_secret));
        assert!(create.contains("connectorToken"));
        assert!(recover.starts_with(&format!(
            "GET /api/integration/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/instances/{instance_id} "
        )));
        assert!(enable.starts_with(&format!(
            "PATCH /api/integration/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/instances/{instance_id} "
        )));
        assert!(!enable.contains(&intent.ingress_secret));
        assert!(enable.contains("connectorToken"));
        server.join().unwrap();
    }

    #[test]
    fn configures_the_exclusive_plugin_base_and_session_before_enabling_it() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let other_session_id = "00000000-0000-4000-8000-000000000004";
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let connector_token = format!("wac1.{connector_id}.1.{}", "z".repeat(43));
        let plugin = format!(
            "{{\"id\":\"{OPENWA_CONNECTOR_PLUGIN_ID}\",\"version\":\"{OPENWA_CONNECTOR_PLUGIN_VERSION}\",\"status\":\"installed\",\"ingressCapable\":true,\"sessionScoped\":true,\"activeSessions\":[\"{other_session_id}\"]}}"
        );
        let (base_url, requests, server) = mock_http_server(vec![
            (200, plugin),
            (200, "[]".to_string()),
            (200, "{}".to_string()),
            (
                200,
                "{\"success\":true,\"message\":\"configured\"}".to_string(),
            ),
            (
                200,
                "{\"success\":true,\"message\":\"configured\"}".to_string(),
            ),
            (
                200,
                "{\"success\":true,\"message\":\"enabled\"}".to_string(),
            ),
            (
                200,
                format!("{{\"healthy\":false,\"message\":\"{CONNECTOR_BINDING_PENDING_HEALTH}\"}}"),
            ),
        ]);
        let route = route(&base_url, session_id, connector_id);

        ensure_connector_plugin(&route, "openwa-key", &connector_token).unwrap();

        let captured = (0..7).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[0].starts_with(&format!("GET /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID} ")));
        assert!(captured[1].starts_with(&format!(
            "GET /api/integration/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/instances "
        )));
        assert!(captured[2].starts_with(&format!(
            "PUT /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/sessions "
        )));
        assert!(!captured[2].contains(other_session_id));
        assert!(captured[2].contains(session_id));
        assert!(captured[3].starts_with(&format!(
            "PUT /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/config "
        )));
        assert!(captured[3].contains(&connector_token));
        assert!(captured[4].starts_with(&format!(
            "PUT /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/config/{session_id} "
        )));
        assert!(captured[4].contains(&connector_token));
        assert!(captured[5].starts_with(&format!(
            "POST /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/enable "
        )));
        assert!(captured[6].starts_with(&format!(
            "GET /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/health "
        )));
        server.join().unwrap();
    }

    #[test]
    fn rejects_connector_bootstrap_health_with_any_additional_failure() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let connector_token = format!("wac1.{connector_id}.1.{}", "z".repeat(43));
        let plugin = format!(
            "{{\"id\":\"{OPENWA_CONNECTOR_PLUGIN_ID}\",\"version\":\"{OPENWA_CONNECTOR_PLUGIN_VERSION}\",\"status\":\"enabled\",\"ingressCapable\":true,\"sessionScoped\":true,\"activeSessions\":[\"{session_id}\"]}}"
        );
        let (base_url, _requests, server) = mock_http_server(vec![
            (200, plugin),
            (200, "[]".to_string()),
            (200, "{}".to_string()),
            (200, "{\"success\":true,\"message\":\"configured\"}".to_string()),
            (200, "{\"success\":true,\"message\":\"configured\"}".to_string()),
            (
                200,
                format!(
                    "{{\"healthy\":false,\"message\":\"{CONNECTOR_BINDING_PENDING_HEALTH}; heartbeat is stale\"}}"
                ),
            ),
        ]);
        let route = route(&base_url, session_id, connector_id);

        let error = ensure_connector_plugin(&route, "openwa-key", &connector_token).unwrap_err();

        assert!(error.contains("heartbeat is stale"));
        server.join().unwrap();
    }

    #[test]
    fn preflight_rejects_foreign_connector_ownership_before_pairing() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let plugin = format!(
            "{{\"id\":\"{OPENWA_CONNECTOR_PLUGIN_ID}\",\"version\":\"{OPENWA_CONNECTOR_PLUGIN_VERSION}\",\"status\":\"installed\",\"ingressCapable\":true,\"sessionScoped\":true,\"activeSessions\":[]}}"
        );
        let foreign_instance = format!(
            "[{{\"pluginId\":\"{OPENWA_CONNECTOR_PLUGIN_ID}\",\"instanceId\":\"wa-studio-foreign\",\"sessionScope\":\"{session_id}\",\"enabled\":false}}]"
        );
        let (base_url, requests, server) = mock_http_server(vec![
            (200, format!("{{\"version\":\"{OPENWA_RELEASE_TAG}\"}}")),
            (200, plugin),
            (200, foreign_instance),
        ]);
        let route = route(&base_url, session_id, connector_id);

        let error = preflight_connector_plugin(&route, "openwa-key").unwrap_err();

        assert!(error.contains("owned by another workspace"));
        assert!(requests.recv().unwrap().starts_with("GET /api/health "));
        assert!(requests
            .recv()
            .unwrap()
            .starts_with(&format!("GET /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID} ")));
        assert!(requests.recv().unwrap().starts_with(&format!(
            "GET /api/integration/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/instances "
        )));
        assert!(requests.try_recv().is_err());
        server.join().unwrap();
    }

    #[test]
    fn preflight_reports_an_api_key_that_cannot_disclose_the_release() {
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let (base_url, requests, server) = mock_http_server(vec![(
            200,
            "{\"status\":\"ok\",\"timestamp\":\"2026-08-31T12:00:00.000Z\"}".to_string(),
        )]);
        let route = route(
            &base_url,
            "00000000-0000-4000-8000-000000000001",
            connector_id,
        );

        let error = preflight_connector_plugin(&route, "openwa-key").unwrap_err();

        assert!(error.contains("did not disclose its release"));
        assert!(requests.recv().unwrap().starts_with("GET /api/health "));
        assert!(requests.try_recv().is_err());
        server.join().unwrap();
    }

    #[test]
    fn preflight_reports_missing_openwa_admin_permission() {
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let (base_url, requests, server) = mock_http_server(vec![
            (200, format!("{{\"version\":\"{OPENWA_RELEASE_TAG}\"}}")),
            (403, "{\"message\":\"forbidden\"}".to_string()),
        ]);
        let route = route(
            &base_url,
            "00000000-0000-4000-8000-000000000001",
            connector_id,
        );

        let error = preflight_connector_plugin(&route, "openwa-key").unwrap_err();

        assert!(error.contains("unscoped API key with the ADMIN role"));
        assert!(requests.recv().unwrap().starts_with("GET /api/health "));
        assert!(requests
            .recv()
            .unwrap()
            .starts_with(&format!("GET /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID} ")));
        assert!(requests.try_recv().is_err());
        server.join().unwrap();
    }

    #[test]
    fn refuses_to_overwrite_another_connector_instance_during_reconciliation() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let plugin = format!(
            "{{\"id\":\"{OPENWA_CONNECTOR_PLUGIN_ID}\",\"version\":\"{OPENWA_CONNECTOR_PLUGIN_VERSION}\",\"status\":\"installed\",\"ingressCapable\":true,\"sessionScoped\":true,\"activeSessions\":[]}}"
        );
        let foreign_instance = format!(
            "[{{\"pluginId\":\"{OPENWA_CONNECTOR_PLUGIN_ID}\",\"instanceId\":\"wa-studio-foreign\",\"sessionScope\":\"{session_id}\",\"enabled\":false}}]"
        );
        let (base_url, requests, server) =
            mock_http_server(vec![(200, plugin), (200, foreign_instance)]);
        let route = route(&base_url, session_id, connector_id);

        let error = ensure_connector_plugin(
            &route,
            "openwa-key",
            &format!("wac1.{connector_id}.1.{}", "z".repeat(43)),
        )
        .unwrap_err();

        assert!(error.contains("owned by another workspace"));
        assert!(requests
            .recv()
            .unwrap()
            .starts_with(&format!("GET /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID} ")));
        assert!(requests.recv().unwrap().starts_with(&format!(
            "GET /api/integration/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/instances "
        )));
        assert!(requests.try_recv().is_err());
        server.join().unwrap();
    }

    #[test]
    fn cleans_only_the_managed_session_and_accepts_a_replayed_device_revocation() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let other_session_id = "00000000-0000-4000-8000-000000000004";
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let plugin = format!(
            "{{\"id\":\"{OPENWA_CONNECTOR_PLUGIN_ID}\",\"version\":\"{OPENWA_CONNECTOR_PLUGIN_VERSION}\",\"status\":\"enabled\",\"ingressCapable\":true,\"sessionScoped\":true,\"activeSessions\":[\"{session_id}\",\"{other_session_id}\"]}}"
        );
        let (base_url, requests, server) = mock_http_server(vec![
            (404, "{\"message\":\"not found\"}".to_string()),
            (200, plugin),
            (200, "{}".to_string()),
            (200, "{}".to_string()),
            (200, "{\"revoked\":true}".to_string()),
            (401, "{\"message\":\"already revoked\"}".to_string()),
        ]);
        let credentials = stored_credentials(&base_url, session_id, connector_id);
        let route = route(&base_url, session_id, connector_id);

        cleanup_openwa_resources(&route, &credentials, None).unwrap();
        revoke_event_inbox_connector(&route, &credentials).unwrap();
        revoke_event_inbox_device(&route, &credentials).unwrap();

        let captured = (0..6).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[0].starts_with(&format!(
            "DELETE /api/integration/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/instances/wa-studio-{connector_id} "
        )));
        assert!(captured[2].starts_with(&format!(
            "PUT /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/config/{session_id} "
        )));
        assert!(captured[2].contains("\"config\":{}"));
        assert!(captured[3].starts_with(&format!(
            "PUT /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/sessions "
        )));
        assert!(captured[3].contains(other_session_id));
        assert!(!captured[3].contains(&format!("\"{session_id}\"")));
        assert!(captured[4].starts_with("POST /api/v1/event-inbox/connectors/revoke "));
        assert!(captured[5].starts_with("POST /api/v1/event-inbox/devices/revoke "));
        assert!(captured.iter().all(|request| !request.starts_with(&format!(
            "DELETE /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID} "
        ))));
        server.join().unwrap();
    }

    #[test]
    fn disables_and_retires_base_config_after_removing_the_last_connector() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let connector_id = "00000000-0000-4000-8000-000000000003";
        let plugin = format!(
            "{{\"id\":\"{OPENWA_CONNECTOR_PLUGIN_ID}\",\"version\":\"{OPENWA_CONNECTOR_PLUGIN_VERSION}\",\"status\":\"enabled\",\"ingressCapable\":true,\"sessionScoped\":true,\"activeSessions\":[\"{session_id}\"]}}"
        );
        let (base_url, requests, server) = mock_http_server(vec![
            (200, "{}".to_string()),
            (200, plugin),
            (200, "{}".to_string()),
            (200, "{}".to_string()),
            (200, "{}".to_string()),
            (
                200,
                "{\"success\":true,\"message\":\"retired\"}".to_string(),
            ),
        ]);
        let credentials = stored_credentials(&base_url, session_id, connector_id);
        let route = route(&base_url, session_id, connector_id);

        cleanup_openwa_resources(&route, &credentials, None).unwrap();

        let captured = (0..6).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[2].starts_with(&format!(
            "PUT /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/config/{session_id} "
        )));
        assert!(captured[3].starts_with(&format!(
            "PUT /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/sessions "
        )));
        assert!(captured[3].contains("\"sessions\":[]"));
        assert!(captured[4].starts_with(&format!(
            "POST /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/disable "
        )));
        assert!(captured[5].starts_with(&format!(
            "PUT /api/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/config "
        )));
        assert!(captured[5].contains("https://retired.invalid"));
        assert!(captured[5].contains("\"connectorToken\":\"retired\""));
        assert!(!captured[5].contains(&credentials.connector.unwrap().connector_token));
        server.join().unwrap();
    }

    #[test]
    fn staged_replacement_keeps_shared_session_configuration_active() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let old_connector_id = "00000000-0000-4000-8000-000000000003";
        let new_connector_id = "00000000-0000-4000-8000-000000000005";
        let (base_url, requests, server) = mock_http_server(vec![(200, "{}".to_string())]);
        let source = stored_credentials(&base_url, session_id, old_connector_id);
        let replacement = stored_credentials(&base_url, session_id, new_connector_id);
        let route = route(&base_url, session_id, old_connector_id);

        cleanup_openwa_resources(&route, &source, Some(&replacement)).unwrap();

        let request = requests.recv().unwrap();
        assert!(request.starts_with(&format!(
            "DELETE /api/integration/plugins/{OPENWA_CONNECTOR_PLUGIN_ID}/instances/wa-studio-{old_connector_id} "
        )));
        server.join().unwrap();
    }

    fn provisioning_intent(
        base_url: &str,
        connector_id: &str,
        connector_secret: &str,
    ) -> ManagedRuntimeProvisioningIntent {
        ManagedRuntimeProvisioningIntent {
            schema_version: 1,
            runtime_api_key: "r".repeat(48),
            device_id: "00000000-0000-4000-8000-000000000002".to_string(),
            openwa_base_url: base_url.to_string(),
            openwa_api_key: "openwa-key".to_string(),
            allow_live_sends: false,
            connector_id: connector_id.to_string(),
            connector_secret: connector_secret.to_string(),
            connector_token_generation: 1,
            ingress_instance_id: format!("wa-studio-{connector_id}"),
            ingress_secret: "i".repeat(64),
        }
    }

    fn pairing(base_url: &str, session_id: &str) -> PairingResponse {
        PairingResponse {
            protocol_version: 2,
            event_inbox_base_url: base_url.to_string(),
            callback_url: format!("{base_url}/api/v1/webhooks/openwa"),
            device_token: "device-token-with-at-least-thirty-two-characters".to_string(),
            webhook_secret: "webhook-secret-with-at-least-thirty-two-characters".to_string(),
            session_ids: vec![session_id.to_string()],
        }
    }

    fn route(base_url: &str, session_scope: &str, connector_id: &str) -> ManagedRuntimeRoute {
        ManagedRuntimeRoute {
            openwa_base_url: base_url.to_string(),
            event_inbox_base_url: Some(base_url.to_string()),
            connector_id: connector_id.to_string(),
            token_generation: 1,
            session_scope: Some(session_scope.to_string()),
            ingress_instance_id: format!("wa-studio-{connector_id}"),
        }
    }

    fn stored_credentials(
        base_url: &str,
        session_id: &str,
        connector_id: &str,
    ) -> ManagedRuntimeCredentials {
        ManagedRuntimeCredentials {
            schema_version: 3,
            runtime_api_key: "r".repeat(48),
            device_id: "00000000-0000-4000-8000-000000000002".to_string(),
            openwa_base_url: base_url.to_string(),
            openwa_api_key: "openwa-key".to_string(),
            openwa_webhook_secret: "w".repeat(48),
            openwa_allowed_session_ids: vec![session_id.to_string()],
            event_inbox_base_url: base_url.to_string(),
            event_inbox_device_token: "d".repeat(48),
            event_inbox_callback_url: format!("{base_url}/api/v1/webhooks/openwa"),
            allow_live_sends: true,
            connector: Some(ManagedOpenWaConnectorCredentials {
                connector_id: connector_id.to_string(),
                token_generation: 1,
                connector_token: format!("wac1.{connector_id}.1.{}", "z".repeat(43)),
                session_id: session_id.to_string(),
                plugin_version: OPENWA_CONNECTOR_PLUGIN_VERSION.to_string(),
                ingress_instance_id: format!("wa-studio-{connector_id}"),
                ingress_secret: "i".repeat(64),
            }),
        }
    }

    fn mock_http_server(
        responses: Vec<(u16, String)>,
    ) -> (String, Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http_request(&mut stream);
                sender.send(request).unwrap();
                let reason = if status == 409 { "Conflict" } else { "OK" };
                write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len(),
                )
                .unwrap();
            }
        });
        (format!("http://{address}"), receiver, server)
    }

    fn read_http_request(stream: &mut impl Read) -> String {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        let header_end = loop {
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0, "client closed before sending HTTP headers");
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while bytes.len() < header_end + content_length {
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0, "client closed before sending the HTTP body");
            bytes.extend_from_slice(&chunk[..count]);
        }
        String::from_utf8(bytes).unwrap()
    }
}
