//! Object types: what kind of thing a frame describes, and the properties that
//! kind has.
//!
//! A frame is the unit of detail on a canvas. Its `customData.kaava.object`
//! names a type (`feature`, `model`, ...) and holds the values of that type's
//! fields. The five built-in types are code, below. Custom types are the
//! project's own and live in `.kaava/canvas/types.json`, written atomically.
//! A custom type may not reuse a built-in id, so a project can never change what
//! `model` means for the agent.
//!
//! Everything but the two file functions is pure, so schema validation is
//! tested without a project.

use super::bad;
use super::store::atomic_write;
use kaava_rpc::{RpcError, INTERNAL_ERROR};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// The icon names the Inspector can draw.
pub const ICONS: &[&str] = &[
    "shapes", "box", "layers", "gamepad", "cog", "note", "star", "user", "map", "image", "music",
    "monitor",
];

const MAX_CUSTOM_TYPES: usize = 100;
const MAX_FIELDS: usize = 40;
const SCHEMA: u64 = 1;

/// How a field's value is edited and stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Text,
    Multiline,
    Number,
    Enum,
    PathList,
    Bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field {
    /// Lowercase slug; the key in a frame's `props`.
    pub key: String,
    pub label: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    /// The choices of an `enum` field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub help: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TypeDef {
    pub id: String,
    pub name: String,
    /// `#rrggbb`.
    pub color: String,
    /// One of [`ICONS`].
    pub icon: String,
    #[serde(default)]
    pub description: String,
    pub fields: Vec<Field>,
    /// True for the types in code. Never written to the file.
    #[serde(default, skip_serializing)]
    pub builtin: bool,
}

impl TypeDef {
    /// The API shape: the stored fields plus `builtin`.
    pub fn to_json(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        v["builtin"] = json!(self.builtin);
        v
    }

    pub fn field(&self, key: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.key == key)
    }
}

fn field(key: &str, label: &str, kind: Kind, default: Option<Value>) -> Field {
    Field {
        key: key.into(),
        label: label.into(),
        kind,
        default,
        options: Vec::new(),
        help: String::new(),
    }
}

fn choice(key: &str, label: &str, options: &[&str], default: &str) -> Field {
    Field {
        options: options.iter().map(|o| (*o).to_string()).collect(),
        ..field(key, label, Kind::Enum, Some(json!(default)))
    }
}

fn builtin(
    id: &str,
    name: &str,
    color: &str,
    icon: &str,
    about: &str,
    fields: Vec<Field>,
) -> TypeDef {
    TypeDef {
        id: id.into(),
        name: name.into(),
        color: color.into(),
        icon: icon.into(),
        description: about.into(),
        fields,
        builtin: true,
    }
}

/// The spec card's review states, shared by the Model type and the asset list.
pub const REVIEW_STATES: &[&str] = &["draft", "review", "accepted", "rejected"];

/// The built-in types, in the order the Inspector offers them.
pub fn builtins() -> Vec<TypeDef> {
    vec![
        builtin(
            "feature",
            "Feature",
            "#3b82f6",
            "star",
            "Something the player or user can do.",
            vec![
                field("summary", "Summary", Kind::Multiline, None),
                choice("priority", "Priority", &["low", "medium", "high"], "medium"),
                choice(
                    "status",
                    "Status",
                    &["idea", "planned", "in-progress", "done"],
                    "idea",
                ),
                field("acceptance", "Acceptance criteria", Kind::Multiline, None),
            ],
        ),
        builtin(
            "model",
            "Model",
            "#f59e0b",
            "box",
            "A 3D asset to be generated or modelled; the old spec card.",
            vec![
                field(
                    "asset_name",
                    "Asset name (if not the frame's)",
                    Kind::Text,
                    None,
                ),
                field("size_m", "Size (m, largest side)", Kind::Number, None),
                field("triangle_budget", "Triangle budget", Kind::Number, None),
                field("style_notes", "Style notes", Kind::Multiline, None),
                field("reference_images", "Reference images", Kind::PathList, None),
                choice("review_state", "Review state", REVIEW_STATES, "draft"),
            ],
        ),
        builtin(
            "ui-screen",
            "UI screen",
            "#a855f7",
            "monitor",
            "One screen or panel of the interface.",
            vec![
                field("purpose", "Purpose", Kind::Multiline, None),
                field("entry_point", "How it is reached", Kind::Text, None),
                field("states", "States", Kind::Multiline, None),
                field("assets", "Assets used", Kind::PathList, None),
            ],
        ),
        builtin(
            "system",
            "System / mechanic",
            "#10b981",
            "cog",
            "A rule or system the game runs on.",
            vec![
                field("summary", "Summary", Kind::Multiline, None),
                field("inputs", "Inputs", Kind::Multiline, None),
                field("outputs", "Outputs", Kind::Multiline, None),
                field("tunables", "Tunable values", Kind::Multiline, None),
            ],
        ),
        builtin(
            "note",
            "Note",
            "#94a3b8",
            "note",
            "Anything else worth telling the agent.",
            vec![field("body", "Note", Kind::Multiline, None)],
        ),
    ]
}

