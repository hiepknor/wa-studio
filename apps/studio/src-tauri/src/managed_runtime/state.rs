use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::{io, thread};

use tauri_plugin_shell::process::CommandChild;

use super::{
    postgres::ManagedPostgres, ManagedRuntimeMaintenance, ManagedRuntimePhase,
    ManagedRuntimeSnapshot,
};

#[derive(Clone)]
pub struct RuntimeTransportCredentials {
    pub base_url: String,
    pub api_key: String,
}

const AUTO_RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);
#[cfg(unix)]
const RUNTIME_GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(45);
#[cfg(unix)]
const RUNTIME_FORCE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const RUNTIME_PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const AUTO_RESTART_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

struct RuntimeProcess {
    generation: u64,
    pid: u32,
    child: Option<CommandChild>,
    terminated: Arc<AtomicBool>,
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
    maintenance_cancellation: Mutex<Option<Arc<AtomicBool>>>,
    background_maintenance_generation: AtomicU64,
    provisioning: AtomicBool,
    stopping: AtomicBool,
    shutdown_gate: Mutex<()>,
    exit_shutdown_started: AtomicBool,
    exit_authorized: AtomicBool,
}

impl ManagedRuntimeState {
    pub fn begin_maintenance(
        &self,
        operation: &'static str,
    ) -> Result<ManagedRuntimeMaintenanceGuard<'_>, String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(format!(
                "Managed Runtime cannot start {operation} while the application is quitting."
            ));
        }
        self.maintenance
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                format!(
                    "Managed Runtime cannot start {operation} while another maintenance operation is active."
                )
            })?;
        let cancellation = Arc::new(AtomicBool::new(false));
        match self.maintenance_cancellation.lock() {
            Ok(mut slot) => *slot = Some(cancellation.clone()),
            Err(_) => {
                self.maintenance.store(false, Ordering::Release);
                return Err("Managed Runtime maintenance state lock is poisoned.".to_string());
            }
        }
        Ok(ManagedRuntimeMaintenanceGuard {
            active: &self.maintenance,
            cancellation,
            cancellation_slot: &self.maintenance_cancellation,
        })
    }

    pub fn cancel_maintenance(&self) {
        if let Ok(slot) = self.maintenance_cancellation.lock() {
            if let Some(cancellation) = slot.as_ref() {
                cancellation.store(true, Ordering::Release);
            }
        }
    }

    pub fn start_background_maintenance(&self) -> u64 {
        self.background_maintenance_generation
            .fetch_add(1, Ordering::AcqRel)
            + 1
    }

    pub fn background_maintenance_is_current(&self, generation: u64) -> bool {
        !self.stopping.load(Ordering::Acquire)
            && self
                .background_maintenance_generation
                .load(Ordering::Acquire)
                == generation
    }

    pub fn cancel_background_maintenance(&self) {
        self.background_maintenance_generation
            .fetch_add(1, Ordering::AcqRel);
        self.cancel_maintenance();
    }

    pub fn begin_exit_shutdown(&self) -> bool {
        let started = self
            .exit_shutdown_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        if started {
            self.stopping.store(true, Ordering::Release);
        }
        started
    }

    pub fn authorize_exit(&self) {
        self.exit_authorized.store(true, Ordering::Release);
    }

    pub fn finish_failed_exit_shutdown(&self) {
        self.exit_shutdown_started.store(false, Ordering::Release);
        self.stopping.store(false, Ordering::Release);
    }

    pub fn exit_is_authorized(&self) -> bool {
        self.exit_authorized.load(Ordering::Acquire)
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
        if !self.exit_shutdown_started.load(Ordering::Acquire) {
            self.stopping.store(false, Ordering::Release);
        }
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

    pub fn set_maintenance(
        &self,
        maintenance: Option<ManagedRuntimeMaintenance>,
    ) -> Result<ManagedRuntimeSnapshot, String> {
        let mut snapshot = self
            .snapshot
            .lock()
            .map_err(|_| "Managed Runtime state lock is poisoned.".to_string())?;
        snapshot.maintenance = maintenance;
        Ok(snapshot.clone())
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

    pub fn push_process(
        &self,
        generation: u64,
        process: CommandChild,
    ) -> Result<Arc<AtomicBool>, String> {
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
        let terminated = Arc::new(AtomicBool::new(false));
        *slot = Some(RuntimeProcess {
            generation,
            pid: process.pid(),
            child: Some(process),
            terminated: terminated.clone(),
        });
        Ok(terminated)
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
        cancellation: &AtomicBool,
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
            .create_release_backup_with_cancellation(
                backup_directory,
                release_version,
                identity,
                cancellation,
            )
    }

    pub fn create_automatic_postgres_backup(
        &self,
        backup_directory: &Path,
        identity: &age::x25519::Identity,
        cancellation: &AtomicBool,
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
            .create_automatic_backup(backup_directory, identity, cancellation)
    }

    pub fn verify_postgres_integrity_if_due(
        &self,
        state_directory: &Path,
        cancellation: &AtomicBool,
    ) -> Result<bool, String> {
        let slot = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
        slot.as_ref()
            .ok_or_else(|| "Managed PostgreSQL is not running.".to_string())?
            .verify_integrity_if_due(state_directory, cancellation)
    }

    pub fn postgres_background_maintenance_due(
        &self,
        state_directory: &Path,
    ) -> Result<(bool, bool), String> {
        let slot = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Managed Runtime is already stopping.".to_string());
        }
        slot.as_ref()
            .ok_or_else(|| "Managed PostgreSQL is not running.".to_string())?
            .background_maintenance_due(state_directory)
    }

    pub fn create_manual_postgres_backup(
        &self,
        backup_directory: &Path,
        identity: &age::x25519::Identity,
        cancellation: &AtomicBool,
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
            .create_manual_backup_with_cancellation(backup_directory, identity, cancellation)
    }

    pub fn create_portable_postgres_backup(
        &self,
        destination: &Path,
        passphrase: age::secrecy::SecretString,
        cancellation: &AtomicBool,
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
            .create_portable_backup_with_cancellation(destination, passphrase, cancellation)
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
        cancellation: &AtomicBool,
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
            .create_update_backup_with_cancellation(
                backup_directory,
                current_version,
                target_version,
                identity,
                cancellation,
            )
    }

    pub fn stop_postgres(&self) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        self.stop_postgres_inner()
    }

    pub fn stop_postgres_for_restart(&self) -> Result<(), String> {
        self.stop_postgres_inner()
    }

    fn stop_postgres_inner(&self) -> Result<(), String> {
        self.cancel_background_maintenance();
        let mut postgres = self
            .postgres
            .lock()
            .map_err(|_| "Managed PostgreSQL state lock is poisoned.".to_string())?;
        if let Some(postgres) = postgres.as_ref() {
            postgres.stop()?;
        }
        postgres.take();
        Ok(())
    }

    pub fn shutdown_services(&self) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        self.cancel_background_maintenance();
        let _shutdown = self
            .shutdown_gate
            .lock()
            .map_err(|_| "Managed Runtime shutdown lock is poisoned.".to_string())?;
        shutdown_in_dependency_order(
            || self.stop_processes_inner(),
            || self.stop_postgres_inner(),
        )
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
        let Some(mut process) = process else {
            return Ok(());
        };

        #[cfg(unix)]
        {
            let pid = process.pid;
            let terminated = process.terminated.clone();
            let stop_result = stop_process_with_fallback(
                poll_attempts(RUNTIME_GRACEFUL_SHUTDOWN_TIMEOUT),
                poll_attempts(RUNTIME_FORCE_SHUTDOWN_TIMEOUT),
                |signal| match signal {
                    ProcessStopSignal::Terminate => send_process_signal(pid, signal),
                    ProcessStopSignal::Kill => match process.child.take() {
                        Some(child) => child
                            .kill()
                            .map_err(|error| format!("Could not signal child process: {error}")),
                        None => send_process_signal(pid, signal),
                    },
                },
                || !terminated.load(Ordering::Acquire),
                || thread::sleep(RUNTIME_PROCESS_POLL_INTERVAL),
            );
            if let Err(error) = stop_result {
                if terminated.load(Ordering::Acquire) {
                    return Ok(());
                }
                return Err(self.retain_process_after_stop_failure(process, error));
            }
            Ok(())
        }

        #[cfg(not(unix))]
        {
            process
                .child
                .take()
                .ok_or_else(|| "Managed Runtime process handle is unavailable.".to_string())?
                .kill()
                .map_err(|error| format!("Could not force stop managed Runtime: {error}"))
        }
    }

    fn retain_process_after_stop_failure(
        &self,
        process: RuntimeProcess,
        stop_error: String,
    ) -> String {
        match self.process.lock() {
            Ok(mut slot) if slot.is_none() => {
                *slot = Some(process);
                stop_error
            }
            Ok(_) => format!(
                "{stop_error} Managed Runtime process ownership changed before its handle could be restored."
            ),
            Err(_) => format!(
                "{stop_error} Managed Runtime process handle could not be restored because its state lock is poisoned."
            ),
        }
    }
}

