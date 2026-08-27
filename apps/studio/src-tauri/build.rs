use std::{env, fs, path::PathBuf};

fn main() {
    let components_path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../../release/components.json");
    println!("cargo:rerun-if-changed={}", components_path.display());
    let components: serde_json::Value = serde_json::from_slice(
        &fs::read(&components_path).expect("could not read release/components.json"),
    )
    .expect("release/components.json is not valid JSON");
    for (field, environment_name) in [
        ("openwaReleaseTag", "WA_STUDIO_OPENWA_RELEASE_TAG"),
        ("openwaContractSha256", "WA_STUDIO_OPENWA_CONTRACT_SHA256"),
    ] {
        let value = components[field]
            .as_str()
            .unwrap_or_else(|| panic!("release/components.json is missing {field}"));
        println!("cargo:rustc-env={environment_name}={value}");
    }
    tauri_build::build()
}
