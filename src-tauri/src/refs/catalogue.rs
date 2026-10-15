//! The components an agent puts in front of the person with `show` and
//! `show_component`, and the props each one draws from
//! (`docs/design/KAAVA-CONTEXT-REFS.md` §6).
//!
//! These types are the only definition. The agent tab's TypeScript is
//! generated from them into `apps/agent-tab/ui/src/kaava-show.generated.ts`,
//! and the test at the bottom of this file fails when the two disagree.
//!
//! Every limit is a promise to the tab: props that pass [`Component::parse`]
//! fit the layouts it draws, so it need not check them again. Text named
//! `body` or `detail` is markdown; every other string is plain text.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The version every component's props are at.
pub const VERSION: u32 = 1;
/// The components, by the name an agent calls them.
pub const NAMES: &[&str] = &[
    "refs", "callout", "steps", "table", "compare", "diagram", "chart", "choice",
];
/// Most JSON the props may take as sent, which is also the most the agent
/// host lifts off a tool result.
pub const MAX_PROPS_BYTES: usize = 64 * 1024;
/// Most references a `refs` component or a callout shows.
pub const MAX_SHOWN: usize = 8;
/// Most references on one step or one compared item.
const MAX_ITEM_REFS: usize = 4;
/// Most references in one component, every list counted: each is checked.
const MAX_REFS: usize = 24;
const MAX_TITLE: usize = 200;
const MAX_CAPTION: usize = 500;
const MAX_BODY: usize = 4_000;
const MAX_LIST_ITEM: usize = 300;
const MAX_CELL: usize = 500;
const MAX_SOURCE: usize = 20_000;
const MAX_STEPS: usize = 20;
const MAX_COLUMNS: usize = 12;
const MAX_ROWS: usize = 200;
const MAX_COMPARED: usize = 4;
const MAX_LIST: usize = 8;
const MAX_X: usize = 100;
const MAX_SERIES: usize = 8;
const MAX_POINTS: usize = 800;
const MAX_OPTIONS: usize = 8;
const MAX_ID: usize = 64;

/// The marker on a tool result, which the agent host lifts off for the tab:
/// `{version, component, props}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct KaavaShow {
    pub version: u32,
    #[serde(flatten)]
    pub shown: Component,
}

