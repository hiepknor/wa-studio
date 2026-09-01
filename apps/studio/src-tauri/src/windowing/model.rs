use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    #[default]
    Normal,
    Maximized,
    Immersive,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStateSnapshot {
    pub mode: WindowMode,
    pub transitioning: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCapabilities {
    pub immersive: bool,
    pub native_spaces: bool,
    pub restore_placement: bool,
    pub snap_layouts: bool,
}
