use std::{collections::HashSet, time::Duration};

use reqwest::{blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use super::release::OPENWA_RELEASE_TAG;
use super::secret_store;

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
pub struct ProvisionedRuntimeSettings {
    pub runtime_api_key: String,
    pub device_id: String,
    pub openwa_base_url: String,
    pub openwa_api_key: String,
    pub openwa_webhook_secret: String,
    pub openwa_allowed_session_ids: Vec<String>,
    pub allow_live_sends: bool,
    pub event_inbox: ProvisionedEventInboxSettings,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeProvisioningProfile {
    pub openwa_base_url: String,
    pub openwa_allowed_session_ids: Vec<String>,
    pub allow_live_sends: bool,
    pub event_inbox_base_url: String,
}

#[derive(Debug, Deserialize)]
struct OpenWaHealth {
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StudioDiscovery {
    protocol_version: u8,
    event_inbox_url: String,
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

pub fn load() -> Result<Option<ProvisionedRuntimeSettings>, String> {
    let Some(credentials) = secret_store::load_managed_runtime_credentials()? else {
        return Ok(None);
    };
    validate_stored_credentials(&credentials)?;
    Ok(Some(ProvisionedRuntimeSettings {
        runtime_api_key: credentials.runtime_api_key,
        device_id: credentials.device_id,
        openwa_base_url: credentials.openwa_base_url,
        openwa_api_key: credentials.openwa_api_key,
        openwa_webhook_secret: credentials.openwa_webhook_secret,
        openwa_allowed_session_ids: credentials.openwa_allowed_session_ids,
        allow_live_sends: credentials.allow_live_sends,
        event_inbox: ProvisionedEventInboxSettings {
            base_url: credentials.event_inbox_base_url,
            device_token: credentials.event_inbox_device_token,
            callback_url: credentials.event_inbox_callback_url,
        },
    }))
}

pub fn provision(input: ManagedRuntimeProvisioningInput) -> Result<(), String> {
    let normalized = normalize(input)?;
    let runtime_api_key = secret_store::random_secret(48);
    let device_id = Uuid::new_v4().to_string();
    let paired = probe_and_pair(&normalized, &device_id)?;
    secret_store::save_managed_runtime_credentials(&credentials(
        &normalized,
        runtime_api_key,
        device_id,
        paired,
    ))
}

pub fn profile() -> Result<Option<ManagedRuntimeProvisioningProfile>, String> {
    Ok(load()?.map(|settings| profile_from(&settings)))
}

pub fn reconfigure(
    input: ManagedRuntimeProvisioningInput,
) -> Result<ManagedRuntimeProvisioningProfile, String> {
    let current = load()?.ok_or_else(|| {
        "Managed Runtime has no stored production profile to reconfigure.".to_string()
    })?;
    let normalized = normalize(input)?;
    let paired = probe_and_pair(&normalized, &current.device_id)?;
    let replacement = credentials(
        &normalized,
        current.runtime_api_key,
        current.device_id,
        paired,
    );
    secret_store::save_managed_runtime_credentials(&replacement)?;
    Ok(profile_from_credentials(&replacement))
}

pub fn repair(input: ManagedRuntimeProvisioningInput) -> Result<(), String> {
    match load() {
        Ok(Some(current)) => {
            let normalized = normalize(input)?;
            let paired = probe_and_pair(&normalized, &current.device_id)?;
            secret_store::save_managed_runtime_credentials(&credentials(
                &normalized,
                current.runtime_api_key,
                current.device_id,
                paired,
            ))
        }
        Ok(None) | Err(_) => provision(input),
    }
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

fn probe_and_pair(
    input: &ManagedRuntimeProvisioningInput,
    device_id: &str,
) -> Result<PairingResponse, String> {
    Uuid::parse_str(device_id).map_err(|_| "Managed Runtime device ID is invalid.".to_string())?;
    let client = connection_probe_client()?;
    assert_compatible_release_with_client(
        &client,
        &input.openwa_base_url,
        &input.openwa_api_key,
        OPENWA_RELEASE_TAG,
    )?;

    let discovery = client
        .get(format!("{}/.well-known/wa-studio", input.openwa_base_url))
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
    let discovered_protocol = discovery.protocol_version;
    let event_inbox_base_url = normalize_origin(&discovery.event_inbox_url, "Event Inbox")?;

    let pairing = client
        .post(format!("{event_inbox_base_url}/api/v1/event-inbox/pair"))
        .json(&PairingRequest {
            openwa_base_url: &input.openwa_base_url,
            openwa_api_key: &input.openwa_api_key,
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
    validate_pairing(pairing, &event_inbox_base_url, discovered_protocol)
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
    if health.version != expected_release {
        return Err(format!(
            "OpenWA release mismatch: expected {expected_release}, received {}.",
            health.version
        ));
    }
    Ok(())
}

fn validate_pairing(
    mut pairing: PairingResponse,
    discovered_base_url: &str,
    discovered_protocol: u8,
) -> Result<PairingResponse, String> {
    if !supports_event_inbox_protocol(pairing.protocol_version)
        || pairing.protocol_version != discovered_protocol
    {
        return Err("WA Event Inbox protocol is incompatible.".to_string());
    }
    pairing.event_inbox_base_url = normalize_origin(&pairing.event_inbox_base_url, "Event Inbox")?;
    if pairing.event_inbox_base_url != discovered_base_url {
        return Err("WA Event Inbox pairing origin does not match discovery.".to_string());
    }
    let expected_callback = format!("{discovered_base_url}/api/v1/webhooks/openwa");
    if pairing.callback_url != expected_callback {
        return Err("WA Event Inbox returned an unexpected OpenWA callback URL.".to_string());
    }
    pairing.device_token = non_empty_secret("Event Inbox device token", pairing.device_token, 32)?;
    pairing.webhook_secret = non_empty_secret("OpenWA webhook secret", pairing.webhook_secret, 32)?;
    if pairing.session_ids.is_empty() || pairing.session_ids.len() > MAX_SESSION_COUNT {
        return Err("WA Event Inbox returned an invalid session scope.".to_string());
    }
    let mut seen = HashSet::new();
    pairing.session_ids = pairing
        .session_ids
        .into_iter()
        .map(|value| {
            Uuid::parse_str(value.trim())
                .map(|id| id.to_string())
                .map_err(|_| "WA Event Inbox returned an invalid session ID.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
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
) -> secret_store::ManagedRuntimeCredentials {
    secret_store::ManagedRuntimeCredentials {
        schema_version: 2,
        runtime_api_key,
        device_id,
        openwa_base_url: input.openwa_base_url.clone(),
        openwa_api_key: input.openwa_api_key.clone(),
        openwa_webhook_secret: paired.webhook_secret,
        openwa_allowed_session_ids: paired.session_ids,
        event_inbox_base_url: paired.event_inbox_base_url,
        event_inbox_device_token: paired.device_token,
        event_inbox_callback_url: paired.callback_url,
        allow_live_sends: input.allow_live_sends,
    }
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
    Ok(())
}

fn profile_from(settings: &ProvisionedRuntimeSettings) -> ManagedRuntimeProvisioningProfile {
    ManagedRuntimeProvisioningProfile {
        openwa_base_url: settings.openwa_base_url.clone(),
        openwa_allowed_session_ids: settings.openwa_allowed_session_ids.clone(),
        allow_live_sends: settings.allow_live_sends,
        event_inbox_base_url: settings.event_inbox.base_url.clone(),
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
    }
}

#[cfg(test)]
mod tests {
    use super::{
        normalize, supports_event_inbox_protocol, validate_pairing,
        ManagedRuntimeProvisioningInput, PairingResponse,
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
        assert!(validate_pairing(valid, "https://events.example.test", 2).is_ok());

        let wrong_origin = PairingResponse {
            protocol_version: 2,
            event_inbox_base_url: "https://attacker.example.test".to_string(),
            callback_url: "https://attacker.example.test/api/v1/webhooks/openwa".to_string(),
            device_token: "device-token-with-at-least-thirty-two-characters".to_string(),
            webhook_secret: "webhook-secret-with-at-least-thirty-two-characters".to_string(),
            session_ids: vec!["00000000-0000-4000-8000-000000000001".to_string()],
        };
        assert!(validate_pairing(wrong_origin, "https://events.example.test", 2).is_err());
    }
}
