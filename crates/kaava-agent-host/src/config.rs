//! The agent's session settings: ACP's `modes` and `configOptions`, read into
//! the [`ConfigOption`]s the tab draws.
//!
//! Pure, like `normalize.rs`. Claude's adapter reports the mode twice — as
//! `modes`, and as a config option of category `mode` — so the mode option is
//! split out here, and the tab draws one mode picker rather than two.
//!
//! Only `select` options are read. A `boolean` option is sent only to a client
//! that declares `session.configOptions.boolean`, and Kaava declares nothing,
//! so Claude sends its fast-mode switch as an `on`/`off` select instead.

use serde_json::Value;

use crate::event::{ConfigChoice, ConfigOption};

/// The ACP category that marks an option as the session's mode.
pub const MODE_CATEGORY: &str = "mode";

/// Claude's bypass-permissions mode. Never offered in the tab (owner
/// decision D4), and refused if asked for.
pub const BYPASS: &str = "bypassPermissions";

/// Claude's auto mode, where a classifier approves calls in the user's place.
/// Those calls never reach `session/request_permission`, so Kaava's
/// outside-worktree guard never sees them; it is held back with [`BYPASS`]
/// until the owner decides otherwise.
pub const AUTO: &str = "auto";

/// The values the tab never offers, and refuses if asked for. They are held
/// back in every option, not only the mode's: the host cannot tell a
/// permission mode set through another option from an ordinary value. A
/// harness that uses one of them for something else needs a narrower rule.
pub const NOT_OFFERED: [&str; 2] = [BYPASS, AUTO];

/// What one `configOptions` list says.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Settings {
    /// The option of category `mode`, if the list has one.
    pub mode: Option<ConfigOption>,
    /// Every other option, in the agent's order.
    pub options: Vec<ConfigOption>,
}

/// Read a `configOptions` list. Anything that is not a well-formed select
/// option is left out, and so is any mode option after the first: a second
/// one would be a way round [`NOT_OFFERED`]. Other options lose those values
/// here; the mode option loses them where it is applied.
pub fn settings(list: &Value) -> Settings {
    let mut out = Settings::default();
    for option in list.as_array().into_iter().flatten().filter_map(option) {
        if option.category.as_deref() != Some(MODE_CATEGORY) {
            let choices = allowed(option.choices);
            out.options.push(ConfigOption { choices, ..option });
        } else if out.mode.is_none() {
            out.mode = Some(option);
        }
    }
    out
}

/// Read ACP's `modes` (a `SessionModeState`): the current mode and the modes
/// on offer.
pub fn modes(state: &Value) -> Option<(String, Vec<ConfigChoice>)> {
    let current = state.get("currentModeId")?.as_str()?.to_string();
    let choices = state
        .get("availableModes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            Some(ConfigChoice {
                value: m.get("id")?.as_str()?.to_string(),
                name: text(m, "name"),
                description: optional(m, "description"),
            })
        })
        .collect();
    Some((current, choices))
}

/// The modes the tab may offer: all but [`NOT_OFFERED`].
pub fn allowed(choices: Vec<ConfigChoice>) -> Vec<ConfigChoice> {
    choices
        .into_iter()
        .filter(|c| !NOT_OFFERED.contains(&c.value.as_str()))
        .collect()
}

fn option(value: &Value) -> Option<ConfigOption> {
    if value.get("type").and_then(Value::as_str) != Some("select") {
        return None;
    }
    let choices = value
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(
            |entry| match entry.get("options").and_then(Value::as_array) {
                // A group: its options, in order, without the group's own name.
                Some(group) => group.iter().filter_map(choice).collect::<Vec<_>>(),
                None => choice(entry).into_iter().collect(),
            },
        )
        .collect();
    Some(ConfigOption {
        id: value.get("id")?.as_str()?.to_string(),
        name: text(value, "name"),
        description: optional(value, "description"),
        category: optional(value, "category"),
        value: value.get("currentValue")?.as_str()?.to_string(),
        choices,
    })
}

fn choice(value: &Value) -> Option<ConfigChoice> {
    Some(ConfigChoice {
        value: value.get("value")?.as_str()?.to_string(),
        name: text(value, "name"),
        description: optional(value, "description"),
    })
}

fn text(value: &Value, key: &str) -> String {
    optional(value, key).unwrap_or_default()
}

fn optional(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_mode_option_is_split_from_the_rest() {
        let got = settings(&json!([
            {"id": "mode", "name": "Mode", "category": "mode", "type": "select",
             "currentValue": "default",
             "options": [{"value": "default", "name": "Manual"}]},
            {"id": "model", "name": "Model", "category": "model", "type": "select",
             "currentValue": "opus", "description": "AI model to use",
             "options": [{"value": "opus", "name": "Opus", "description": "Most capable"}]},
            {"id": "mode2", "name": "Mode", "category": "mode", "type": "select",
             "currentValue": "default",
             "options": [{"value": "bypassPermissions", "name": "Bypass"}]}
        ]));
        let mode = got.mode.unwrap();
        assert_eq!((mode.id.as_str(), mode.value.as_str()), ("mode", "default"));
        assert_eq!(got.options.len(), 1);
        assert_eq!(got.options[0].id, "model");
        assert_eq!(
            got.options[0].description.as_deref(),
            Some("AI model to use")
        );
        assert_eq!(
            got.options[0].choices[0].description.as_deref(),
            Some("Most capable")
        );
    }

    #[test]
    fn groups_are_flattened_and_booleans_and_junk_left_out() {
        let got = settings(&json!([
            {"id": "a", "name": "A", "type": "select", "currentValue": "x", "options": [
                {"group": "g1", "name": "One", "options": [{"value": "x", "name": "X"}]},
                {"value": "y", "name": "Y"},
                {"name": "no value"}
            ]},
            {"id": "fast", "name": "Fast", "type": "boolean", "currentValue": true},
            {"id": "b", "name": "B", "type": "select", "currentValue": 3, "options": []},
            "nonsense"
        ]));
        assert!(got.mode.is_none());
        assert_eq!(got.options.len(), 1);
        let values: Vec<_> = got.options[0]
            .choices
            .iter()
            .map(|c| c.value.as_str())
            .collect();
        assert_eq!(values, ["x", "y"]);
    }

    #[test]
    fn bypass_and_auto_are_never_offered() {
        let (current, choices) = modes(&json!({
            "currentModeId": "default",
            "availableModes": [
                {"id": "default", "name": "Manual"},
                {"id": "bypassPermissions", "name": "Bypass permissions"},
                {"id": "plan", "name": "Plan", "description": "Plan first"},
                {"id": "auto", "name": "Auto"}
            ]
        }))
        .unwrap();
        assert_eq!(current, "default");
        let ids: Vec<_> = allowed(choices).into_iter().map(|c| c.value).collect();
        assert_eq!(ids, ["default", "plan"]);
        assert!(modes(&json!({"availableModes": []})).is_none());
    }

    #[test]
    fn bypass_is_not_offered_through_another_option_either() {
        let got = settings(&json!([
            {"id": "permissions", "name": "Permissions", "type": "select",
             "currentValue": "default", "options": [
                {"value": "default", "name": "Ask"},
                {"value": "bypassPermissions", "name": "Bypass"},
                {"value": "auto", "name": "Auto"}
            ]}
        ]));
        let values: Vec<_> = got.options[0]
            .choices
            .iter()
            .map(|c| c.value.as_str())
            .collect();
        assert_eq!(values, ["default"]);
    }
}
