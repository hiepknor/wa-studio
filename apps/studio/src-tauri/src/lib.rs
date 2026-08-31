mod app_updates;
mod managed_runtime;
mod windowing;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(managed_runtime::ManagedRuntimeState::default())
        .manage(windowing::WindowingState::default())
        .plugin(tauri_plugin_dialog::init())
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
            managed_runtime::get_managed_runtime_diagnostics,
            managed_runtime::get_managed_runtime_lifecycle_status,
            managed_runtime::get_managed_runtime_state,
            managed_runtime::get_managed_runtime_provisioning_profile,
            managed_runtime::create_managed_runtime_backup,
            managed_runtime::export_managed_runtime_recovery_archive,
            managed_runtime::list_managed_runtime_backups,
            managed_runtime::provision_managed_runtime,
            managed_runtime::transport::request_managed_runtime,
            managed_runtime::reset_managed_runtime_database,
            managed_runtime::reset_managed_runtime_connection,
            managed_runtime::rotate_managed_runtime_connector_credential,
            managed_runtime::reconfigure_managed_runtime,
            managed_runtime::restore_managed_runtime_recovery_archive,
            managed_runtime::restore_managed_runtime_backup,
            windowing::get_window_state,
            windowing::get_window_capabilities,
            windowing::set_window_mode,
            windowing::toggle_immersive,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                let state = app.state::<managed_runtime::ManagedRuntimeState>();
                if code != Some(tauri::RESTART_EXIT_CODE) && !state.exit_is_authorized() {
                    api.prevent_exit();
                    if state.begin_exit_shutdown() {
                        let shutdown_app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            match managed_runtime::shutdown(&shutdown_app).await {
                                Ok(()) => {
                                    managed_runtime::authorize_app_exit(&shutdown_app);
                                    shutdown_app.exit(0);
                                }
                                Err(error) => {
                                    managed_runtime::recover_from_failed_shutdown(
                                        &shutdown_app,
                                        &error,
                                    );
                                    let _ = windowing::show_main_window(&shutdown_app);
                                }
                            }
                        });
                    }
                }
            }
            tauri::RunEvent::Exit => {
                let state = app.state::<managed_runtime::ManagedRuntimeState>();
                if !state.exit_is_authorized() {
                    let _ = state.begin_exit_shutdown();
                    let _ = managed_runtime::shutdown_blocking(app);
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let _ = windowing::show_main_window(app);
            }
            _ => {}
        });
}
