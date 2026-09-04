use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

const LOG_FILE_NAME: &str = "managed-runtime-supervisor.jsonl";
const MAX_LOG_FILE_BYTES: u64 = 1_024 * 1_024;
const MAX_LOG_ARCHIVES: usize = 2;
const MAX_ENTRY_BYTES: usize = 16 * 1_024;
const MAX_DETAIL_DEPTH: usize = 3;
const MAX_DETAIL_FIELDS: usize = 32;
const MAX_DETAIL_ITEMS: usize = 16;
const MAX_DETAIL_STRING_BYTES: usize = 512;

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

struct RotatingLog {
    directory: PathBuf,
    file: Option<File>,
    current_bytes: u64,
    max_file_bytes: u64,
    max_archives: usize,
}

impl RotatingLog {
    fn open(directory: PathBuf, max_file_bytes: u64, max_archives: usize) -> Result<Self, String> {
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not create managed Runtime log directory: {error}"))?;
        make_directory_private(&directory)?;
        let current_path = directory.join(LOG_FILE_NAME);
        let current_bytes = current_path
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut log = Self {
            directory,
            file: None,
            current_bytes,
            max_file_bytes,
            max_archives,
        };
        if current_bytes >= max_file_bytes {
            log.rotate()?;
        } else {
            log.file = Some(open_private_append(&current_path)?);
        }
        Ok(log)
    }

    fn append(&mut self, line: &[u8]) -> Result<(), String> {
        let line_bytes = u64::try_from(line.len())
            .map_err(|_| "Managed Runtime log entry is too large.".to_string())?
            .saturating_add(1);
        if self.current_bytes > 0
            && self.current_bytes.saturating_add(line_bytes) > self.max_file_bytes
        {
            self.rotate()?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| "Managed Runtime log file is unavailable.".to_string())?;
        file.write_all(line)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.flush())
            .map_err(|error| format!("Could not persist managed Runtime log entry: {error}"))?;
        self.current_bytes = self.current_bytes.saturating_add(line_bytes);
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), String> {
        self.file.take();
        for index in (1..=self.max_archives).rev() {
            let source = if index == 1 {
                self.directory.join(LOG_FILE_NAME)
            } else {
                self.archive_path(index - 1)
            };
            let destination = self.archive_path(index);
            if destination.exists() {
                fs::remove_file(&destination).map_err(|error| {
                    format!("Could not remove expired managed Runtime log archive: {error}")
                })?;
            }
            if source.exists() {
                fs::rename(&source, &destination).map_err(|error| {
                    format!("Could not rotate managed Runtime log archive: {error}")
                })?;
                make_file_private(&destination)?;
            }
        }
        let current_path = self.directory.join(LOG_FILE_NAME);
        self.file = Some(open_private_append(&current_path)?);
        self.current_bytes = 0;
        Ok(())
    }

    fn archive_path(&self, index: usize) -> PathBuf {
        self.directory
            .join(format!("managed-runtime-supervisor.{index}.jsonl"))
    }
}

static UNSTRUCTURED_OUTPUT: OnceLock<Mutex<HashMap<String, UnstructuredOutputCounter>>> =
    OnceLock::new();
static PERSISTENT_LOG: OnceLock<Mutex<RotatingLog>> = OnceLock::new();

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    if PERSISTENT_LOG.get().is_some() {
        return Ok(());
    }
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Could not resolve WA Studio log directory: {error}"))?;
    let log = RotatingLog::open(directory, MAX_LOG_FILE_BYTES, MAX_LOG_ARCHIVES)?;
    let _ = PERSISTENT_LOG.set(Mutex::new(log));
    info(
        "managed_runtime.observability_ready",
        json!({
            "maxFileBytes": MAX_LOG_FILE_BYTES,
            "archiveCount": MAX_LOG_ARCHIVES,
        }),
    );
    Ok(())
}

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
    let value = entry(level, event, details);
    let line = encode_bounded_entry(&value);
    eprintln!("{}", String::from_utf8_lossy(&line));
    let Some(log) = PERSISTENT_LOG.get() else {
        return;
    };
    let result = log
        .lock()
        .map_err(|_| "Managed Runtime log lock is poisoned.".to_string())
        .and_then(|mut log| log.append(&line));
    if result.is_err() {
        eprintln!(
            "{}",
            json!({
                "timestampMs": timestamp_millis(),
                "level": "error",
                "service": "wa-studio",
                "component": "managed-runtime-supervisor",
                "event": "managed_runtime.observability_write_failed",
                "details": {},
            })
        );
    }
}

fn entry(level: &str, event: &str, details: Value) -> Value {
    json!({
        "timestampMs": timestamp_millis(),
        "level": level,
        "service": "wa-studio",
        "component": "managed-runtime-supervisor",
        "event": event,
        "details": sanitize_value(details, None, 0),
    })
}

