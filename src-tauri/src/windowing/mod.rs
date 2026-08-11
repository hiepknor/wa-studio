mod model;
mod platform;
mod state;

use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, Submenu},
    AppHandle, Emitter, Manager, State, WebviewWindow,
};

pub use model::{WindowCapabilities, WindowMode, WindowStateSnapshot};
pub use state::WindowingState;

pub const STATE_CHANGED_EVENT: &str = "window://state-changed";
const TOGGLE_IMMERSIVE_MENU_ID: &str = "view.toggle-immersive";

pub fn initialize(window: &WebviewWindow, state: &WindowingState) -> Result<(), String> {
    platform::configure(window)?;
    state.initialize(platform::initial_mode(window)?)
}

pub fn capabilities() -> WindowCapabilities {
    WindowCapabilities {
        immersive: true,
        native_spaces: cfg!(target_os = "macos"),
        restore_placement: true,
        snap_layouts: cfg!(target_os = "windows"),
    }
}

pub fn transition_to(
    window: &WebviewWindow,
    state: &WindowingState,
    target: WindowMode,
) -> Result<WindowStateSnapshot, String> {
    if target == WindowMode::Immersive && state.snapshot()?.mode != WindowMode::Immersive {
        let _ = state.reconcile(platform::initial_mode(window)?)?;
    }
    let transition = state.begin(target)?;
    let _ = window.emit(STATE_CHANGED_EVENT, state.snapshot()?);

    match platform::apply(window, transition) {
        Ok(()) => {
            let snapshot = state.complete(transition)?;
            sync_menu_label(window.app_handle(), snapshot.mode);
            let _ = window.emit(STATE_CHANGED_EVENT, snapshot);
            Ok(snapshot)
        }
        Err(error) => {
            let snapshot = state.rollback(transition)?;
            sync_menu_label(window.app_handle(), snapshot.mode);
            let _ = window.emit(STATE_CHANGED_EVENT, snapshot);
            Err(error)
        }
    }
}

pub fn toggle(
    window: &WebviewWindow,
    state: &WindowingState,
) -> Result<WindowStateSnapshot, String> {
    transition_to(window, state, state.toggle_target()?)
}

#[tauri::command]
pub fn get_window_state(
    window: WebviewWindow,
    state: State<'_, WindowingState>,
) -> Result<WindowStateSnapshot, String> {
    if state.snapshot()?.mode != WindowMode::Immersive {
        let _ = state.reconcile(platform::initial_mode(&window)?)?;
    }
    state.snapshot()
}

#[tauri::command]
pub fn get_window_capabilities() -> WindowCapabilities {
    capabilities()
}

#[tauri::command]
pub fn set_window_mode(
    window: WebviewWindow,
    state: State<'_, WindowingState>,
    mode: WindowMode,
) -> Result<WindowStateSnapshot, String> {
    transition_to(&window, &state, mode)
}

#[tauri::command]
pub fn toggle_immersive(
    window: WebviewWindow,
    state: State<'_, WindowingState>,
) -> Result<WindowStateSnapshot, String> {
    toggle(&window, &state)
}

pub fn initialize_main_window(app: &tauri::App) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window was not created.".to_string())?;
    initialize(&window, &app.state::<WindowingState>())
}

pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let accelerator = if cfg!(target_os = "macos") {
        "Ctrl+Cmd+F"
    } else {
        "F11"
    };
    let toggle_item = MenuItem::with_id(
        app,
        TOGGLE_IMMERSIVE_MENU_ID,
        "Enter Full Screen",
        true,
        Some(accelerator),
    )?;

    let view_menu = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) if submenu.text().ok().as_deref() == Some("View") => {
            Some(submenu)
        }
        _ => None,
    });

    if let Some(view_menu) = view_menu {
        for item in view_menu.items()? {
            view_menu.remove(&item)?;
        }
        view_menu.append(&toggle_item)?;
    } else {
        menu.append(&Submenu::with_items(app, "View", true, &[&toggle_item])?)?;
    }

    Ok(menu)
}

pub fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    if event.id() != TOGGLE_IMMERSIVE_MENU_ID {
        return;
    }

    let result = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window was not created.".to_string())
        .and_then(|window| toggle(&window, &app.state::<WindowingState>()));

    match result {
        Ok(snapshot) => sync_menu_label(app, snapshot.mode),
        Err(error) => eprintln!("Could not toggle immersive mode: {error}"),
    }
}

fn sync_menu_label(app: &AppHandle, mode: WindowMode) {
    let Some(menu) = app.menu() else {
        return;
    };
    let Some(MenuItemKind::MenuItem(item)) = menu.get(TOGGLE_IMMERSIVE_MENU_ID) else {
        return;
    };
    let label = if mode == WindowMode::Immersive {
        "Exit Full Screen"
    } else {
        "Enter Full Screen"
    };
    let _ = item.set_text(label);
}
