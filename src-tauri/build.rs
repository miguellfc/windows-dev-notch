use std::path::Path;

/// The `window.notch` bridge is bundled by Vite and embedded with `include_str!`.
const BRIDGE: &str = "gen/bridge.js";

fn main() {
    println!("cargo:rerun-if-changed={BRIDGE}");
    if !Path::new(BRIDGE).exists() {
        panic!(
            "src-tauri/{BRIDGE} is missing: run npm run build:bridge (or npm run test:rust) first"
        );
    }

    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        // tauri-build embeds the Common Controls v6 manifest only into the app binary; test
        // binaries then fail to start (STATUS_ENTRYPOINT_NOT_FOUND). Link it into every
        // target instead, as Tauri's own examples do.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_windows_manifest();
    }
    tauri_build::try_build(attributes).expect("tauri-build failed");
}

fn embed_windows_manifest() {
    let manifest = std::env::current_dir()
        .expect("build script directory")
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    // Treat linker warnings (e.g. a bad manifest) as errors.
    println!("cargo:rustc-link-arg=/WX");
}
