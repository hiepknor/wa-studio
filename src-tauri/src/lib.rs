mod app_updates;
mod managed_runtime;
mod windowing;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(managed_runtime::ManagedRuntimeState::default())
        .manage(windowing::WindowingState::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .menu(windowing::build_menu)
        .on_menu_event(windowing::handle_menu_event)
        .setup(|app| {
            app_updates::initialize(app)?;
            windowing::initialize_main_window(app).map_err(Box::<dyn std::error::Error>::from)?;
            managed_runtime::initialize(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_updates::check_for_app_update,
            app_updates::get_app_update_state,
            app_updates::install_app_update,
            managed_runtime::get_managed_runtime_state,
            managed_runtime::get_managed_runtime_provisioning_profile,
            managed_runtime::list_managed_runtime_backups,
            managed_runtime::provision_managed_runtime,
            managed_runtime::reset_managed_runtime_database,
            managed_runtime::reconfigure_managed_runtime,
            managed_runtime::restore_managed_runtime_backup,
            windowing::get_window_state,
            windowing::get_window_capabilities,
            windowing::set_window_mode,
            windowing::toggle_immersive,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                managed_runtime::shutdown(app);
            }
        });
}
