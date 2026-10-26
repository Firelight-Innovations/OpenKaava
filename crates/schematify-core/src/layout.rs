//! The layout file of PRD section 5.10, and why it is not a node.
//!
//! Layout is cosmetic. It is split off into its own directory for the reason
//! PRD section 6.2 gives: dragging a node must not dirty a semantic file, so a
//! position change and a contract change can never collide in a merge. A lost
//! layout file costs positions and nothing else.
//!
//! The file is named by the Schematic slug rather than by a UUID, which is the
//! one place in `.veistra/` where a name is a filename. The wireframe status bar
//! draws it that way, `layout/auth-service.json clean`, and a person reading a
//! diff should be able to tell which surface moved. The cost is that a slug
//! rename has to rename the file, and [`crate::Store::rename_layout`] is where
//! that happens.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Where one node or group sits on a Schematic.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    /// The left edge.
    pub x: f64,
    /// The top edge.
    pub y: f64,
    /// The drawn width.
    pub w: f64,
    /// The drawn height.
    pub h: f64,
    /// Whether the box is drawn collapsed.
    #[serde(default)]
    pub collapsed: bool,
}

/// One Schematic's positions.
///
/// The two maps are keyed by identifier as a string rather than as a `Uuid`,
/// because JSON object keys are strings and a position for a node that has
/// since been deleted should not stop the file parsing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    /// The Schematic slug this file belongs to. Matches the filename.
    pub schematic: String,
    /// The zoom level, where 1.0 draws at native size.
    #[serde(default = "default_zoom")]
    pub zoom: f64,
    /// The pan offset, as `[x, y]`.
    #[serde(default)]
    pub pan: [f64; 2],
    /// Where each node sits.
    #[serde(default)]
    pub nodes: BTreeMap<String, Placement>,
    /// Where each group sits.
    #[serde(default)]
    pub groups: BTreeMap<String, Placement>,
}

fn default_zoom() -> f64 {
    1.0
}

impl Layout {
    /// An empty layout for a Schematic.
    #[must_use]
    pub fn new(schematic: impl Into<String>) -> Self {
        Self {
            schematic: schematic.into(),
            zoom: default_zoom(),
            pan: [0.0, 0.0],
            nodes: BTreeMap::new(),
            groups: BTreeMap::new(),
        }
    }

    /// The filename this layout is stored under.
    #[must_use]
    pub fn file_name(&self) -> String {
        format!("{}.json", self.schematic)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layout_round_trips() {
        let mut layout = Layout::new("auth-service");
        layout.zoom = 0.68;
        layout.pan = [-120.0, 40.0];
        layout.nodes.insert(
            "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8".to_owned(),
            Placement {
                x: 10.0,
                y: 20.0,
                w: 240.0,
                h: 120.0,
                collapsed: false,
            },
        );
        layout.groups.insert(
            "0192f4a2-0000-7000-8000-000000000000".to_owned(),
            Placement {
                x: 0.0,
                y: 0.0,
                w: 600.0,
                h: 400.0,
                collapsed: true,
            },
        );
        let text = serde_json::to_string(&layout).unwrap();
        assert_eq!(serde_json::from_str::<Layout>(&text).unwrap(), layout);
    }

    #[test]
    fn a_layout_is_named_by_its_schematic_slug() {
        assert_eq!(Layout::new("auth-service").file_name(), "auth-service.json");
    }

    #[test]
    fn a_layout_with_nothing_but_a_name_parses_at_native_zoom() {
        let layout: Layout = serde_json::from_str("{\"schematic\":\"stack\"}").unwrap();
        assert_eq!(layout.zoom, 1.0);
        assert_eq!(layout.pan, [0.0, 0.0]);
        assert!(layout.nodes.is_empty());
    }
}
