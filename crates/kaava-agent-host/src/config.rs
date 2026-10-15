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
/// decision D4).
pub const BYPASS: &str = "bypassPermissions";

/// Claude's auto mode, where a classifier approves calls in the user's place.
/// Those calls never reach `session/request_permission`, so Kaava's
/// outside-worktree guard never sees them; it is held back with [`BYPASS`]
/// until the owner decides otherwise.
pub const AUTO: &str = "auto";

/// The values the tab never offers. They are dropped from every option's
/// choices, not only the mode's: the host cannot tell a permission mode set
/// through another option from an ordinary value. A value the agent reports
/// as current is shown as it is, so the tab never claims another mode than
/// the one the agent is in. A harness that uses one of them for something
/// else needs a narrower rule. Approval options that enter one are dropped
/// too ([`enters_held_back`]).
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
/// one would be a way round [`NOT_OFFERED`]. Other options' choices lose
/// those values here; the mode option's lose them where it is applied.
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

/// Read ACP's `modes` (a `SessionModeState`): the modes on offer. The
/// current mode is not read here: the status takes it from the mode option
/// or from `current_mode_update`. `None` when the state lists no
/// `availableModes` at all, so a reply without them clears nothing.
pub fn modes(state: &Value) -> Option<Vec<ConfigChoice>> {
    let list = state.get("availableModes")?.as_array()?;
    Some(
        list.iter()
            .filter_map(|m| {
                Some(ConfigChoice {
                    value: m.get("id")?.as_str()?.to_string(),
                    name: text(m, "name"),
                    description: optional(m, "description"),
                })
            })
            .collect(),
    )
}

/// The choices the tab may offer, in any option: all but [`NOT_OFFERED`].
pub fn allowed(choices: Vec<ConfigChoice>) -> Vec<ConfigChoice> {
    choices
        .into_iter()
        .filter(|c| !NOT_OFFERED.contains(&c.value.as_str()))
        .collect()
}

/// Whether an approval option would put the agent in a mode the tab holds
/// back: the mode's own id, or one of the plan card's `exit-plan-*` ids or
/// the "switch to auto mode" button's, which name it as a word of the id.
/// Choosing one would enter Auto or Bypass without the mode switcher, where
/// the outside-worktree guard cannot apply.
pub fn enters_held_back(option_id: &str) -> bool {
    NOT_OFFERED.contains(&option_id)
        || option_id
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|word| matches!(word, "auto" | "bypass"))
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
        let choices = modes(&json!({
            "currentModeId": "default",
            "availableModes": [
                {"id": "default", "name": "Manual"},
                {"id": "bypassPermissions", "name": "Bypass permissions"},
                {"id": "plan", "name": "Plan", "description": "Plan first"},
                {"id": "auto", "name": "Auto"}
            ]
        }))
        .unwrap();
        let ids: Vec<_> = allowed(choices).into_iter().map(|c| c.value).collect();
        assert_eq!(ids, ["default", "plan"]);
    }

    #[test]
    fn a_mode_state_without_a_current_mode_still_lists_its_modes() {
        let choices = modes(&json!({
            "availableModes": [{"id": "default", "name": "Manual"}]
        }))
        .unwrap();
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].value, "default");
    }

    #[test]
    fn a_mode_state_with_an_empty_list_has_no_modes_and_one_without_a_list_is_none() {
        assert_eq!(modes(&json!({"availableModes": []})), Some(Vec::new()));
        assert!(modes(&json!({"currentModeId": "default"})).is_none());
        assert!(modes(&json!({"availableModes": "plan"})).is_none());
    }

    #[test]
    fn approval_options_that_enter_a_held_back_mode_are_recognised() {
        for id in [
            "auto",
            "bypassPermissions",
            "exit-plan-auto",
            "exit-plan-bypass",
            "exit-plan-clear-auto",
            "exit-plan-clear-bypass",
            "switch-to-auto",
        ] {
            assert!(enters_held_back(id), "{id}");
        }
        for id in [
            "allow",
            "allow_once",
            "reject",
            "default",
            "acceptEdits",
            "exit-plan-default",
            "exit-plan-accept-edits",
            "exit-plan-clear-default",
            "author",
        ] {
            assert!(!enters_held_back(id), "{id}");
        }
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
