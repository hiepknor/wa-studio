use std::sync::Mutex;

use super::model::{WindowMode, WindowStateSnapshot};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowTransition {
    pub from: WindowMode,
    pub to: WindowMode,
}

#[derive(Debug)]
struct InnerState {
    mode: WindowMode,
    restore_mode: WindowMode,
    transitioning: bool,
}

impl Default for InnerState {
    fn default() -> Self {
        Self {
            mode: WindowMode::Normal,
            restore_mode: WindowMode::Normal,
            transitioning: false,
        }
    }
}

#[derive(Debug, Default)]
pub struct WindowingState {
    inner: Mutex<InnerState>,
}

impl WindowingState {
    pub fn snapshot(&self) -> Result<WindowStateSnapshot, String> {
        let inner = self.lock()?;
        Ok(WindowStateSnapshot {
            mode: inner.mode,
            transitioning: inner.transitioning,
        })
    }

    pub fn initialize(&self, mode: WindowMode) -> Result<(), String> {
        let mut inner = self.lock()?;
        inner.mode = mode;
        inner.restore_mode = mode;
        inner.transitioning = false;
        Ok(())
    }

    pub fn reconcile(
        &self,
        observed_mode: WindowMode,
    ) -> Result<Option<WindowStateSnapshot>, String> {
        let mut inner = self.lock()?;
        if inner.transitioning || inner.mode == WindowMode::Immersive || inner.mode == observed_mode
        {
            return Ok(None);
        }

        inner.mode = observed_mode;
        inner.restore_mode = observed_mode;
        Ok(Some(WindowStateSnapshot {
            mode: observed_mode,
            transitioning: false,
        }))
    }

    pub fn toggle_target(&self) -> Result<WindowMode, String> {
        let inner = self.lock()?;
        if inner.transitioning {
            return Err("A window mode transition is already in progress.".into());
        }
        Ok(if inner.mode == WindowMode::Immersive {
            inner.restore_mode
        } else {
            WindowMode::Immersive
        })
    }

    pub fn begin(&self, target: WindowMode) -> Result<WindowTransition, String> {
        let mut inner = self.lock()?;
        if inner.transitioning {
            return Err("A window mode transition is already in progress.".into());
        }

        let transition = WindowTransition {
            from: inner.mode,
            to: target,
        };
        if target == WindowMode::Immersive && inner.mode != WindowMode::Immersive {
            inner.restore_mode = inner.mode;
        }
        inner.transitioning = true;
        Ok(transition)
    }

    pub fn complete(&self, transition: WindowTransition) -> Result<WindowStateSnapshot, String> {
        let mut inner = self.lock()?;
        inner.mode = transition.to;
        inner.transitioning = false;
        Ok(WindowStateSnapshot {
            mode: inner.mode,
            transitioning: false,
        })
    }

    pub fn rollback(&self, transition: WindowTransition) -> Result<WindowStateSnapshot, String> {
        let mut inner = self.lock()?;
        inner.mode = transition.from;
        inner.transitioning = false;
        Ok(WindowStateSnapshot {
            mode: inner.mode,
            transitioning: false,
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, InnerState>, String> {
        self.inner
            .lock()
            .map_err(|_| "Window state lock was poisoned.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn immersive_toggle_restores_the_previous_mode() {
        let state = WindowingState::default();
        state.initialize(WindowMode::Maximized).unwrap();

        let enter = state.begin(state.toggle_target().unwrap()).unwrap();
        state.complete(enter).unwrap();
        assert_eq!(state.toggle_target().unwrap(), WindowMode::Maximized);
    }

    #[test]
    fn rejects_overlapping_transitions_and_can_roll_back() {
        let state = WindowingState::default();
        let transition = state.begin(WindowMode::Immersive).unwrap();

        assert!(state.begin(WindowMode::Normal).is_err());
        assert_eq!(state.rollback(transition).unwrap().mode, WindowMode::Normal);
        assert!(!state.snapshot().unwrap().transitioning);
    }

    #[test]
    fn reconciles_native_maximize_but_not_an_active_immersive_mode() {
        let state = WindowingState::default();
        assert_eq!(
            state
                .reconcile(WindowMode::Maximized)
                .unwrap()
                .unwrap()
                .mode,
            WindowMode::Maximized
        );

        let enter = state.begin(WindowMode::Immersive).unwrap();
        state.complete(enter).unwrap();
        assert!(state.reconcile(WindowMode::Normal).unwrap().is_none());
        assert_eq!(state.toggle_target().unwrap(), WindowMode::Maximized);
    }
}
