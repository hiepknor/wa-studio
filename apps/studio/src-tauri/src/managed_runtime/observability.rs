use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

#[derive(Default)]
struct UnstructuredOutputCounter {
    occurrences: u64,
    bytes: usize,
}

impl UnstructuredOutputCounter {
    fn observe(&mut self, byte_length: usize) -> bool {
        self.occurrences = self.occurrences.saturating_add(1);
        self.bytes = self.bytes.saturating_add(byte_length);
        self.occurrences == 1 || self.occurrences.is_multiple_of(100)
    }
}

static UNSTRUCTURED_OUTPUT: OnceLock<Mutex<HashMap<String, UnstructuredOutputCounter>>> =
    OnceLock::new();

pub(crate) fn info(event: &str, details: Value) {
    emit("info", event, details);
}

pub(crate) fn warn(event: &str, details: Value) {
    emit("warn", event, details);
}

pub(crate) fn error(event: &str, details: Value) {
    emit("error", event, details);
}

pub(crate) fn forward_runtime_line(role: &str, stream: &str, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    if serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("service").cloned())
        .as_ref()
        .and_then(Value::as_str)
        == Some("wa-runtime")
    {
        eprintln!("{line}");
        return;
    }
    let counters = UNSTRUCTURED_OUTPUT.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut counters) = counters.lock() else {
        return;
    };
    let counter = counters.entry(format!("{role}:{stream}")).or_default();
    if counter.observe(bytes.len()) {
        info(
            "runtime.unstructured_output_suppressed",
            json!({
                "role": role,
                "stream": stream,
                "occurrenceCount": counter.occurrences,
                "suppressedBytesTotal": counter.bytes,
            }),
        );
    }
}

fn emit(level: &str, event: &str, details: Value) {
    eprintln!("{}", entry(level, event, details));
}

fn entry(level: &str, event: &str, details: Value) -> Value {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    json!({
        "timestampMs": timestamp_ms,
        "level": level,
        "service": "wa-studio",
        "component": "managed-runtime-supervisor",
        "event": event,
        "details": details,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{entry, UnstructuredOutputCounter};

    #[test]
    fn creates_canonical_native_observability_envelope() {
        let value = entry("info", "managed_runtime.ready", json!({ "generation": 7 }));

        assert_eq!(value["service"], "wa-studio");
        assert_eq!(value["component"], "managed-runtime-supervisor");
        assert_eq!(value["event"], "managed_runtime.ready");
        assert_eq!(value["details"]["generation"], 7);
        assert!(value["timestampMs"].as_u64().is_some());
    }

    #[test]
    fn rate_limits_unstructured_child_output_without_storing_content() {
        let mut counter = UnstructuredOutputCounter::default();

        assert!(counter.observe(10));
        for _ in 2..100 {
            assert!(!counter.observe(10));
        }
        assert!(counter.observe(10));
        assert_eq!(counter.occurrences, 100);
        assert_eq!(counter.bytes, 1_000);
    }
}
