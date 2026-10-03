//! The Markup section: what happens to a markup once it is drawn, for every
//! viewer that has one (the Godot Viewer today, the Blender Viewer when it
//! gains the layer).
//!
//! One section rather than a row in each viewer's own, so a person decides once
//! and the viewers agree. These were `godot.markupAutoSend` and
//! `godot.markupTip` first; [`migrate_legacy`] carries a stored choice across.

use super::{Applies, Control, Group, Setting};
use serde_json::Value;
use std::collections::BTreeMap;

pub const AUTO_SEND: &str = "markup.autoSend";
pub const TIP: &str = "markup.tip";

/// The keys this section replaced, and what each became.
const LEGACY: &[(&str, &str)] = &[
    ("godot.markupAutoSend", AUTO_SEND),
    ("godot.markupTip", TIP),
];

pub static GROUP: Group = Group {
    id: "markup",
    title: "Markup",
    description: "Drawing over a 3D view to show the agent what you mean. Applies to every viewer \
                  that has markup.",
    order: 105,
    settings: ROWS,
};

static ROWS: &[Setting] = &[
    Setting {
        key: AUTO_SEND,
        title: "Send markup to the agent automatically",
        description: "Pressing Done attaches the drawing and its notes as context and types the \
                      reference at the agent's prompt. It does not press Enter: you read it and \
                      send. Off, you press Send markup yourself, which does the same.",
        control: Control::Toggle { default: false },
        applies: Applies::Now,
    },
    Setting {
        key: TIP,
        title: "Suggest sending markup automatically",
        description: "The note a viewer shows the first time you send markup by hand, offering to \
                      make it automatic. Switch this back on to see it again.",
        control: Control::Toggle { default: true },
        applies: Applies::Now,
    },
];

/// Moves a value stored under a legacy key to its new key, so nobody loses a
/// choice they made. A value already stored under the new key wins: it was
/// written by a build that knows the new name. The legacy key is always
/// dropped.
pub fn migrate_legacy(stored: &mut BTreeMap<String, Value>) {
    for (old, new) in LEGACY {
        if let Some(value) = stored.remove(*old) {
            stored.entry((*new).to_string()).or_insert(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_godot_choice_follows_the_setting_to_its_new_key() {
        let mut stored = BTreeMap::from([
            ("godot.markupAutoSend".to_string(), json!(true)),
            ("godot.markupTip".to_string(), json!(false)),
            ("editor.fontSize".to_string(), json!(15)),
        ]);
        migrate_legacy(&mut stored);
        assert_eq!(stored.get(AUTO_SEND), Some(&json!(true)));
        assert_eq!(stored.get(TIP), Some(&json!(false)));
        assert!(!stored.contains_key("godot.markupAutoSend"));
        assert!(!stored.contains_key("godot.markupTip"));
        assert_eq!(stored.get("editor.fontSize"), Some(&json!(15)));
    }

    #[test]
    fn a_value_already_under_the_new_key_is_not_overwritten() {
        let mut stored = BTreeMap::from([
            ("godot.markupAutoSend".to_string(), json!(true)),
            (AUTO_SEND.to_string(), json!(false)),
        ]);
        migrate_legacy(&mut stored);
        assert_eq!(stored.get(AUTO_SEND), Some(&json!(false)));
        assert!(!stored.contains_key("godot.markupAutoSend"));
    }

    #[test]
    fn nothing_stored_stays_nothing() {
        let mut stored = BTreeMap::new();
        migrate_legacy(&mut stored);
        assert!(stored.is_empty());
    }

    #[test]
    fn a_migrated_file_survives_hydrate() {
        let registry = crate::settings::Registry::default();
        registry.register(&GROUP);
        let mut stored = BTreeMap::from([("godot.markupAutoSend".to_string(), json!(true))]);
        migrate_legacy(&mut stored);
        registry.hydrate(stored);
        assert_eq!(registry.get(AUTO_SEND), Some(json!(true)));
        assert_eq!(registry.get(TIP), Some(json!(true)));
    }
}