pub struct ManagedRuntimeMaintenanceGuard<'a> {
    active: &'a AtomicBool,
    cancellation: Arc<AtomicBool>,
    cancellation_slot: &'a Mutex<Option<Arc<AtomicBool>>>,
}

impl ManagedRuntimeMaintenanceGuard<'_> {
    pub fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancellation.clone()
    }
}

impl Drop for ManagedRuntimeMaintenanceGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.cancellation_slot.lock() {
            if slot
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &self.cancellation))
            {
                *slot = None;
            }
        }
        self.active.store(false, Ordering::Release);
    }
}

fn shutdown_in_dependency_order(
    stop_runtime: impl FnOnce() -> Result<(), String>,
    stop_postgres: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    stop_runtime()?;
    stop_postgres()
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessStopSignal {
    Terminate,
    Kill,
}

#[cfg(unix)]
fn poll_attempts(timeout: Duration) -> usize {
    (timeout.as_millis() / RUNTIME_PROCESS_POLL_INTERVAL.as_millis()).max(1) as usize
}

#[cfg(unix)]
fn send_process_signal(pid: u32, signal: ProcessStopSignal) -> Result<(), String> {
    let signal = match signal {
        ProcessStopSignal::Terminate => libc::SIGTERM,
        ProcessStopSignal::Kill => libc::SIGKILL,
    };
    // SAFETY: `pid` comes from a child created by the shell plugin and the signal is fixed above.
    if unsafe { libc::kill(pid as i32, signal) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error().to_string())
    }
}

