mod windowing;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(windowing::WindowingState::default())
        .plugin(tauri_plugin_http::init())
        .menu(windowing::build_menu)
        .on_menu_event(windowing::handle_menu_event)
        .setup(|app| {
            windowing::initialize_main_window(app).map_err(Box::<dyn std::error::Error>::from)
        })
        .invoke_handler(tauri::generate_handler![
            windowing::get_window_state,
            windowing::get_window_capabilities,
            windowing::set_window_mode,
            windowing::toggle_immersive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
