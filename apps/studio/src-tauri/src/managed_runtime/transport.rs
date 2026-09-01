use std::{collections::BTreeMap, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{
    blocking::Client,
    header::{HeaderName, HeaderValue},
    redirect::Policy,
    Method, Url,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::ManagedRuntimeState;

const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeRequest {
    method: String,
    path: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
    body_encoding: &'static str,
}

#[tauri::command]
pub async fn request_managed_runtime(
    state: State<'_, ManagedRuntimeState>,
    request: ManagedRuntimeRequest,
) -> Result<ManagedRuntimeResponse, String> {
    let transport = state.runtime_transport()?;
    tauri::async_runtime::spawn_blocking(move || request_inner(transport, request))
        .await
        .map_err(|error| format!("Managed Runtime transport task failed: {error}"))?
}

fn request_inner(
    transport: super::state::RuntimeTransportCredentials,
    request: ManagedRuntimeRequest,
) -> Result<ManagedRuntimeResponse, String> {
    let method = validated_method(&request.method)?;
    let target = validated_target(&transport.base_url, &request.path)?;
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BODY_BYTES)
    {
        return Err("Managed Runtime request body exceeds 2 MiB.".to_string());
    }

    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Could not initialize Managed Runtime transport: {error}"))?;
    let mut outgoing = client
        .request(method, target)
        .header("X-Runtime-Key", transport.api_key);
    for (name, value) in request.headers {
        let normalized = name.to_ascii_lowercase();
        if !matches!(normalized.as_str(), "content-type" | "idempotency-key") {
            continue;
        }
        let name = HeaderName::from_bytes(normalized.as_bytes())
            .map_err(|_| "Managed Runtime request contains an invalid header name.".to_string())?;
        let value = HeaderValue::from_str(&value).map_err(|_| {
            format!("Managed Runtime request contains an invalid {normalized} header.")
        })?;
        outgoing = outgoing.header(name, value);
    }
    if let Some(body) = request.body {
        outgoing = outgoing.body(body);
    }
    let response = outgoing
        .send()
        .map_err(|error| format!("Managed Runtime request failed: {error}"))?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
    {
        return Err("Managed Runtime response exceeds 8 MiB.".to_string());
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .map_err(|error| format!("Could not read Managed Runtime response: {error}"))?;
    if bytes.len() > MAX_RESPONSE_BODY_BYTES {
        return Err("Managed Runtime response exceeds 8 MiB.".to_string());
    }
    let (body, body_encoding) = encode_response_body(&bytes, content_type.as_deref())?;
    let mut headers = BTreeMap::new();
    if let Some(content_type) = content_type {
        headers.insert("content-type".to_string(), content_type);
    }
    Ok(ManagedRuntimeResponse {
        status,
        headers,
        body,
        body_encoding,
    })
}

fn encode_response_body(
    bytes: &[u8],
    content_type: Option<&str>,
) -> Result<(String, &'static str), String> {
    if bytes.is_empty() || content_type.is_some_and(is_text_content_type) {
        return String::from_utf8(bytes.to_vec())
            .map(|body| (body, "utf8"))
            .map_err(|_| "Managed Runtime returned invalid UTF-8 text.".to_string());
    }
    Ok((BASE64.encode(bytes), "base64"))
}

fn is_text_content_type(value: &str) -> bool {
    let mime_type = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    mime_type.starts_with("text/")
        || mime_type == "application/json"
        || mime_type.ends_with("+json")
}

fn validated_method(value: &str) -> Result<Method, String> {
    match value {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        _ => Err(format!("Managed Runtime method {value} is not allowed.")),
    }
}

fn validated_target(base_url: &str, path: &str) -> Result<Url, String> {
    if path.contains('#') || !path.starts_with("/api/v1/") {
        return Err("Managed Runtime request path is outside API v1.".to_string());
    }
    let candidate = Url::parse(&format!("http://runtime.invalid{path}"))
        .map_err(|_| "Managed Runtime request path is invalid.".to_string())?;
    if !candidate.path().starts_with("/api/v1/") {
        return Err("Managed Runtime request path is outside API v1.".to_string());
    }
    let mut target = Url::parse(base_url)
        .map_err(|_| "Managed Runtime native transport URL is invalid.".to_string())?;
    if target.scheme() != "http"
        || !matches!(target.host_str(), Some("127.0.0.1" | "::1"))
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err("Managed Runtime native transport must target loopback HTTP.".to_string());
    }
    target.set_path(candidate.path());
    target.set_query(candidate.query());
    target.set_fragment(None);
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::{encode_response_body, validated_method, validated_target};

    #[test]
    fn restricts_native_transport_to_runtime_api_v1() {
        let target = validated_target(
            "http://127.0.0.1:34100",
            "/api/v1/groups?sessionId=session-1",
        )
        .unwrap();
        assert_eq!(
            target.as_str(),
            "http://127.0.0.1:34100/api/v1/groups?sessionId=session-1"
        );
        assert!(validated_target("http://127.0.0.1:34100", "/api/v1/../../admin").is_err());
        assert!(validated_target("http://127.0.0.1:34100", "/api/v1/%2e%2e/%2e%2e/admin").is_err());
        assert!(validated_target("http://127.0.0.1:34100", "//example.com/api/v1/groups").is_err());
        assert!(validated_target("https://runtime.example.com", "/api/v1/groups").is_err());
        assert!(validated_method("CONNECT").is_err());
    }

    #[test]
    fn preserves_text_and_base64_encodes_binary_responses() {
        let text = encode_response_body(br#"{"ok":true}"#, Some("application/json; charset=utf-8"))
            .unwrap();
        assert_eq!(text, (r#"{"ok":true}"#.to_string(), "utf8"));

        let binary = encode_response_body(&[0xff, 0xd8, 0xff], Some("image/jpeg")).unwrap();
        assert_eq!(binary, ("/9j/".to_string(), "base64"));
    }
}
