use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

#[cfg(unix)]
use std::{thread, time::Duration};

use tauri_plugin_shell::process::CommandChild;

use super::{postgres::ManagedPostgres, ManagedRuntimeSnapshot};

#[derive(Default)]
pub struct ManagedRuntimeState {
    snapshot: Mutex<ManagedRuntimeSnapshot>,
    processes: Mutex<Vec<CommandChild>>,
    postgres: Mutex<Option<ManagedPostgres>>,
    initializing: AtomicBool,
    maintenance: AtomicBool,
    provisioning: AtomicBool,
    stopping: AtomicBool,
}

impl ManagedRuntimeState {
    pub fn begin_maintenance(
        &self,
        operation: &'static str,
    ) -> Result<ManagedRuntimeMaintenanceGuard<'_>, String> {
        self.maintenance
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                format!(
                    "Managed Runtime cannot start {operation} while another maintenance operation is active."
                )
            })?;
        Ok(ManagedRuntimeMaintenanceGuard(&self.maintenance))
    }

    pub fn begin_initialization(&self) -> Result<(), String> {
        self.initializing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "Managed Runtime initialization is already in progress.".to_string())
    }

    pub fn finish_initialization(&self) {
        self.initializing.store(false, Ordering::Release);
    }

    pub fn resume_for_restart(&self) {
        self.stopping.store(false, Ordering::Release);
    }

    pub fn begin_provisioning(&self) -> Result<(), String> {
        self.provisioning
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "Managed Runtime provisioning is already in progress.".to_string())
    }

    pub fn finish_provisioning(&self) {
        self.provisioning.store(false, Ordering::Release);
    }

    pub fn snapshot(&self) -> Result<ManagedRuntimeSnapshot, String> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| "Managed Runtime state lock is poisoned.".to_string())
    }

    pub fn replace(&self, snapshot: ManagedRuntimeSnapshot) -> Result<(), String> {
        *self
            .snapshot
            .lock()
            .map_err(|_| "Managed Runtime state lock is poisoned.".to_string())? = snapshot;
        Ok(())
    }

    pub fn push_process(&self, process: CommandChild) -> Result<(), String> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| "Managed Runtime process lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            let _ = process.kill();
            return Err("Managed Runtime is already stopping.".to_string());
        }
        processes.push(process);
        Ok(())
    }

    pub fn start_postgres(&self, root: &Path, password: String) -> Result<(String, bool), String> {
        let mut slot = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
        if slot.is_some() {
            return Err("Managed PostgreSQL is already running.".to_string());
        }
        let postgres = ManagedPostgres::start(root, password)?;
        let connection = (
            postgres.database_url().to_string(),
            postgres.database_preexisting(),
        );
        *slot = Some(postgres);
        Ok(connection)
    }

    pub fn create_postgres_backup(
        &self,
        backup_directory: &Path,
        release_version: &str,
        identity: &age::x25519::Identity,
    ) -> Result<Option<PathBuf>, String> {
        let slot = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
        slot.as_ref()
            .ok_or_else(|| "Managed PostgreSQL is not running.".to_string())?
            .create_release_backup(backup_directory, release_version, identity)
    }

    pub fn restore_postgres_backup(
        &self,
        backup_directory: &Path,
        backup_id: &str,
        release_version: &str,
        identity: &age::x25519::Identity,
    ) -> Result<PathBuf, String> {
        let slot = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
        slot.as_ref()
            .ok_or_else(|| "Managed PostgreSQL is not running.".to_string())?
            .restore_backup(backup_directory, backup_id, release_version, identity)
    }

    pub fn create_postgres_update_backup(
        &self,
        backup_directory: &Path,
        current_version: &str,
        target_version: &str,
        identity: &age::x25519::Identity,
    ) -> Result<PathBuf, String> {
        let slot = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
        slot.as_ref()
            .ok_or_else(|| "Managed PostgreSQL is not running.".to_string())?
            .create_update_backup(backup_directory, current_version, target_version, identity)
    }

    pub fn stop_postgres(&self) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        self.stop_postgres_inner()
    }

    pub fn stop_postgres_for_restart(&self) -> Result<(), String> {
        self.stop_postgres_inner()
    }

    fn stop_postgres_inner(&self) -> Result<(), String> {
        let postgres = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?
            .take();
        if let Some(postgres) = postgres {
            postgres.stop()?;
        }
        Ok(())
    }

    pub fn stop_processes(&self) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        self.stop_processes_inner()
    }

    pub fn stop_processes_for_restart(&self) -> Result<(), String> {
        self.stop_processes_inner()
    }

    fn stop_processes_inner(&self) -> Result<(), String> {
        let processes = std::mem::take(
            &mut *self
                .processes
                .lock()
                .map_err(|_| "Managed Runtime process lock is poisoned.".to_string())?,
        );

        #[cfg(unix)]
        {
            let pids = processes.iter().map(CommandChild::pid).collect::<Vec<_>>();
            for pid in &pids {
                // SAFETY: `pid` comes from a live child created by the shell plugin.
                let _ = unsafe { libc::kill(*pid as i32, libc::SIGTERM) };
            }
            for _ in 0..50 {
                if pids.iter().all(|pid| !process_is_running(*pid)) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }

        for process in processes {
            let _ = process.kill();
        }
        Ok(())
    }
}

pub struct ManagedRuntimeMaintenanceGuard<'a>(&'a AtomicBool);

impl Drop for ManagedRuntimeMaintenanceGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(unix)]
fn process_is_running(pid: u32) -> bool {
    // SAFETY: signal 0 performs an existence/permission check and does not mutate the process.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(test)]
mod tests {
    use super::ManagedRuntimeState;

    #[test]
    fn serializes_destructive_maintenance_operations() {
        let state = ManagedRuntimeState::default();
        let guard = state.begin_maintenance("restore").unwrap();
        assert!(state.begin_maintenance("update").is_err());
        drop(guard);
        assert!(state.begin_maintenance("update").is_ok());
    }
}