fn encode_bounded_entry(value: &Value) -> Vec<u8> {
    let encoded = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    if encoded.len() <= MAX_ENTRY_BYTES {
        return encoded;
    }
    serde_json::to_vec(&json!({
        "timestampMs": value.get("timestampMs"),
        "level": value.get("level"),
        "service": "wa-studio",
        "component": "managed-runtime-supervisor",
        "event": value.get("event"),
        "details": {
            "entryOmitted": true,
            "originalBytes": encoded.len(),
        },
    }))
    .unwrap_or_else(|_| b"{}".to_vec())
}

fn sanitize_value(value: Value, key: Option<&str>, depth: usize) -> Value {
    if key.is_some_and(is_sensitive_key) {
        return Value::String("[REDACTED]".to_string());
    }
    if key.is_some_and(is_error_text_key) {
        let original_bytes = match &value {
            Value::String(value) => value.len(),
            value => serde_json::to_vec(value)
                .map(|encoded| encoded.len())
                .unwrap_or(0),
        };
        return json!({
            "messageOmitted": true,
            "originalBytes": original_bytes,
        });
    }
    if depth >= MAX_DETAIL_DEPTH {
        return json!({ "nestedValueOmitted": true });
    }
    match value {
        Value::String(value) => Value::String(truncate_utf8(&value, MAX_DETAIL_STRING_BYTES)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .take(MAX_DETAIL_ITEMS)
                .map(|value| sanitize_value(value, None, depth + 1))
                .collect(),
        ),
        Value::Object(values) => {
            let mut sanitized = Map::new();
            let original_fields = values.len();
            for (field, value) in values.into_iter().take(MAX_DETAIL_FIELDS) {
                sanitized.insert(
                    field.clone(),
                    sanitize_value(value, Some(&field), depth + 1),
                );
            }
            if original_fields > MAX_DETAIL_FIELDS {
                sanitized.insert(
                    "fieldsOmitted".to_string(),
                    json!(original_fields - MAX_DETAIL_FIELDS),
                );
            }
            Value::Object(sanitized)
        }
        value => value,
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    normalized.contains("apikey")
        || normalized.contains("authorization")
        || normalized.contains("cookie")
        || normalized.contains("credential")
        || normalized.contains("databaseurl")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("token")
}

fn is_error_text_key(key: &str) -> bool {
    matches!(key.to_ascii_lowercase().as_str(), "error" | "reason")
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_string();
    }
    let mut boundary = maximum_bytes;
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    value[..boundary].to_string()
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn open_private_append(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options
        .open(path)
        .map_err(|error| format!("Could not open managed Runtime log file: {error}"))?;
    make_file_private(path)?;
    Ok(file)
}

fn make_directory_private(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not protect managed Runtime log directory: {error}"))?;
    Ok(())
}

fn make_file_private(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not protect managed Runtime log file: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use serde_json::{json, Value};
    use tempfile::tempdir;

    use super::{entry, RotatingLog, UnstructuredOutputCounter, LOG_FILE_NAME};

    #[test]
    fn creates_canonical_redacted_native_observability_envelope() {
        let value = entry(
            "error",
            "managed_runtime.ready",
            json!({
                "generation": 7,
                "apiKey": "should-not-be-stored",
                "reason": {
                    "message": "postgresql://operator:password@localhost/runtime",
                },
            }),
        );

        assert_eq!(value["service"], "wa-studio");
        assert_eq!(value["component"], "managed-runtime-supervisor");
        assert_eq!(value["event"], "managed_runtime.ready");
        assert_eq!(value["details"]["generation"], 7);
        assert_eq!(value["details"]["apiKey"], "[REDACTED]");
        assert_eq!(value["details"]["reason"]["messageOmitted"], true);
        assert!(!value.to_string().contains("password"));
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

    #[test]
    fn rotates_bounded_private_jsonl_files() {
        let directory = tempdir().expect("temporary log directory");
        let mut log =
            RotatingLog::open(directory.path().to_path_buf(), 96, 2).expect("open rotating log");
        for generation in 1..=6 {
            let line = serde_json::to_vec(&entry(
                "info",
                "managed_runtime.phase_changed",
                json!({ "generation": generation }),
            ))
            .expect("serialize entry");
            log.append(&line).expect("append log entry");
        }

        let files = fs::read_dir(directory.path())
            .expect("list log directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("read log entries");
        assert_eq!(files.len(), 3);
        assert!(directory.path().join(LOG_FILE_NAME).is_file());
        #[cfg(unix)]
        assert_eq!(
            directory
                .path()
                .metadata()
                .expect("directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for file in files {
            let contents = fs::read_to_string(file.path()).expect("read log file");
            assert!(contents
                .lines()
                .all(|line| serde_json::from_str::<Value>(line).is_ok()));
            #[cfg(unix)]
            assert_eq!(
                file.metadata().expect("metadata").permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
