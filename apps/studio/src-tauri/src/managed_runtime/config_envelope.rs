use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    rand::{SecureRandom, SystemRandom},
};
use serde::Serialize;
use uuid::Uuid;

const ENVELOPE_AAD: &[u8] = b"wa-runtime-config-envelope:v1";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const PASSTHROUGH_ENVIRONMENT: &[&str] = &[
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigEnvelope {
    version: u8,
    algorithm: &'static str,
    nonce_hex: String,
    ciphertext_hex: String,
}

pub struct PreparedConfigEnvelope {
    path: PathBuf,
    key: [u8; KEY_BYTES],
}

impl PreparedConfigEnvelope {
    pub fn process_environment(&self) -> Vec<(String, String)> {
        let mut environment = PASSTHROUGH_ENVIRONMENT
            .iter()
            .filter_map(|name| {
                std::env::var(name)
                    .ok()
                    .map(|value| ((*name).to_string(), value))
            })
            .collect::<Vec<_>>();
        environment.push((
            "RUNTIME_CONFIG_ENVELOPE_PATH".to_string(),
            self.path.to_string_lossy().into_owned(),
        ));
        environment
    }

    pub fn key_line(&self) -> String {
        format!("{}\n", encode_hex(&self.key))
    }

    pub fn remove(&self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn prepare(
    working_directory: &Path,
    environment: &[(String, String)],
) -> Result<PreparedConfigEnvelope, String> {
    let plaintext = serde_json::to_vec(
        &environment
            .iter()
            .cloned()
            .collect::<BTreeMap<String, String>>(),
    )
    .map_err(|error| format!("Could not encode Runtime configuration envelope: {error}"))?;
    let random = SystemRandom::new();
    let mut key = [0_u8; KEY_BYTES];
    let mut nonce = [0_u8; NONCE_BYTES];
    random
        .fill(&mut key)
        .and_then(|_| random.fill(&mut nonce))
        .map_err(|_| "Could not generate Runtime configuration envelope key.".to_string())?;
    let sealing_key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, &key)
            .map_err(|_| "Could not initialize Runtime configuration encryption.".to_string())?,
    );
    let mut ciphertext = plaintext;
    sealing_key
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(ENVELOPE_AAD),
            &mut ciphertext,
        )
        .map_err(|_| "Could not encrypt Runtime configuration envelope.".to_string())?;
    let envelope = serde_json::to_vec(&ConfigEnvelope {
        version: 1,
        algorithm: "aes-256-gcm",
        nonce_hex: encode_hex(&nonce),
        ciphertext_hex: encode_hex(&ciphertext),
    })
    .map_err(|error| format!("Could not encode Runtime configuration envelope: {error}"))?;
    let path = working_directory.join(format!(
        ".runtime-config-{}-{}.envelope",
        std::process::id(),
        Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&path).map_err(|error| {
        format!("Could not create encrypted Runtime configuration envelope: {error}")
    })?;
    if let Err(error) = file.write_all(&envelope).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&path);
        return Err(format!(
            "Could not persist encrypted Runtime configuration envelope: {error}"
        ));
    }
    Ok(PreparedConfigEnvelope { path, key })
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::prepare;

    #[test]
    fn writes_only_ciphertext_and_keeps_the_key_off_environment() {
        let directory = tempdir().unwrap();
        let prepared = prepare(
            directory.path(),
            &[(
                "RUNTIME_API_KEY".to_string(),
                "highly-sensitive-value".to_string(),
            )],
        )
        .unwrap();
        let envelope = fs::read_to_string(&prepared.path).unwrap();
        let environment = prepared.process_environment();

        assert!(!envelope.contains("highly-sensitive-value"));
        assert!(!environment
            .iter()
            .any(|(_, value)| value.contains("highly-sensitive-value")));
        assert!(!environment
            .iter()
            .any(|(_, value)| value == prepared.key_line().trim()));
        assert_eq!(prepared.key_line().trim().len(), 64);
        prepared.remove();
        assert!(!prepared.path.exists());
    }
}
