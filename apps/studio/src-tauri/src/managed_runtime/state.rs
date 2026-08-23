use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::thread;

use tauri_plugin_shell::process::CommandChild;

use super::{postgres::ManagedPostgres, ManagedRuntimePhase, ManagedRuntimeSnapshot};

#[derive(Clone)]
pub struct RuntimeTransportCredentials {
    pub base_url: String,
    pub api_key: String,
}

const AUTO_RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);
const AUTO_RESTART_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

struct RuntimeProcess {
    generation: u64,
    child: CommandChild,
}

#[derive(Default)]
struct RestartBudget {
    attempts: VecDeque<Instant>,
}

impl RestartBudget {
    fn plan(&mut self, now: Instant) -> Option<Duration> {
        while self
            .attempts
            .front()
            .is_some_and(|attempt| now.duration_since(*attempt) >= AUTO_RESTART_WINDOW)
        {
            self.attempts.pop_front();
        }
        let delay = AUTO_RESTART_DELAYS.get(self.attempts.len()).copied()?;
        self.attempts.push_back(now);
        Some(delay)
    }
}

pub enum AutoRestartPlan {
    Retry(Duration),
    Exhausted,
    Cancelled,
}

#[derive(Default)]
pub struct ManagedRuntimeState {
    snapshot: Mutex<ManagedRuntimeSnapshot>,
    runtime_transport: Mutex<Option<RuntimeTransportCredentials>>,
    process: Mutex<Option<RuntimeProcess>>,
    postgres: Mutex<Option<ManagedPostgres>>,
    next_process_generation: AtomicU64,
    restart_budget: Mutex<RestartBudget>,
    restart_scheduled: AtomicBool,
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
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
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
        let ready = snapshot.phase == ManagedRuntimePhase::Ready;
        *self
            .snapshot
            .lock()
            .map_err(|_| "Managed Runtime state lock is poisoned.".to_string())? = snapshot;
        if !ready {
            *self
                .runtime_transport
                .lock()
                .map_err(|_| "Managed Runtime transport lock is poisoned.".to_string())? = None;
        }
        Ok(())
    }

    pub fn set_runtime_transport(&self, base_url: String, api_key: String) -> Result<(), String> {
        *self
            .runtime_transport
            .lock()
            .map_err(|_| "Managed Runtime transport lock is poisoned.".to_string())? =
            Some(RuntimeTransportCredentials { base_url, api_key });
        Ok(())
    }

    pub fn runtime_transport(&self) -> Result<RuntimeTransportCredentials, String> {
        if self.snapshot()?.phase != ManagedRuntimePhase::Ready {
            return Err("Managed Runtime is not ready.".to_string());
        }
        self.runtime_transport
            .lock()
            .map_err(|_| "Managed Runtime transport lock is poisoned.".to_string())?
            .clone()
            .ok_or_else(|| "Managed Runtime native transport is unavailable.".to_string())
    }

    pub fn next_process_generation(&self) -> u64 {
        self.next_process_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn process_generation(&self) -> Result<Option<u64>, String> {
        self.process
            .lock()
            .map(|slot| slot.as_ref().map(|process| process.generation))
            .map_err(|_| "Managed Runtime process lock is poisoned.".to_string())
    }

    pub fn managed_postgres_running(&self) -> Result<bool, String> {
        self.postgres
            .lock()
            .map(|slot| slot.is_some())
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())
    }

    pub fn push_process(&self, generation: u64, process: CommandChild) -> Result<(), String> {
        let mut slot = self
            .process
            .lock()
            .map_err(|_| "Managed Runtime process lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            let _ = process.kill();
            return Err("Managed Runtime is already stopping.".to_string());
        }
        if slot.is_some() {
            let _ = process.kill();
            return Err("Managed Runtime process is already running.".to_string());
        }
        *slot = Some(RuntimeProcess {
            generation,
            child: process,
        });
        Ok(())
    }

    pub fn process_generation_is_current(&self, generation: u64) -> Result<bool, String> {
        self.process
            .lock()
            .map(|slot| {
                slot.as_ref()
                    .is_some_and(|process| process.generation == generation)
            })
            .map_err(|_| "Managed Runtime process lock is poisoned.".to_string())
    }

    pub fn mark_process_terminated(&self, generation: u64) -> Result<bool, String> {
        let mut slot = self
            .process
            .lock()
            .map_err(|_| "Managed Runtime process lock is poisoned.".to_string())?;
        if !slot
            .as_ref()
            .is_some_and(|process| process.generation == generation)
        {
            return Ok(false);
        }
        slot.take();
        Ok(true)
    }

    pub fn plan_auto_restart(&self) -> Result<AutoRestartPlan, String> {
        if self.stopping.load(Ordering::Acquire)
            || self
                .restart_scheduled
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Ok(AutoRestartPlan::Cancelled);
        }
        let plan = match self.restart_budget.lock() {
            Ok(mut budget) => budget.plan(Instant::now()),
            Err(_) => {
                self.restart_scheduled.store(false, Ordering::Release);
                return Err("Managed Runtime restart budget lock is poisoned.".to_string());
            }
        };
        if let Some(delay) = plan {
            Ok(AutoRestartPlan::Retry(delay))
        } else {
            self.restart_scheduled.store(false, Ordering::Release);
            Ok(AutoRestartPlan::Exhausted)
        }
    }

    pub fn auto_restart_is_allowed(&self) -> bool {
        self.restart_scheduled.load(Ordering::Acquire) && !self.stopping.load(Ordering::Acquire)
    }

    pub fn finish_auto_restart(&self) {
        self.restart_scheduled.store(false, Ordering::Release);
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

    pub fn create_automatic_postgres_backup(
        &self,
        backup_directory: &Path,
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
            .create_automatic_backup(backup_directory, identity)
    }

    pub fn verify_postgres_integrity_if_due(&self, state_directory: &Path) -> Result<bool, String> {
        let slot = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
        slot.as_ref()
            .ok_or_else(|| "Managed PostgreSQL is not running.".to_string())?
            .verify_integrity_if_due(state_directory)
    }

    pub fn create_manual_postgres_backup(
        &self,
        backup_directory: &Path,
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
            .create_manual_backup(backup_directory, identity)
    }

    pub fn create_portable_postgres_backup(
        &self,
        destination: &Path,
        passphrase: age::secrecy::SecretString,
    ) -> Result<(), String> {
        let slot = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
        slot.as_ref()
            .ok_or_else(|| "Managed PostgreSQL is not running.".to_string())?
            .create_portable_backup(destination, passphrase)
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

    pub fn restore_portable_postgres_backup(
        &self,
        source: &Path,
        passphrase: age::secrecy::SecretString,
        backup_directory: &Path,
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
            .restore_portable_backup(
                source,
                passphrase,
                backup_directory,
                release_version,
                identity,
            )
    }

    pub fn restore_postgres_verified_source(
        &self,
        source: &Path,
        identity: &age::x25519::Identity,
    ) -> Result<(), String> {
        let slot = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
        slot.as_ref()
            .ok_or_else(|| "Managed PostgreSQL is not running.".to_string())?
            .restore_verified_source(source, identity)
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
        let process = self
            .process
            .lock()
            .map_err(|_| "Managed Runtime process lock is poisoned.".to_string())?
            .take();

        #[cfg(unix)]
        if let Some(process) = process.as_ref() {
            let pid = process.child.pid();
            // SAFETY: `pid` comes from a live child created by the shell plugin.
            let _ = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
            for _ in 0..50 {
                if !process_is_running(pid) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }

        if let Some(process) = process {
            let _ = process.child.kill();
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
    use std::time::{Duration, Instant};

    use super::{ManagedRuntimeState, RestartBudget};

    #[test]
    fn serializes_destructive_maintenance_operations() {
        let state = ManagedRuntimeState::default();
        let guard = state.begin_maintenance("restore").unwrap();
        assert!(state.begin_maintenance("update").is_err());
        drop(guard);
        assert!(state.begin_maintenance("update").is_ok());
    }

    #[test]
    fn assigns_monotonic_runtime_generations() {
        let state = ManagedRuntimeState::default();

        assert_eq!(state.next_process_generation(), 1);
        assert_eq!(state.next_process_generation(), 2);
    }

    #[test]
    fn bounds_runtime_restarts_to_three_attempts_in_five_minutes() {
        let mut budget = RestartBudget::default();
        let started_at = Instant::now();

        assert_eq!(budget.plan(started_at), Some(Duration::from_secs(1)));
        assert_eq!(
            budget.plan(started_at + Duration::from_secs(30)),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            budget.plan(started_at + Duration::from_secs(60)),
            Some(Duration::from_secs(4))
        );
        assert_eq!(budget.plan(started_at + Duration::from_secs(90)), None);
        assert_eq!(
            budget.plan(started_at + Duration::from_secs(361)),
            Some(Duration::from_secs(1))
        );
    }
}