pub fn is_builtin_id(id: &str) -> bool {
    builtins().iter().any(|t| t.id == id)
}

fn slug_ok(s: &str, lead_digit: bool, max: usize) -> bool {
    let mut chars = s.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || (lead_digit && c.is_ascii_digit()));
    first_ok
        && s.len() <= max
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn color_ok(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|d| d.is_ascii_hexdigit())
}

/// Whether `value` is acceptable for `field`. `null` always is: it means unset.
pub fn check_value(field: &Field, value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    let ok = match field.kind {
        Kind::Text | Kind::Multiline => value.is_string(),
        Kind::Number => value.as_f64().is_some_and(f64::is_finite),
        Kind::Bool => value.is_boolean(),
        Kind::Enum => value
            .as_str()
            .is_some_and(|s| field.options.iter().any(|o| o == s)),
        Kind::PathList => value
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string)),
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "`{}` is not a valid {:?} value: {value}",
            field.key, field.kind
        ))
    }
}

/// Why `def` cannot be stored, or `Ok`. Built-ins are not validated here: they
/// are code.
pub fn validate(def: &TypeDef) -> Result<(), String> {
    if !slug_ok(&def.id, false, 40) {
        return Err(format!(
            "type id `{}` must be a lowercase slug starting with a letter (a-z, 0-9, - and _), \
             at most 40 characters",
            def.id
        ));
    }
    if is_builtin_id(&def.id) {
        return Err(format!(
            "`{}` is a built-in type; pick another id for a custom one",
            def.id
        ));
    }
    if def.name.trim().is_empty() || def.name.chars().count() > 60 {
        return Err("a type needs a name of 1 to 60 characters".into());
    }
    if !color_ok(&def.color) {
        return Err(format!("color `{}` must look like #rrggbb", def.color));
    }
    if !ICONS.contains(&def.icon.as_str()) {
        return Err(format!(
            "icon `{}` is not one of: {}",
            def.icon,
            ICONS.join(", ")
        ));
    }
    if def.fields.len() > MAX_FIELDS {
        return Err(format!("a type may have at most {MAX_FIELDS} fields"));
    }
    let mut seen: Vec<&str> = Vec::new();
    for f in &def.fields {
        if !slug_ok(&f.key, false, 48) {
            return Err(format!(
                "field key `{}` must be a lowercase slug starting with a letter",
                f.key
            ));
        }
        if seen.contains(&f.key.as_str()) {
            return Err(format!("field key `{}` is used twice", f.key));
        }
        seen.push(&f.key);
        if f.label.trim().is_empty() {
            return Err(format!("field `{}` needs a label", f.key));
        }
        if f.kind == Kind::Enum {
            if f.options.is_empty() {
                return Err(format!("enum field `{}` needs at least one option", f.key));
            }
            let mut opts: Vec<&str> = f.options.iter().map(String::as_str).collect();
            opts.sort_unstable();
            opts.dedup();
            if opts.len() != f.options.len() || opts.iter().any(|o| o.trim().is_empty()) {
                return Err(format!(
                    "enum field `{}` has empty or repeated options",
                    f.key
                ));
            }
        } else if !f.options.is_empty() {
            return Err(format!("only enum fields take options, not `{}`", f.key));
        }
        if let Some(d) = &f.default {
            check_value(f, d).map_err(|e| format!("default of {e}"))?;
        }
    }
    Ok(())
}

/// A frame's values as `(known, extra)`: every field of `def` with its stored
/// value or default (omitted when it has neither), and the stored keys `def`
/// does not define. Extra values are kept in the file when the type changes, so
/// switching back loses nothing; they are reported, not hidden.
pub fn resolve(
    def: Option<&TypeDef>,
    props: &Map<String, Value>,
) -> (Map<String, Value>, Map<String, Value>) {
    let mut known = Map::new();
    let mut extra = Map::new();
    let Some(def) = def else {
        return (known, props.clone());
    };
    for f in &def.fields {
        match props.get(&f.key).filter(|v| !v.is_null()) {
            Some(v) if check_value(f, v).is_ok() => {
                known.insert(f.key.clone(), v.clone());
            }
            _ => {
                if let Some(d) = &f.default {
                    known.insert(f.key.clone(), d.clone());
                }
            }
        }
    }
    for (k, v) in props {
        if def.field(k).is_none() {
            extra.insert(k.clone(), v.clone());
        }
    }
    (known, extra)
}

