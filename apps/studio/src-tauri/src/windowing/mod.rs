mod model;
mod platform;
mod state;

use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewWindow,
};

pub use model::{WindowCapabilities, WindowMode, WindowStateSnapshot};
pub use state::WindowingState;

pub const STATE_CHANGED_EVENT: &str = "window://state-changed";
const TOGGLE_IMMERSIVE_MENU_ID: &str = "view.toggle-immersive";
const SHOW_APP_MENU_ID: &str = "app.show";
const QUIT_APP_MENU_ID: &str = "app.quit";

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
    initialize(&window, &app.state::<WindowingState>())?;
    match initialize_tray(app) {
        Ok(()) => {
            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = close_window.hide();
                }
            });
        }
        Err(error) => {
            eprintln!("Could not initialize the WA Studio tray; window close will quit: {error}");
        }
    }
    Ok(())
}

fn initialize_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_APP_MENU_ID, "Open WA Studio", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_APP_MENU_ID, "Quit WA Studio", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("wa-studio")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("WA Studio")
        .on_tray_icon_event(|tray, event| {
            let should_show = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );
            if should_show {
                let _ = show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window was not created.".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())
}

pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    replace_native_quit_item(app, &menu)?;
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

fn replace_native_quit_item(app: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    let parent_label = if cfg!(target_os = "macos") {
        app.package_info().name.as_str()
    } else {
        "File"
    };
    let parent = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) if submenu.text().ok().as_deref() == Some(parent_label) => {
            Some(submenu)
        }
        _ => None,
    });
    let Some(parent) = parent else {
        return Ok(());
    };
    let native_quit = parent.items()?.into_iter().find(|item| match item {
        MenuItemKind::Predefined(item) => item.text().is_ok_and(|text| {
            let text = text.to_ascii_lowercase();
            text.contains("quit") || text.contains("exit")
        }),
        _ => false,
    });
    let Some(native_quit) = native_quit else {
        return Ok(());
    };
    parent.remove(&native_quit)?;
    parent.append(&MenuItem::with_id(
        app,
        QUIT_APP_MENU_ID,
        "Quit WA Studio",
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;
    Ok(())
}

pub fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        SHOW_APP_MENU_ID => {
            let _ = show_main_window(app);
            return;
        }
        QUIT_APP_MENU_ID => {
            app.exit(0);
            return;
        }
        TOGGLE_IMMERSIVE_MENU_ID => {}
        _ => return,
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
