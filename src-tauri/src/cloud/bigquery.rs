//! What Google has actually billed this month, from the Cloud Billing export
//! to BigQuery: the other half of the Cost Tracker, beside its estimate.
//!
//! The export has to be switched on once in the Console, into the dataset
//! [`dataset`] names. Until it is, the answer is [`Billed::NotEnabled`], which
//! the page draws as the setup step rather than as an error. The export lags
//! by hours, so the figure trails the estimate; `exportedAt` says by how much.
//!
//! One read: find the standard usage-cost table, then one parameterized query
//! summing this invoice month by service. Fixtures are
//! `bigquery/tables.json` (a `tables.list` answer) and `bigquery/billing.json`
//! (a `jobs.query` answer); with no tables file, the export is not enabled.

use super::{fixture_json, get_json, http, rfc3339, Cloud, Result, Source, Trouble};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Where the Console is told to write the export. `KAAVA_BILLING_DATASET` overrides it.
pub const DEFAULT_DATASET: &str = "billing_export";

/// The standard usage-cost table's name, before the billing account id. The
/// detailed export (`gcp_billing_export_resource_v1_`) does not match it.
const TABLE_PREFIX: &str = "gcp_billing_export_v1_";

/// How long BigQuery may take before answering; under `http`'s own 20 s.
const QUERY_TIMEOUT_MS: u32 = 15_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Billed {
    #[serde(rename_all = "camelCase")]
    Ok {
        table: String,
        /// `202609`, the export's own `invoice.month`.
        invoice_month: String,
        currency: String,
        cost: f64,
        /// Negative, as the export writes them.
        credits: f64,
        net: f64,
        /// The newest `export_time` in the month, if any row has arrived.
        exported_at: Option<String>,
        services: Vec<ServiceCost>,
    },
    /// No export table in the dataset, or no dataset at all.
    NotEnabled { dataset: String },
    /// The export exists but could not be read; the rest of the page still can.
    Unavailable { message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServiceCost {
    pub service: String,
    pub cost: f64,
    pub credits: f64,
    pub net: f64,
}

pub fn dataset() -> String {
    std::env::var("KAAVA_BILLING_DATASET")
        .ok()
        .filter(|d| is_identifier(d))
        .unwrap_or_else(|| DEFAULT_DATASET.to_string())
}

/// Google's answer when the BigQuery API is off in the project: a 400 or 403
/// whose text names it. That is the same setup step as a missing export, so
/// it is not drawn as an error.
fn api_disabled(trouble: &Trouble) -> bool {
    let detail = match trouble {
        Trouble::Api { detail, .. } | Trouble::Denied { detail } => detail,
        _ => return false,
    };
    [
        "has not enabled BigQuery",
        "SERVICE_DISABLED",
        "BigQuery API has not been used",
    ]
    .iter()
    .any(|needle| detail.contains(needle))
}

/// `202609` for the month that starts at `month_start`.
pub fn invoice_month(month_start: i64) -> String {
    let text = rfc3339(month_start);
    format!("{}{}", &text[0..4], &text[5..7])
}

/// This month's billed cost. A signed-out `gcloud` is still an `Err`, so the
/// caller can treat it like every other read; anything else past the table
/// lookup becomes [`Billed::Unavailable`].
pub fn billed(cloud: &Cloud, source: &Source, month_start: i64) -> Result<Billed> {
    let dataset = dataset();
    let table = match find_table(cloud, source, &dataset) {
        Ok(Some(table)) => table,
        Ok(None) | Err(Trouble::Missing { .. }) => return Ok(Billed::NotEnabled { dataset }),
        Err(trouble) if api_disabled(&trouble) => return Ok(Billed::NotEnabled { dataset }),
        Err(trouble) => return Err(trouble),
    };
    let month = invoice_month(month_start);
    let answer = match source {
        Source::Fixture { root } => fixture_json(root, "bigquery/billing.json")?,
        Source::Live { project } => {
            let body = request(project, &dataset, &table, &month).to_string();
            let url = format!(
                "https://bigquery.googleapis.com/bigquery/v2/projects/{}/queries",
                http::encode(project)
            );
            let reply = http::send(
                &cloud.tokens,
                http::Verb::PostJson(body),
                &url,
                "the billing export query",
                None,
                4 << 20,
            )?;
            serde_json::from_slice(&reply.body).map_err(|e| Trouble::Api {
                status: 200,
                detail: format!("unreadable BigQuery answer: {e}"),
            })?
        }
    };
    Ok(summarise(table, month, &answer))
}

/// BigQuery names: letters, digits and underscores. Anything else is refused
/// before it is spliced into SQL, where a table name cannot be a parameter.
fn is_identifier(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Project ids: lower-case letters, digits and hyphens.
fn is_project_id(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Default, Deserialize)]
struct TableList {
    #[serde(default)]
    tables: Vec<TableEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableEntry {
    table_reference: TableReference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableReference {
    table_id: String,
}

fn find_table(cloud: &Cloud, source: &Source, dataset: &str) -> Result<Option<String>> {
    let list: TableList = match source {
        Source::Fixture { root } => fixture_json(root, "bigquery/tables.json")?,
        Source::Live { project } => get_json(
            cloud,
            &format!(
                "https://bigquery.googleapis.com/bigquery/v2/projects/{}/datasets/{}/tables?maxResults=1000",
                http::encode(project),
                http::encode(dataset)
            ),
            &format!("dataset {dataset}"),
            4 << 20,
        )?,
    };
    Ok(pick_table(
        list.tables.into_iter().map(|t| t.table_reference.table_id),
    ))
}

/// The standard export table, the first by name if several accounts export here.
fn pick_table(ids: impl Iterator<Item = String>) -> Option<String> {
    ids.filter(|id| id.starts_with(TABLE_PREFIX) && is_identifier(id))
        .min()
}

/// The `jobs.query` body. Month and project travel as parameters; only the
/// table's own name is spliced, and only after [`is_identifier`].
fn request(project: &str, dataset: &str, table: &str, month: &str) -> Value {
    let from = if is_project_id(project) && is_identifier(dataset) && is_identifier(table) {
        format!("`{project}.{dataset}.{table}`")
    } else {
        // Unreachable from `billed`, which only passes checked names; a query
        // that fails is still better than one that splices something else.
        "`invalid`".to_string()
    };
    let sql = format!(
        "SELECT service.description AS service, SUM(cost) AS cost, \
         SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits, \
         ANY_VALUE(currency) AS currency, MAX(export_time) AS exported \
         FROM {from} WHERE invoice.month = @month AND project.id = @project \
         GROUP BY service ORDER BY cost DESC"
    );
    let param = |name: &str, value: &str| {
        json!({
            "name": name,
            "parameterType": { "type": "STRING" },
            "parameterValue": { "value": value },
        })
    };
    json!({
        "query": sql,
        "useLegacySql": false,
        "timeoutMs": QUERY_TIMEOUT_MS,
        "parameterMode": "NAMED",
        "queryParameters": [param("month", month), param("project", project)],
    })
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryAnswer {
    #[serde(default)]
    job_complete: bool,
    #[serde(default)]
    schema: Schema,
    #[serde(default)]
    rows: Vec<Row>,
}

#[derive(Default, Deserialize)]
struct Schema {
    #[serde(default)]
    fields: Vec<Field>,
}

#[derive(Deserialize)]
struct Field {
    name: String,
}

#[derive(Deserialize)]
struct Row {
    f: Vec<Cell>,
}

#[derive(Deserialize)]
struct Cell {
    v: Value,
}

/// BigQuery sends every scalar as a string; a TIMESTAMP is epoch seconds.
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn summarise(table: String, invoice_month: String, answer: &QueryAnswer) -> Billed {
    if !answer.job_complete {
        return Billed::Unavailable {
            message: "BigQuery did not finish the query in time; the next refresh tries again."
                .into(),
        };
    }
    let column = |name: &str| answer.schema.fields.iter().position(|f| f.name == name);
    let (service, cost, credits, currency, exported) = (
        column("service"),
        column("cost"),
        column("credits"),
        column("currency"),
        column("exported"),
    );
    fn cell(row: &Row, at: Option<usize>) -> Option<&Value> {
        at.and_then(|i| row.f.get(i)).map(|c| &c.v)
    }

    let mut services = Vec::new();
    let mut currency_seen: Option<String> = None;
    let mut newest: Option<f64> = None;
    for row in &answer.rows {
        let cost = cell(row, cost).and_then(number).unwrap_or(0.0);
        let credits = cell(row, credits).and_then(number).unwrap_or(0.0);
        services.push(ServiceCost {
            service: cell(row, service)
                .and_then(Value::as_str)
                .unwrap_or("Unnamed service")
                .to_string(),
            cost,
            credits,
            net: cost + credits,
        });
        if let Some(c) = cell(row, currency).and_then(Value::as_str) {
            currency_seen.get_or_insert_with(|| c.to_string());
        }
        if let Some(t) = cell(row, exported).and_then(number) {
            newest = Some(newest.map_or(t, |n| n.max(t)));
        }
    }
    let cost: f64 = services.iter().map(|s| s.cost).sum();
    let credits: f64 = services.iter().map(|s| s.credits).sum();
    Billed::Ok {
        table,
        invoice_month,
        currency: currency_seen.unwrap_or_else(|| "USD".into()),
        cost,
        credits,
        net: cost + credits,
        exported_at: newest.map(|t| rfc3339(t as i64)),
        services,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures() -> Source {
        Source::Fixture {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/cloud"),
        }
    }

    #[test]
    fn the_invoice_month_is_year_and_month() {
        let start = super::super::parse_rfc3339("2026-09-01T00:00:00Z").unwrap();
        assert_eq!(invoice_month(start), "202609");
    }

    #[test]
    fn only_the_standard_export_table_is_picked() {
        let ids = [
            "gcp_billing_export_resource_v1_0123",
            "gcp_billing_export_v1_B",
            "gcp_billing_export_v1_A",
            "cloud_pricing_export",
        ];
        assert_eq!(
            pick_table(ids.iter().map(|s| s.to_string())).as_deref(),
            Some("gcp_billing_export_v1_A")
        );
        assert_eq!(pick_table(std::iter::empty()), None);
    }

    #[test]
    fn month_and_project_are_parameters_not_sql() {
        let body = request(
            "veistra-prod",
            "billing_export",
            "gcp_billing_export_v1_X",
            "202609",
        );
        let sql = body["query"].as_str().unwrap();
        assert!(sql.contains("`veistra-prod.billing_export.gcp_billing_export_v1_X`"));
        assert!(sql.contains("@month") && !sql.contains("202609"));
        assert_eq!(
            body["queryParameters"][0]["parameterValue"]["value"],
            "202609"
        );
        assert_eq!(
            body["queryParameters"][1]["parameterValue"]["value"],
            "veistra-prod"
        );
    }

    #[test]
    fn a_name_that_is_not_an_identifier_is_never_spliced() {
        let body = request(
            "veistra-prod",
            "x`; DROP",
            "gcp_billing_export_v1_X",
            "202609",
        );
        let sql = body["query"].as_str().unwrap();
        assert!(!sql.contains("DROP"));
        assert!(!is_identifier("a.b") && !is_identifier("") && is_identifier("billing_export"));
    }

    #[test]
    fn the_fixture_sums_cost_and_credits_by_service() {
        let start = super::super::parse_rfc3339("2026-09-01T00:00:00Z").unwrap();
        let billed = billed(&Cloud::default(), &fixtures(), start).unwrap();
        let Billed::Ok {
            invoice_month,
            cost,
            credits,
            net,
            exported_at,
            services,
            ..
        } = billed
        else {
            panic!("expected Ok, got {billed:?}");
        };
        assert_eq!(invoice_month, "202609");
        assert!(credits < 0.0);
        assert!((net - (cost + credits)).abs() < 1e-9);
        assert_eq!(services[0].service, "Compute Engine");
        assert!(exported_at.is_some());
    }

    #[test]
    fn no_export_table_means_not_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let source = Source::Fixture {
            root: dir.path().to_path_buf(),
        };
        assert_eq!(
            billed(&Cloud::default(), &source, 0).unwrap(),
            Billed::NotEnabled {
                dataset: DEFAULT_DATASET.into()
            }
        );
    }

    #[test]
    fn a_disabled_bigquery_api_is_the_setup_step_not_an_error() {
        assert!(api_disabled(&Trouble::Api {
            status: 400,
            detail: "project veistra-prod has not enabled BigQuery.".into(),
        }));
        assert!(api_disabled(&Trouble::Denied {
            detail: "reason: SERVICE_DISABLED".into(),
        }));
        assert!(!api_disabled(&Trouble::Api {
            status: 500,
            detail: "backend error".into(),
        }));
        assert!(!api_disabled(&Trouble::Unreachable {
            detail: "has not enabled BigQuery".into(),
        }));
    }

    #[test]
    fn an_unfinished_query_is_unavailable_rather_than_zero() {
        let answer = QueryAnswer::default();
        assert!(matches!(
            summarise("t".into(), "202609".into(), &answer),
            Billed::Unavailable { .. }
        ));
    }
}