#[cfg(unix)]
fn stop_process_with_fallback(
    graceful_attempts: usize,
    force_attempts: usize,
    mut send_signal: impl FnMut(ProcessStopSignal) -> Result<(), String>,
    mut is_running: impl FnMut() -> bool,
    mut wait: impl FnMut(),
) -> Result<(), String> {
    if !is_running() {
        return Ok(());
    }
    if let Err(error) = send_signal(ProcessStopSignal::Terminate) {
        if is_running() {
            return Err(format!(
                "Could not request managed Runtime shutdown: {error}"
            ));
        }
        return Ok(());
    }
    if wait_for_process_exit(graceful_attempts, &mut is_running, &mut wait) {
        return Ok(());
    }
    if let Err(error) = send_signal(ProcessStopSignal::Kill) {
        if is_running() {
            return Err(format!("Could not force stop managed Runtime: {error}"));
        }
        return Ok(());
    }
    if wait_for_process_exit(force_attempts, &mut is_running, &mut wait) {
        Ok(())
    } else {
        Err("Managed Runtime remained active after forced shutdown.".to_string())
    }
}

#[cfg(unix)]
fn wait_for_process_exit(
    attempts: usize,
    is_running: &mut impl FnMut() -> bool,
    wait: &mut impl FnMut(),
) -> bool {
    for _ in 0..attempts {
        if !is_running() {
            return true;
        }
        wait();
    }
    !is_running()
}