// --- the project's custom types ---------------------------------------------

/// `<root>/.kaava/canvas/types.json`.
pub fn types_path(root: &Path) -> PathBuf {
    root.join(".kaava").join("canvas").join("types.json")
}

/// The custom types on disk. A missing file is no types; a file that does not
/// parse is an error, so a save never overwrites what it could not read.
pub fn load_custom(root: &Path) -> Result<Vec<TypeDef>, RpcError> {
    let path = types_path(root);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(RpcError::new(
                INTERNAL_ERROR,
                format!("could not read {}: {e}", path.display()),
            ))
        }
    };
    #[derive(Deserialize)]
    struct File {
        #[serde(default)]
        types: Vec<TypeDef>,
    }
    let file: File = serde_json::from_str(&raw).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("{} is not valid types JSON: {e}", path.display()),
        )
    })?;
    // A hand-edited file may hold a type that shadows a built-in or breaks the
    // schema; it is ignored rather than allowed to redefine `model`.
    Ok(file
        .types
        .into_iter()
        .filter(|t| validate(t).is_ok())
        .collect())
}

fn store_custom(root: &Path, types: &[TypeDef]) -> Result<(), RpcError> {
    let doc = json!({ "schema": SCHEMA, "types": types });
    let mut text = serde_json::to_string_pretty(&doc)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not serialize: {e}")))?;
    text.push('\n');
    atomic_write(&types_path(root), text.as_bytes())
}

/// Built-ins first, then the project's, with the problem reading the file if any.
pub fn all(root: &Path) -> (Vec<TypeDef>, Option<String>) {
    let mut out = builtins();
    match load_custom(root) {
        Ok(custom) => {
            out.extend(custom);
            (out, None)
        }
        Err(e) => (out, Some(e.message)),
    }
}

/// Add or replace a custom type, validated.
pub fn save(root: &Path, def: TypeDef) -> Result<TypeDef, RpcError> {
    validate(&def).map_err(bad)?;
    let mut types = load_custom(root)?;
    match types.iter_mut().find(|t| t.id == def.id) {
        Some(slot) => *slot = def.clone(),
        None => {
            if types.len() >= MAX_CUSTOM_TYPES {
                return Err(bad(format!(
                    "a project may have at most {MAX_CUSTOM_TYPES} custom types"
                )));
            }
            types.push(def.clone());
        }
    }
    store_custom(root, &types)?;
    Ok(def)
}

/// Remove a custom type. Frames that used it keep their values and report the
/// type as unknown. Returns whether there was one.
pub fn delete(root: &Path, id: &str) -> Result<bool, RpcError> {
    if is_builtin_id(id) {
        return Err(bad(format!(
            "`{id}` is a built-in type and cannot be deleted"
        )));
    }
    let mut types = load_custom(root)?;
    let before = types.len();
    types.retain(|t| t.id != id);
    if types.len() == before {
        return Ok(false);
    }
    store_custom(root, &types)?;
    Ok(true)
}

