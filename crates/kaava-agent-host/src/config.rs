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
/// Offered, by the owner's decision (2026-10): those calls never reach
/// `session/request_permission`, so Kaava's outside-worktree guard does not
/// see them, and what keeps them in the worktree is Claude's own classifier.
/// A session still starts ask-first; auto is only ever the user's pick.
pub const AUTO: &str = "auto";

/// Codex's auto-review mode, its adapter's default: a reviewer model approves
/// calls in the user's place, so, like [`AUTO`], they never reach the guard.
/// Still held back: the owner's decision on auto covered Claude's alone.
pub const CODEX_AUTO_REVIEW: &str = "agent";

/// Codex's full-access mode: no approvals and no sandbox. Codex's [`BYPASS`].
pub const CODEX_FULL_ACCESS: &str = "agent-full-access";

/// The values the tab never offers. They are dropped from every option's
/// choices, not only the mode's: the host cannot tell a permission mode set
/// through another option from an ordinary value. A value the agent reports
/// as current is shown as it is, so the tab never claims another mode than
/// the one the agent is in. A harness that uses one of them for something
/// else needs a narrower rule. Approval options that enter one are dropped
/// too ([`enters_held_back`]).
pub const NOT_OFFERED: [&str; 3] = [BYPASS, CODEX_AUTO_REVIEW, CODEX_FULL_ACCESS];

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
/// back: the mode's own id, or one of the plan card's `exit-plan-*` ids,
/// which name it as a word of the id. Words split at punctuation and at a
/// camelCase capital, in any case, so `yesSwitchToBypass` counts as well as
/// `exit-plan-bypass`. Choosing one would enter Bypass without the mode
/// switcher. Auto is offered ([`AUTO`]), so `exit-plan-auto` is not held back
/// here. claude-agent-acp 0.90.0 sends it as `allow_always`, which no card
/// offers, so with that adapter Auto is entered from the mode picker.
pub fn enters_held_back(option_id: &str) -> bool {
    NOT_OFFERED.contains(&option_id) || words(option_id).any(|word| word == "bypass")
}

/// An id's words, lowercased: split at anything but a letter or digit, and
/// before a capital that follows a lowercase letter or a digit.
fn words(id: &str) -> impl Iterator<Item = String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut prev: Option<char> = None;
    for c in id.chars() {
        let starts = c.is_ascii_uppercase()
            && prev.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit());
        if !c.is_ascii_alphanumeric() || starts {
            out.push(std::mem::take(&mut word));
        }
        if c.is_ascii_alphanumeric() {
            word.push(c.to_ascii_lowercase());
        }
        prev = Some(c);
    }
    out.push(word);
    out.into_iter().filter(|w| !w.is_empty())
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

    /// Auto was held back with bypass until the owner chose to offer it
    /// (2026-10); this test said so, and now says the opposite for auto only.
    #[test]
    fn bypass_is_never_offered_and_auto_is() {
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
        assert_eq!(ids, ["default", "plan", "auto"]);
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
            "bypassPermissions",
            "exit-plan-bypass",
            "exit-plan-clear-bypass",
            "switch-to-bypass",
            "yesSwitchToBypass",
            "switch_to_BYPASS",
            "BypassPermissions",
            "agent",
            "agent-full-access",
        ] {
            assert!(enters_held_back(id), "{id}");
        }
        // Auto is offered, so a card's way into it is kept.
        for id in [
            "auto",
            "exit-plan-auto",
            "exit-plan-clear-auto",
            "yesSwitchToAuto",
            "useAutoMode",
            "allow",
            "allow_once",
            "reject",
            "default",
            "acceptEdits",
            "exit-plan-default",
            "exit-plan-accept-edits",
            "exit-plan-clear-default",
            "author",
            "autonomous",
        ] {
            assert!(!enters_held_back(id), "{id}");
        }
    }

    /// Every `optionId` claude-agent-acp 0.90.0 sends
    /// (`permissions/options/shared.js`, `PERMISSION_OPTION_ID`), and
    /// whether [`enters_held_back`] drops it by id (the card also drops
    /// every `allow_always` option). A new id in a later adapter goes here.
    #[test]
    fn every_option_id_the_claude_adapter_sends_is_sorted() {
        let ids = [
            ("allow-once", false),
            ("allow-with-updates", false),
            ("allow-skill-exact", false),
            ("allow-skill-prefix", false),
            ("exit-plan-bypass", true),
            ("exit-plan-auto", false),
            ("exit-plan-accept-edits", false),
            ("exit-plan-default", false),
            ("exit-plan-clear-auto", false),
            ("exit-plan-clear-bypass", true),
            ("exit-plan-clear-accept-edits", false),
            ("reject", false),
        ];
        for (id, held_back) in ids {
            assert_eq!(enters_held_back(id), held_back, "{id}");
        }
    }

    #[test]
    fn codex_offers_only_the_modes_that_ask() {
        let choices = modes(&json!({
            "currentModeId": "read-only",
            "availableModes": [
                {"id": "read-only", "name": "Read-only"},
                {"id": "workspace-write", "name": "Workspace access"},
                {"id": "agent", "name": "Auto review"},
                {"id": "agent-full-access", "name": "Full access"}
            ]
        }))
        .unwrap();
        let ids: Vec<_> = allowed(choices).into_iter().map(|c| c.value).collect();
        assert_eq!(ids, ["read-only", "workspace-write"]);
        assert!(enters_held_back(CODEX_AUTO_REVIEW));
        assert!(enters_held_back(CODEX_FULL_ACCESS));
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
        assert_eq!(values, ["default", "auto"]);
    }
}
