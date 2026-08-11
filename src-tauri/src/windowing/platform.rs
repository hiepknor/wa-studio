use tauri::WebviewWindow;

use super::{model::WindowMode, state::WindowTransition};

#[cfg(target_os = "macos")]
pub fn configure(window: &WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri owns this NSWindow for the lifetime of `window`, and setup runs on
    // AppKit's main thread before the user can interact with the title-bar controls.
    unsafe {
        let native_window: &NSWindow = &*pointer.cast();
        let mut behavior = native_window.collectionBehavior();
        behavior.remove(NSWindowCollectionBehavior::FullScreenPrimary);
        behavior.insert(NSWindowCollectionBehavior::FullScreenNone);
        native_window.setCollectionBehavior(behavior);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn configure(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

pub fn initial_mode(window: &WebviewWindow) -> Result<WindowMode, String> {
    if window.is_fullscreen().map_err(|error| error.to_string())? {
        Ok(WindowMode::Immersive)
    } else if window.is_maximized().map_err(|error| error.to_string())? {
        Ok(WindowMode::Maximized)
    } else {
        Ok(WindowMode::Normal)
    }
}

#[cfg(target_os = "macos")]
pub fn apply(window: &WebviewWindow, transition: WindowTransition) -> Result<(), String> {
    if transition.from == WindowMode::Immersive && transition.to != WindowMode::Immersive {
        window
            .set_simple_fullscreen(false)
            .map_err(|error| error.to_string())?;
    }

    match transition.to {
        WindowMode::Normal => window.unmaximize().map_err(|error| error.to_string()),
        WindowMode::Maximized => window.maximize().map_err(|error| error.to_string()),
        WindowMode::Immersive => window
            .set_simple_fullscreen(true)
            .map_err(|error| error.to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn apply(window: &WebviewWindow, transition: WindowTransition) -> Result<(), String> {
    if transition.from == WindowMode::Immersive && transition.to != WindowMode::Immersive {
        window
            .set_fullscreen(false)
            .map_err(|error| error.to_string())?;
    }

    match transition.to {
        WindowMode::Normal => window.unmaximize().map_err(|error| error.to_string()),
        WindowMode::Maximized => window.maximize().map_err(|error| error.to_string()),
        WindowMode::Immersive => window
            .set_fullscreen(true)
            .map_err(|error| error.to_string()),
    }
}