#[cfg(test)]
mod tests {
    use std::{
        cell::RefCell,
        sync::atomic::Ordering,
        time::{Duration, Instant},
    };

    use super::{shutdown_in_dependency_order, ManagedRuntimeState, RestartBudget};

    #[cfg(unix)]
    use super::{stop_process_with_fallback, ProcessStopSignal};

    #[test]
    fn keeps_postgres_running_when_runtime_shutdown_fails() {
        let mut postgres_stopped = false;

        let result = shutdown_in_dependency_order(
            || Err("Runtime is still active.".to_string()),
            || {
                postgres_stopped = true;
                Ok(())
            },
        );

        assert_eq!(result.unwrap_err(), "Runtime is still active.");
        assert!(!postgres_stopped);
    }

    #[test]
    fn stops_postgres_only_after_runtime_shutdown_succeeds() {
        let order = RefCell::new(Vec::new());

        shutdown_in_dependency_order(
            || {
                order.borrow_mut().push("runtime");
                Ok(())
            },
            || {
                order.borrow_mut().push("postgres");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(*order.borrow(), ["runtime", "postgres"]);
    }

    #[cfg(unix)]
    #[test]
    fn escalates_an_unresponsive_runtime_to_forced_shutdown() {
        let mut signals = Vec::new();
        let mut checks = 0;

        stop_process_with_fallback(
            2,
            2,
            |signal| {
                signals.push(signal);
                Ok(())
            },
            || {
                checks += 1;
                checks < 5
            },
            || {},
        )
        .unwrap();

        assert_eq!(
            signals,
            [ProcessStopSignal::Terminate, ProcessStopSignal::Kill]
        );
    }

    #[cfg(unix)]
    #[test]
    fn fails_closed_when_forced_shutdown_does_not_stop_runtime() {
        let result = stop_process_with_fallback(1, 1, |_| Ok(()), || true, || {});

        assert_eq!(
            result.unwrap_err(),
            "Managed Runtime remained active after forced shutdown."
        );
    }

    #[test]
    fn serializes_destructive_maintenance_operations() {
        let state = ManagedRuntimeState::default();
        let guard = state.begin_maintenance("restore").unwrap();
        assert!(state.begin_maintenance("update").is_err());
        drop(guard);
        assert!(state.begin_maintenance("update").is_ok());
    }

    #[test]
    fn signals_active_maintenance_before_postgres_shutdown_waits_for_it() {
        let state = ManagedRuntimeState::default();
        let guard = state.begin_maintenance("automatic backup").unwrap();
        let cancellation = guard.cancellation();

        state.cancel_maintenance();

        assert!(cancellation.load(Ordering::Acquire));
    }

    #[test]
    fn replaces_and_cancels_background_maintenance_generations() {
        let state = ManagedRuntimeState::default();
        let first = state.start_background_maintenance();
        let second = state.start_background_maintenance();

        assert!(!state.background_maintenance_is_current(first));
        assert!(state.background_maintenance_is_current(second));

        state.cancel_background_maintenance();
        assert!(!state.background_maintenance_is_current(second));
    }

    #[test]
    fn exit_shutdown_cannot_be_reopened_by_operation_recovery() {
        let state = ManagedRuntimeState::default();

        assert!(state.begin_exit_shutdown());
        state.resume_for_restart();

        assert!(state.begin_initialization().is_err());
        assert!(!state.begin_exit_shutdown());
    }

    #[test]
    fn failed_exit_shutdown_can_be_retried() {
        let state = ManagedRuntimeState::default();

        assert!(state.begin_exit_shutdown());
        state.finish_failed_exit_shutdown();

        assert!(state.begin_exit_shutdown());
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