/// What the tab draws, by name, with the props it draws from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "component", content = "props", rename_all = "camelCase")]
pub enum Component {
    /// References drawn as chips: what `show` sends.
    Refs(RefsProps),
    Callout(CalloutProps),
    Steps(StepsProps),
    Table(TableProps),
    Compare(CompareProps),
    Diagram(DiagramProps),
    Chart(ChartProps),
    Choice(ChoiceProps),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefsProps {
    /// `kaava://` references, in the order they are drawn.
    pub refs: Vec<String>,
    /// One line above them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalloutProps {
    pub tone: Tone,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body: String,
    #[serde(default)]
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Note,
    Tip,
    Warning,
    Danger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepsProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<StepStatus>,
    #[serde(default)]
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Todo,
    Doing,
    Done,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    pub columns: Vec<Column>,
    /// One cell per column in every row.
    pub rows: Vec<Vec<Option<Cell>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Column {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Left,
    Right,
    Center,
}

/// A table cell. A number is always finite, because JSON has no other kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(untagged)]
pub enum Cell {
    Text(String),
    Number(f64),
    Flag(bool),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompareProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub items: Vec<Compared>,
    /// The index of the item the agent recommends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Compared {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default)]
    pub pros: Vec<String>,
    #[serde(default)]
    pub cons: Vec<String>,
    #[serde(default)]
    pub refs: Vec<String>,
}

/// A diagram drawn from text. A canvas frame is a `refs` chip instead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagramProps {
    pub format: DiagramFormat,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum DiagramFormat {
    Mermaid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartProps {
    #[serde(rename = "type")]
    pub kind: ChartKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub x_labels: Vec<String>,
    /// Each with one value per x label.
    pub series: Vec<Series>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ChartKind {
    Bar,
    Line,
    Area,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Series {
    pub name: String,
    pub values: Vec<f64>,
}

/// A question for the person. Their pick comes back as an ordinary message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChoiceProps {
    pub question: String,
    pub options: Vec<ChoiceOption>,
    /// Whether they may pick more than one.
    #[serde(default)]
    pub multiple: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChoiceOption {
    /// Letters, digits, `_` and `-`, unique within the choice.
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Component {
    /// Props as an agent sent them, held to the catalogue: a known component,
    /// every field of the right type, every limit kept. The error names the
    /// field, such as `steps[2].title`.
    pub fn parse(name: &str, props: &Value) -> Result<Self, String> {
        let size = props.to_string().len();
        if size > MAX_PROPS_BYTES {
            return Err(format!(
                "the props are {} KB of JSON; at most {} KB",
                size.div_ceil(1024),
                MAX_PROPS_BYTES / 1024
            ));
        }
        let mut shown = match name {
            "refs" => Self::Refs(props_of(props)?),
            "callout" => Self::Callout(props_of(props)?),
            "steps" => Self::Steps(props_of(props)?),
            "table" => Self::Table(props_of(props)?),
            "compare" => Self::Compare(props_of(props)?),
            "diagram" => Self::Diagram(props_of(props)?),
            "chart" => Self::Chart(props_of(props)?),
            "choice" => Self::Choice(props_of(props)?),
            other => {
                let all = NAMES.join(", ");
                return Err(format!("`{other}` is not a component; use {all}"));
            }
        };
        shown.check()?;
        let refs: usize = shown.refs_mut().iter().map(|list| list.len()).sum();
        if refs > MAX_REFS {
            return Err(format!(
                "the props hold {refs} references; at most {MAX_REFS}"
            ));
        }
        Ok(shown)
    }

    /// Every list of references in the props, for the server to check each
    /// one and drop those that cannot be shown.
    pub fn refs_mut(&mut self) -> Vec<&mut Vec<String>> {
        match self {
            Self::Refs(p) => vec![&mut p.refs],
            Self::Callout(p) => vec![&mut p.refs],
            Self::Steps(p) => p.steps.iter_mut().map(|s| &mut s.refs).collect(),
            Self::Compare(p) => p.items.iter_mut().map(|i| &mut i.refs).collect(),
            Self::Table(_) | Self::Diagram(_) | Self::Chart(_) | Self::Choice(_) => Vec::new(),
        }
    }

    /// The limits the types cannot say.
    pub fn check(&self) -> Result<(), String> {
        match self {
            Self::Refs(p) => {
                count("refs", p.refs.len(), 1, MAX_SHOWN)?;
                maybe_words("caption", &p.caption, MAX_CAPTION)
            }
            Self::Callout(p) => {
                maybe_words("title", &p.title, MAX_TITLE)?;
                words("body", &p.body, MAX_BODY)?;
                count("refs", p.refs.len(), 0, MAX_SHOWN)
            }
            Self::Steps(p) => {
                maybe_words("title", &p.title, MAX_TITLE)?;
                count("steps", p.steps.len(), 1, MAX_STEPS)?;
                for (i, step) in p.steps.iter().enumerate() {
                    let at = |field: &str| format!("steps[{i}].{field}");
                    words(&at("title"), &step.title, MAX_TITLE)?;
                    maybe_words(&at("body"), &step.body, MAX_BODY)?;
                    count(&at("refs"), step.refs.len(), 0, MAX_ITEM_REFS)?;
                }
                Ok(())
            }
            Self::Table(p) => check_table(p),
            Self::Compare(p) => check_compare(p),
            Self::Diagram(p) => {
                maybe_words("title", &p.title, MAX_TITLE)?;
                words("source", &p.source, MAX_SOURCE)
            }
            Self::Chart(p) => check_chart(p),
            Self::Choice(p) => check_choice(p),
        }
    }
}

fn check_table(p: &TableProps) -> Result<(), String> {
    maybe_words("caption", &p.caption, MAX_CAPTION)?;
    count("columns", p.columns.len(), 1, MAX_COLUMNS)?;
    for (i, column) in p.columns.iter().enumerate() {
        words(&format!("columns[{i}].label"), &column.label, MAX_TITLE)?;
    }
    count("rows", p.rows.len(), 1, MAX_ROWS)?;
    for (i, row) in p.rows.iter().enumerate() {
        if row.len() != p.columns.len() {
            return Err(format!(
                "`rows[{i}]` has {} cells; every row has one per column, {}",
                row.len(),
                p.columns.len()
            ));
        }
        for (j, cell) in row.iter().enumerate() {
            if let Some(Cell::Text(text)) = cell {
                length(&format!("rows[{i}][{j}]"), text, MAX_CELL)?;
            }
        }
    }
    Ok(())
}

fn check_compare(p: &CompareProps) -> Result<(), String> {
    maybe_words("title", &p.title, MAX_TITLE)?;
    count("items", p.items.len(), 2, MAX_COMPARED)?;
    for (i, item) in p.items.iter().enumerate() {
        let at = |field: &str| format!("items[{i}].{field}");
        words(&at("title"), &item.title, MAX_TITLE)?;
        maybe_words(&at("body"), &item.body, MAX_BODY)?;
        for (field, list) in [("pros", &item.pros), ("cons", &item.cons)] {
            count(&at(field), list.len(), 0, MAX_LIST)?;
            for (j, line) in list.iter().enumerate() {
                words(&format!("{}[{j}]", at(field)), line, MAX_LIST_ITEM)?;
            }
        }
        count(&at("refs"), item.refs.len(), 0, MAX_ITEM_REFS)?;
    }
    match p.recommended {
        Some(n) if n as usize >= p.items.len() => Err(format!(
            "`recommended` is {n}, but the items are numbered from 0 to {}",
            p.items.len() - 1
        )),
        _ => Ok(()),
    }
}

fn check_chart(p: &ChartProps) -> Result<(), String> {
    maybe_words("title", &p.title, MAX_TITLE)?;
    maybe_words("yLabel", &p.y_label, MAX_TITLE)?;
    count("xLabels", p.x_labels.len(), 1, MAX_X)?;
    for (i, label) in p.x_labels.iter().enumerate() {
        length(&format!("xLabels[{i}]"), label, MAX_TITLE)?;
    }
    count("series", p.series.len(), 1, MAX_SERIES)?;
    for (i, series) in p.series.iter().enumerate() {
        words(&format!("series[{i}].name"), &series.name, MAX_TITLE)?;
        if series.values.len() != p.x_labels.len() {
            return Err(format!(
                "`series[{i}].values` has {} values; it needs one per x label, {}",
                series.values.len(),
                p.x_labels.len()
            ));
        }
    }
    let points = p.series.len() * p.x_labels.len();
    if points > MAX_POINTS {
        return Err(format!(
            "the chart has {points} points; at most {MAX_POINTS}"
        ));
    }
    Ok(())
}

fn check_choice(p: &ChoiceProps) -> Result<(), String> {
    words("question", &p.question, MAX_CAPTION)?;
    count("options", p.options.len(), 2, MAX_OPTIONS)?;
    for (i, option) in p.options.iter().enumerate() {
        let at = |field: &str| format!("options[{i}].{field}");
        let id = &option.id;
        let fits = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
        if id.is_empty() || id.len() > MAX_ID || !id.chars().all(fits) {
            return Err(format!(
                "`{}` is `{id}`; an id is 1 to {MAX_ID} letters, digits, `_` or `-`",
                at("id")
            ));
        }
        if p.options[..i].iter().any(|o| o.id == *id) {
            return Err(format!("`{}` repeats `{id}`; ids are unique", at("id")));
        }
        words(&at("label"), &option.label, MAX_TITLE)?;
        maybe_words(&at("detail"), &option.detail, MAX_BODY)?;
    }
    Ok(())
}

/// One component's props from JSON, or an error naming the field at fault.
fn props_of<T: DeserializeOwned>(props: &Value) -> Result<T, String> {
    serde_path_to_error::deserialize(props).map_err(|e| match e.path().to_string() {
        at if at == "." => e.inner().to_string(),
        at => format!("`{at}`: {}", e.inner()),
    })
}

/// Text that is not blank and not over `max` characters.
fn words(at: &str, text: &str, max: usize) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(format!("`{at}` is empty; leave it out or say something"));
    }
    length(at, text, max)
}

fn maybe_words(at: &str, text: &Option<String>, max: usize) -> Result<(), String> {
    text.as_deref().map_or(Ok(()), |text| words(at, text, max))
}

fn length(at: &str, text: &str, max: usize) -> Result<(), String> {
    match text.chars().count() {
        n if n > max => Err(format!("`{at}` is {n} characters; at most {max}")),
        _ => Ok(()),
    }
}

fn count(at: &str, n: usize, min: usize, max: usize) -> Result<(), String> {
    if n < min {
        Err(format!("`{at}` holds {n}; it needs at least {min}"))
    } else if n > max {
        Err(format!("`{at}` holds {n}; at most {max}"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::resolve::{Part, Resolved};
    use serde_json::json;
    use ts_rs::{Config, TS};

    fn parse(name: &str, props: Value) -> Result<Component, String> {
        Component::parse(name, &props)
    }

    fn refused(name: &str, props: Value) -> String {
        parse(name, props).unwrap_err()
    }

    #[test]
    fn every_component_is_drawn_from_the_marker_the_tab_reads() {
        let shown = parse("callout", json!({ "tone": "tip", "body": "Use **bold**." })).unwrap();
        let marker = serde_json::to_value(KaavaShow {
            version: VERSION,
            shown,
        })
        .unwrap();
        assert_eq!(
            marker,
            json!({
                "version": 1,
                "component": "callout",
                "props": { "tone": "tip", "body": "Use **bold**.", "refs": [] },
            })
        );
    }

    #[test]
    fn every_name_parses_and_none_is_left_out() {
        let samples = [
            ("refs", json!({ "refs": ["kaava://selection"] })),
            ("callout", json!({ "tone": "note", "body": "b" })),
            ("steps", json!({ "steps": [{ "title": "t" }] })),
            (
                "table",
                json!({ "columns": [{ "label": "a" }], "rows": [[1], ["x"], [true], [null]] }),
            ),
            (
                "compare",
                json!({ "items": [{ "title": "a" }, { "title": "b" }], "recommended": 1 }),
            ),
            (
                "diagram",
                json!({ "format": "mermaid", "source": "graph TD; A-->B" }),
            ),
            (
                "chart",
                json!({ "type": "bar", "xLabels": ["a"], "series": [{ "name": "n", "values": [2.5] }] }),
            ),
            (
                "choice",
                json!({ "question": "q", "options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B" }] }),
            ),
        ];
        let names: Vec<&str> = samples.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, NAMES);
        for (name, props) in samples {
            let shown = parse(name, props.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            let tagged = serde_json::to_value(&shown).unwrap();
            assert_eq!(tagged["component"], name);
        }
        assert!(refused("graph", json!({})).contains("callout, steps"));
    }

    #[test]
    fn a_malformed_prop_is_refused_by_where_it_is() {
        let step = |status: &str| json!({ "steps": [{ "title": "a" }, { "title": "b", "status": status }] });
        let wrong = refused("steps", step("blocked"));
        assert!(wrong.starts_with("`steps[1].status`"), "{wrong}");
        assert!(wrong.contains("blocked"), "{wrong}");
        let extra = refused(
            "callout",
            json!({ "tone": "note", "body": "b", "colour": "red" }),
        );
        assert!(extra.contains("unknown field `colour`"), "{extra}");
        let missing = refused("callout", json!({ "tone": "note" }));
        assert!(missing.contains("missing field `body`"), "{missing}");
        let blank = refused("steps", json!({ "steps": [{ "title": "  " }] }));
        assert!(blank.starts_with("`steps[0].title` is empty"), "{blank}");
        assert!(refused("refs", json!(["kaava://selection"])).contains("invalid type"));
    }

    #[test]
    fn every_limit_is_counted_in_characters_and_named() {
        let title = "é".repeat(MAX_TITLE);
        assert!(parse(
            "diagram",
            json!({ "format": "mermaid", "source": "s", "title": title })
        )
        .is_ok());
        let over = refused(
            "diagram",
            json!({ "format": "mermaid", "source": "s", "title": title + "x" }),
        );
        assert_eq!(over, "`title` is 201 characters; at most 200");
        let nine = vec!["kaava://selection"; MAX_SHOWN + 1];
        assert_eq!(
            refused("refs", json!({ "refs": nine })),
            "`refs` holds 9; at most 8"
        );
        assert_eq!(
            refused("refs", json!({ "refs": [] })),
            "`refs` holds 0; it needs at least 1"
        );
        let big = "x".repeat(MAX_PROPS_BYTES);
        let size = refused("callout", json!({ "tone": "note", "body": big }));
        assert!(size.starts_with("the props are 65 KB"), "{size}");
    }

    #[test]
    fn references_are_capped_across_every_list() {
        let step = || json!({ "title": "t", "refs": vec!["kaava://selection"; MAX_ITEM_REFS] });
        let steps = |n: usize| json!({ "steps": vec![step(); n] });
        assert!(parse("steps", steps(MAX_REFS / MAX_ITEM_REFS)).is_ok());
        let over = refused("steps", steps(MAX_REFS / MAX_ITEM_REFS + 1));
        assert_eq!(over, "the props hold 28 references; at most 24");
        let mut shown = parse("steps", steps(2)).unwrap();
        assert_eq!(shown.refs_mut().len(), 2);
    }

    #[test]
    fn a_table_has_one_cell_per_column_in_every_row() {
        let table =
            |rows: Value| json!({ "columns": [{ "label": "a" }, { "label": "b" }], "rows": rows });
        assert!(parse("table", table(json!([[1, null], ["x", false]]))).is_ok());
        let short = refused("table", table(json!([[1, 2], [3]])));
        assert_eq!(
            short,
            "`rows[1]` has 1 cells; every row has one per column, 2"
        );
        let long = refused("table", table(json!([[1, "x".repeat(MAX_CELL + 1)]])));
        assert!(long.starts_with("`rows[0][1]` is 501"), "{long}");
        let object = refused("table", table(json!([[1, { "a": 1 }]])));
        assert!(object.starts_with("`rows[0][1]`"), "{object}");
    }

    #[test]
    fn a_chart_has_one_value_per_label_and_a_bounded_number_of_points() {
        let chart = |labels: usize, values: usize, series: usize| {
            let one = json!({ "name": "n", "values": vec![1.0; values] });
            json!({ "type": "line", "xLabels": vec!["x"; labels], "series": vec![one; series] })
        };
        assert!(parse("chart", chart(100, 100, 8)).is_ok());
        let ragged = refused("chart", chart(3, 2, 1));
        assert_eq!(
            ragged,
            "`series[0].values` has 2 values; it needs one per x label, 3"
        );
        assert_eq!(
            refused("chart", chart(101, 101, 1)),
            "`xLabels` holds 101; at most 100"
        );
        let mut many = chart(100, 100, 8);
        many["series"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "name": "n", "values": vec![1.0; 100] }));
        assert_eq!(refused("chart", many), "`series` holds 9; at most 8");
    }

    #[test]
    fn a_choice_has_distinct_well_formed_ids() {
        let choice = |a: &str, b: &str| json!({ "question": "Which?", "options": [{ "id": a, "label": "A" }, { "id": b, "label": "B" }] });
        assert!(parse("choice", choice("keep-it", "drop_2")).is_ok());
        let same = refused("choice", choice("a", "a"));
        assert_eq!(same, "`options[1].id` repeats `a`; ids are unique");
        let spaced = refused("choice", choice("a b", "c"));
        assert!(spaced.starts_with("`options[0].id` is `a b`"), "{spaced}");
        assert!(refused("choice", choice("", "c")).starts_with("`options[0].id` is ``"));
    }

    #[test]
    fn a_comparison_recommends_one_of_its_items() {
        let compare = |n: u32| json!({ "items": [{ "title": "a", "pros": ["fast"] }, { "title": "b" }], "recommended": n });
        assert!(parse("compare", compare(1)).is_ok());
        let past = refused("compare", compare(2));
        assert_eq!(
            past,
            "`recommended` is 2, but the items are numbered from 0 to 1"
        );
        let blank = json!({ "items": [{ "title": "a", "cons": [""] }, { "title": "b" }] });
        assert!(refused("compare", blank).starts_with("`items[0].cons[0]` is empty"));
    }

    /// Every type the tab reads, in the order the file declares them.
    fn generated() -> String {
        let cfg = Config::new().with_large_int("number");
        let decls = [
            KaavaShow::decl(&cfg),
            Component::decl(&cfg),
            RefsProps::decl(&cfg),
            CalloutProps::decl(&cfg),
            Tone::decl(&cfg),
            StepsProps::decl(&cfg),
            Step::decl(&cfg),
            StepStatus::decl(&cfg),
            TableProps::decl(&cfg),
            Column::decl(&cfg),
            Align::decl(&cfg),
            Cell::decl(&cfg),
            CompareProps::decl(&cfg),
            Compared::decl(&cfg),
            DiagramProps::decl(&cfg),
            DiagramFormat::decl(&cfg),
            ChartProps::decl(&cfg),
            ChartKind::decl(&cfg),
            Series::decl(&cfg),
            ChoiceProps::decl(&cfg),
            ChoiceOption::decl(&cfg),
            Resolved::decl(&cfg),
            Part::decl(&cfg),
        ];
        let mut out = String::from(
            "// Generated from src-tauri/src/refs/catalogue.rs and resolve.rs by ts-rs. Do not edit.\n\
             // Regenerate: KAAVA_BLESS=1 cargo test --lib refs::catalogue::tests::generated\n\n",
        );
        for decl in decls {
            out.push_str("export ");
            out.push_str(&decl);
            out.push_str("\n\n");
        }
        out.truncate(out.trim_end().len());
        out.push('\n');
        out
    }

    /// Resolved at run time: a target directory shared between worktrees can
    /// hold a test binary compiled in another checkout.
    fn generated_path() -> std::path::PathBuf {
        let crate_dir = std::env::var("CARGO_MANIFEST_DIR")
            .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string());
        std::path::Path::new(&crate_dir).join("../apps/agent-tab/ui/src/kaava-show.generated.ts")
    }

    #[test]
    fn generated_types_match_the_checked_in_file() {
        let path = generated_path();
        let want = generated();
        if std::env::var("KAAVA_BLESS").as_deref() == Ok("1") {
            std::fs::write(&path, &want).unwrap();
        }
        let have = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert!(
            have == want,
            "{} is stale. Regenerate it with:\n  KAAVA_BLESS=1 cargo test --lib refs::catalogue::tests::generated",
            path.display()
        );
    }
}