/// A slug safe as a custom type id, from a display name; used when the caller
/// gives none.
pub fn id_from_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    let out = if out.starts_with(|c: char| c.is_ascii_digit()) {
        format!("t-{out}")
    } else {
        out
    };
    out.chars()
        .take(40)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn custom(id: &str) -> TypeDef {
        TypeDef {
            id: id.into(),
            name: "Vehicle".into(),
            color: "#d97706".into(),
            icon: "box".into(),
            description: String::new(),
            fields: vec![
                field("top_speed", "Top speed", Kind::Number, Some(json!(10))),
                choice("class", "Class", &["car", "boat"], "car"),
            ],
            builtin: false,
        }
    }

    #[test]
    fn built_ins_are_the_five_the_brief_names_and_are_valid_shapes() {
        let ids: Vec<String> = builtins().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["feature", "model", "ui-screen", "system", "note"]);
        for t in builtins() {
            assert!(
                color_ok(&t.color) && ICONS.contains(&t.icon.as_str()),
                "{}",
                t.id
            );
            for f in &t.fields {
                if let Some(d) = &f.default {
                    assert!(check_value(f, d).is_ok(), "{}.{}", t.id, f.key);
                }
            }
        }
        let model = builtins().into_iter().find(|t| t.id == "model").unwrap();
        for key in [
            "size_m",
            "triangle_budget",
            "style_notes",
            "reference_images",
            "review_state",
        ] {
            assert!(model.field(key).is_some(), "model lacks {key}");
        }
    }

    #[test]
    fn a_custom_type_cannot_shadow_a_built_in_or_break_the_schema() {
        assert!(validate(&custom("vehicle")).is_ok());
        assert!(validate(&custom("model")).unwrap_err().contains("built-in"));
        assert!(validate(&custom("Bad Id")).is_err());

        let mut bad_color = custom("v");
        bad_color.color = "red".into();
        assert!(validate(&bad_color).is_err());

        let mut bad_icon = custom("v");
        bad_icon.icon = "rocket".into();
        assert!(validate(&bad_icon).is_err());

        let mut dup = custom("v");
        dup.fields
            .push(field("top_speed", "Again", Kind::Text, None));
        assert!(validate(&dup).unwrap_err().contains("twice"));

        let mut no_options = custom("v");
        no_options.fields = vec![field("c", "C", Kind::Enum, None)];
        assert!(validate(&no_options).unwrap_err().contains("option"));

        let mut bad_default = custom("v");
        bad_default.fields = vec![choice("c", "C", &["a", "b"], "z")];
        assert!(validate(&bad_default).unwrap_err().contains("default"));

        let mut stray = custom("v");
        stray.fields = vec![Field {
            options: vec!["x".into()],
            ..field("t", "T", Kind::Text, None)
        }];
        assert!(validate(&stray).is_err());
    }

    #[test]
    fn values_are_checked_by_kind() {
        let n = field("n", "N", Kind::Number, None);
        assert!(check_value(&n, &json!(3.5)).is_ok());
        assert!(check_value(&n, &json!("3")).is_err());
        assert!(check_value(&n, &Value::Null).is_ok());
        let l = field("l", "L", Kind::PathList, None);
        assert!(check_value(&l, &json!(["a.png"])).is_ok());
        assert!(check_value(&l, &json!(["a", 1])).is_err());
        let b = field("b", "B", Kind::Bool, None);
        assert!(check_value(&b, &json!(true)).is_ok());
        assert!(check_value(&b, &json!(1)).is_err());
    }

    #[test]
    fn resolve_fills_defaults_and_reports_values_the_type_does_not_define() {
        let def = custom("vehicle");
        let props = json!({ "top_speed": 99, "class": "plane", "legacy": "kept" });
        let (known, extra) = resolve(Some(&def), props.as_object().unwrap());
        assert_eq!(known["top_speed"], json!(99));
        assert_eq!(
            known["class"],
            json!("car"),
            "an invalid enum falls back to the default"
        );
        assert_eq!(extra["legacy"], json!("kept"));
    }

    #[test]
    fn custom_types_persist_per_project_and_round_trip() {
        let dir = TempDir::new().unwrap();
        assert!(load_custom(dir.path()).unwrap().is_empty());
        save(dir.path(), custom("vehicle")).unwrap();
        let mut changed = custom("vehicle");
        changed.name = "Craft".into();
        save(dir.path(), changed).unwrap();
        save(dir.path(), custom("creature")).unwrap();

        let loaded = load_custom(dir.path()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(
            loaded.iter().find(|t| t.id == "vehicle").unwrap().name,
            "Craft"
        );
        assert!(types_path(dir.path()).is_file());
        assert!(!types_path(dir.path())
            .with_extension("json.kaava-tmp")
            .exists());

        let (everything, problem) = all(dir.path());
        assert!(problem.is_none());
        assert_eq!(everything.len(), builtins().len() + 2);
        assert!(everything[..5].iter().all(|t| t.builtin));

        assert!(delete(dir.path(), "vehicle").unwrap());
        assert!(!delete(dir.path(), "vehicle").unwrap());
        assert_eq!(load_custom(dir.path()).unwrap().len(), 1);
        assert!(delete(dir.path(), "model").is_err());
    }

    #[test]
    fn built_ins_are_not_in_the_file_and_a_hand_written_shadow_is_ignored() {
        let dir = TempDir::new().unwrap();
        save(dir.path(), custom("vehicle")).unwrap();
        let raw = std::fs::read_to_string(types_path(dir.path())).unwrap();
        assert!(!raw.contains("\"feature\"") && !raw.contains("builtin"));

        let doc = json!({ "schema": 1, "types": [custom("model"), custom("ok")] });
        std::fs::write(types_path(dir.path()), doc.to_string()).unwrap();
        let loaded = load_custom(dir.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "ok");
    }

    #[test]
    fn a_corrupt_types_file_is_an_error_and_is_not_overwritten() {
        let dir = TempDir::new().unwrap();
        let path = types_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ nope").unwrap();
        assert!(save(dir.path(), custom("vehicle")).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ nope");
        let (everything, problem) = all(dir.path());
        assert_eq!(everything.len(), builtins().len());
        assert!(problem.is_some());
    }

    #[test]
    fn ids_come_from_names() {
        assert_eq!(id_from_name("Hospital Bed!"), "hospital-bed");
        assert_eq!(id_from_name("3D prop"), "t-3d-prop");
    }
}
