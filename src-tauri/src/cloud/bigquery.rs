//! What Google has actually billed, from the Cloud Billing export to
//! BigQuery: the other half of the Cost Tracker, beside its estimate.
//! [`billed`] answers this invoice month's total by service; [`trends`]
//! answers the daily and monthly series behind the Cost Tracker's charts
//! C4–C6 (`docs/design/COST-TRACKER-CHARTS.md`).
//!
//! The export has to be switched on once in the Console, into the dataset
//! [`dataset`] names. Until it is, both answers say so ([`Billed::NotEnabled`],
//! [`Trends::NotEnabled`]) rather than drawing an error. The export lags by
//! hours, so the figures trail the estimate; `exportedAt` says by how much.
//!
//! Every read starts the same way: find the standard usage-cost table, then
//! run one parameterized query. Fixtures are `bigquery/tables.json` (a
//! `tables.list` answer), `bigquery/billing.json`, `bigquery/daily.json` and
//! `bigquery/monthly.json` (each a `jobs.query` answer); with no tables file,
//! the export is not enabled.

use super::{
    days_from_civil, fixture_json, get_json, http, rfc3339, Cloud, Result, Source, Trouble,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Where the Console is told to write the export. `KAAVA_BILLING_DATASET` overrides it.
pub const DEFAULT_DATASET: &str = "billing_export";

/// The standard usage-cost table's name, before the billing account id. The
/// detailed export (`gcp_billing_export_resource_v1_`) does not match it.
const TABLE_PREFIX: &str = "gcp_billing_export_v1_";

/// How long BigQuery may take before answering; under `http`'s own 20 s.
const QUERY_TIMEOUT_MS: u32 = 15_000;

/// How many invoice months [`trends`] returns, the current one included.
const TRENDS_MONTHS: i64 = 6;

/// How far before the earliest month the partition filter reaches, so a
/// usage row that lands a few days late is not excluded.
const PARTITION_MARGIN_SECS: i64 = 3 * 86_400;

/// The message every `Unavailable` shares when BigQuery did not finish in time.
const UNFINISHED: &str = "BigQuery did not finish the query in time; the next refresh tries again.";

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

/// The daily and monthly series behind charts C4–C6. Same shape rules as
/// [`Billed`]: a missing table or a disabled BigQuery API is [`Trends::NotEnabled`],
/// a signed-out `gcloud` stays an `Err`, anything else past that is [`Trends::Unavailable`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Trends {
    #[serde(rename_all = "camelCase")]
    Ok {
        currency: String,
        /// This invoice month, by day and service — chart C4.
        daily: Vec<DailyCost>,
        /// The last [`TRENDS_MONTHS`] invoice months, oldest first — chart C5.
        monthly: Vec<MonthlyCost>,
        /// The newest `export_time` either query saw, if any row has arrived.
        exported_at: Option<String>,
    },
    NotEnabled {
        dataset: String,
    },
    Unavailable {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyCost {
    /// `2026-09-28`, the export's own `usage_start_time` date.
    pub day: String,
    pub service: String,
    pub net: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyCost {
    /// `202609`, the export's own `invoice.month`.
    pub month: String,
    pub net: f64,
    /// True for the current invoice month, which has not finished yet.
    pub partial: bool,
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

/// Whether the export has a table to query yet. Shared by [`billed`] and
/// [`trends`] so both treat a missing export, or a BigQuery API that is
/// simply off, as the same setup step rather than as an error.
enum Table {
    Found(String),
    NotEnabled,
}

fn locate_table(cloud: &Cloud, source: &Source, dataset: &str) -> Result<Table> {
    match find_table(cloud, source, dataset) {
        Ok(Some(table)) => Ok(Table::Found(table)),
        Ok(None) | Err(Trouble::Missing { .. }) => Ok(Table::NotEnabled),
        Err(trouble) if api_disabled(&trouble) => Ok(Table::NotEnabled),
        Err(trouble) => Err(trouble),
    }
}

/// One `jobs.query`, parsed. `what` names the query for the error a bad
/// answer would carry.
fn run_query(cloud: &Cloud, project: &str, body: &Value) -> Result<QueryAnswer> {
    let url = format!(
        "https://bigquery.googleapis.com/bigquery/v2/projects/{}/queries",
        http::encode(project)
    );
    let reply = http::send(
        &cloud.tokens,
        http::Verb::PostJson(body.to_string()),
        &url,
        "the billing export query",
        None,
        4 << 20,
    )?;
    serde_json::from_slice(&reply.body).map_err(|e| Trouble::Api {
        status: 200,
        detail: format!("unreadable BigQuery answer: {e}"),
    })
}

/// This month's billed cost. A signed-out `gcloud` is still an `Err`, so the
/// caller can treat it like every other read; anything else past the table
/// lookup becomes [`Billed::Unavailable`].
pub fn billed(cloud: &Cloud, source: &Source, month_start: i64) -> Result<Billed> {
    let dataset = dataset();
    let table = match locate_table(cloud, source, &dataset)? {
        Table::Found(table) => table,
        Table::NotEnabled => return Ok(Billed::NotEnabled { dataset }),
    };
    let month = invoice_month(month_start);
    let answer = match source {
        Source::Fixture { root } => fixture_json(root, "bigquery/billing.json")?,
        Source::Live { project } => {
            run_query(cloud, project, &request(project, &dataset, &table, &month))?
        }
    };
    Ok(summarise(table, month, &answer))
}

/// The daily and monthly spend behind charts C4–C6. Polled far less often
/// than [`billed`] — every ten minutes, and only while the page is visible —
/// since it runs two full-month scans rather than one.
pub fn trends(cloud: &Cloud, source: &Source, month_start: i64) -> Result<Trends> {
    let dataset = dataset();
    let table = match locate_table(cloud, source, &dataset)? {
        Table::Found(table) => table,
        Table::NotEnabled => return Ok(Trends::NotEnabled { dataset }),
    };
    let month = invoice_month(month_start);
    let first_month_start = shift_months(month_start, -(TRENDS_MONTHS - 1));
    let first_month = invoice_month(first_month_start);
    let partition_start = rfc3339(first_month_start - PARTITION_MARGIN_SECS);

    let (daily_answer, monthly_answer) = match source {
        Source::Fixture { root } => (
            fixture_json(root, "bigquery/daily.json")?,
            fixture_json(root, "bigquery/monthly.json")?,
        ),
        Source::Live { project } => (
            run_query(
                cloud,
                project,
                &daily_request(project, &dataset, &table, &month, &partition_start),
            )?,
            run_query(
                cloud,
                project,
                &monthly_request(project, &dataset, &table, &first_month, &partition_start),
            )?,
        ),
    };
    if !daily_answer.job_complete || !monthly_answer.job_complete {
        return Ok(Trends::Unavailable {
            message: UNFINISHED.into(),
        });
    }
    let (daily, daily_newest) = parse_daily(&daily_answer);
    let (monthly, monthly_newest) = parse_monthly(&monthly_answer, &month);
    let exported_at = match (daily_newest, monthly_newest) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(t), None) | (None, Some(t)) => Some(t),
        (None, None) => None,
    };
    Ok(Trends::Ok {
        currency: "USD".into(),
        daily,
        monthly,
        exported_at: exported_at.map(|t| rfc3339(t as i64)),
    })
}

/// `month_start` shifted by `delta` whole calendar months — negative walks
/// back — landing on that month's first day at 00:00 UTC. [`trends`] uses it
/// to find the earliest of the last [`TRENDS_MONTHS`] invoice months.
fn shift_months(month_start: i64, delta: i64) -> i64 {
    let text = rfc3339(month_start);
    let year: i64 = text[0..4].parse().unwrap_or(1970);
    let month: i64 = text[5..7].parse().unwrap_or(1);
    let total = year * 12 + (month - 1) + delta;
    days_from_civil(total.div_euclid(12), total.rem_euclid(12) + 1, 1) * 86_400
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

/// A table's fully qualified name, or a name that cannot match anything.
/// Every caller here only ever passes a `project` [`is_project_id`] and a
/// `dataset`/`table` [`is_identifier`] has already checked, so the fallback
/// is unreachable in practice — a query that fails is still safer than one
/// built from a name that was not checked.
fn qualified(project: &str, dataset: &str, table: &str) -> String {
    if is_project_id(project) && is_identifier(dataset) && is_identifier(table) {
        format!("`{project}.{dataset}.{table}`")
    } else {
        "`invalid`".to_string()
    }
}

fn param(name: &str, value: &str) -> Value {
    json!({
        "name": name,
        "parameterType": { "type": "STRING" },
        "parameterValue": { "value": value },
    })
}

fn param_ts(name: &str, value: &str) -> Value {
    json!({
        "name": name,
        "parameterType": { "type": "TIMESTAMP" },
        "parameterValue": { "value": value },
    })
}

/// The `jobs.query` body for [`billed`]. Month and project travel as
/// parameters; only the table's own name is spliced, and only after
/// [`qualified`] has checked it.
fn request(project: &str, dataset: &str, table: &str, month: &str) -> Value {
    let from = qualified(project, dataset, table);
    let sql = format!(
        "SELECT service.description AS service, SUM(cost) AS cost, \
         SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits, \
         ANY_VALUE(currency) AS currency, MAX(export_time) AS exported \
         FROM {from} WHERE invoice.month = @month AND project.id = @project \
         GROUP BY service ORDER BY cost DESC"
    );
    json!({
        "query": sql,
        "useLegacySql": false,
        "timeoutMs": QUERY_TIMEOUT_MS,
        "parameterMode": "NAMED",
        "queryParameters": [param("month", month), param("project", project)],
    })
}

/// The `jobs.query` body for chart C4: this invoice month, by day and
/// service. `partition_start` keeps the scan to the months trends actually
/// covers (`docs/design/COST-TRACKER-CHARTS.md` §3.2).
fn daily_request(
    project: &str,
    dataset: &str,
    table: &str,
    month: &str,
    partition_start: &str,
) -> Value {
    let from = qualified(project, dataset, table);
    let sql = format!(
        "SELECT DATE(usage_start_time) AS day, service.description AS service, \
         SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS net, \
         MAX(export_time) AS exported \
         FROM {from} WHERE invoice.month = @month AND project.id = @project \
         AND _PARTITIONTIME >= @partition_start \
         GROUP BY day, service ORDER BY day, service"
    );
    json!({
        "query": sql,
        "useLegacySql": false,
        "timeoutMs": QUERY_TIMEOUT_MS,
        "parameterMode": "NAMED",
        "queryParameters": [
            param("month", month),
            param("project", project),
            param_ts("partition_start", partition_start),
        ],
    })
}

/// The `jobs.query` body for chart C5: the last [`TRENDS_MONTHS`] invoice
/// months. `first_month` is the earliest one, inclusive.
fn monthly_request(
    project: &str,
    dataset: &str,
    table: &str,
    first_month: &str,
    partition_start: &str,
) -> Value {
    let from = qualified(project, dataset, table);
    let sql = format!(
        "SELECT invoice.month AS month, \
         SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS net, \
         MAX(export_time) AS exported \
         FROM {from} WHERE invoice.month >= @first_month AND project.id = @project \
         AND _PARTITIONTIME >= @partition_start \
         GROUP BY month ORDER BY month"
    );
    json!({
        "query": sql,
        "useLegacySql": false,
        "timeoutMs": QUERY_TIMEOUT_MS,
        "parameterMode": "NAMED",
        "queryParameters": [
            param("first_month", first_month),
            param("project", project),
            param_ts("partition_start", partition_start),
        ],
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

fn column(answer: &QueryAnswer, name: &str) -> Option<usize> {
    answer.schema.fields.iter().position(|f| f.name == name)
}

fn cell(row: &Row, at: Option<usize>) -> Option<&Value> {
    at.and_then(|i| row.f.get(i)).map(|c| &c.v)
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
            message: UNFINISHED.into(),
        };
    }
    let (service, cost, credits, currency, exported) = (
        column(answer, "service"),
        column(answer, "cost"),
        column(answer, "credits"),
        column(answer, "currency"),
        column(answer, "exported"),
    );
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

/// Rows plus the newest `exported` seen among them — the shared shape
/// [`trends`] pulls out of both queries' answers.
fn parse_daily(answer: &QueryAnswer) -> (Vec<DailyCost>, Option<f64>) {
    let (day, service, net, exported) = (
        column(answer, "day"),
        column(answer, "service"),
        column(answer, "net"),
        column(answer, "exported"),
    );
    let mut rows = Vec::new();
    let mut newest: Option<f64> = None;
    for row in &answer.rows {
        rows.push(DailyCost {
            day: cell(row, day)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            service: cell(row, service)
                .and_then(Value::as_str)
                .unwrap_or("Unnamed service")
                .to_string(),
            net: cell(row, net).and_then(number).unwrap_or(0.0),
        });
        if let Some(t) = cell(row, exported).and_then(number) {
            newest = Some(newest.map_or(t, |n| n.max(t)));
        }
    }
    (rows, newest)
}

/// Same shape as [`parse_daily`], and marks whichever row is `current_month`
/// as partial — the only month the query can still be mid-way through.
fn parse_monthly(answer: &QueryAnswer, current_month: &str) -> (Vec<MonthlyCost>, Option<f64>) {
    let (month, net, exported) = (
        column(answer, "month"),
        column(answer, "net"),
        column(answer, "exported"),
    );
    let mut rows = Vec::new();
    let mut newest: Option<f64> = None;
    for row in &answer.rows {
        let month = cell(row, month)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        rows.push(MonthlyCost {
            partial: month == current_month,
            month,
            net: cell(row, net).and_then(number).unwrap_or(0.0),
        });
        if let Some(t) = cell(row, exported).and_then(number) {
            newest = Some(newest.map_or(t, |n| n.max(t)));
        }
    }
    (rows, newest)
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

    #[test]
    fn shift_months_walks_back_across_a_year_boundary() {
        let jan = super::super::parse_rfc3339("2027-01-01T00:00:00Z").unwrap();
        assert_eq!(rfc3339(shift_months(jan, -6)), "2026-07-01T00:00:00Z");
        assert_eq!(rfc3339(shift_months(jan, 0)), "2027-01-01T00:00:00Z");
        let sep = super::super::parse_rfc3339("2026-09-01T00:00:00Z").unwrap();
        assert_eq!(rfc3339(shift_months(sep, -5)), "2026-04-01T00:00:00Z");
    }

    #[test]
    fn trends_queries_are_parameterized_and_scoped_by_partition() {
        let body = daily_request(
            "veistra-prod",
            "billing_export",
            "gcp_billing_export_v1_X",
            "202609",
            "2026-03-29T00:00:00Z",
        );
        let sql = body["query"].as_str().unwrap();
        assert!(sql.contains("_PARTITIONTIME >= @partition_start"));
        assert!(sql.contains("@month") && !sql.contains("202609"));
        assert_eq!(body["queryParameters"].as_array().unwrap().len(), 3);

        let body = monthly_request(
            "veistra-prod",
            "billing_export",
            "gcp_billing_export_v1_X",
            "202604",
            "2026-03-29T00:00:00Z",
        );
        let sql = body["query"].as_str().unwrap();
        assert!(sql.contains("@first_month") && !sql.contains("202604"));
        assert!(sql.contains("_PARTITIONTIME >= @partition_start"));
    }

    #[test]
    fn the_fixture_answers_daily_and_monthly_with_the_newest_export_seen() {
        let start = super::super::parse_rfc3339("2026-09-01T00:00:00Z").unwrap();
        let trends = trends(&Cloud::default(), &fixtures(), start).unwrap();
        let Trends::Ok {
            daily,
            monthly,
            exported_at,
            ..
        } = &trends
        else {
            panic!("expected Ok, got {trends:?}");
        };
        assert_eq!(daily.len(), 6);
        assert_eq!(
            (daily[0].day.as_str(), daily[0].service.as_str()),
            ("2026-09-01", "Cloud Storage")
        );
        assert_eq!(monthly.len(), 6);
        assert_eq!(monthly[0].month, "202604");
        assert!(!monthly[0].partial);
        assert_eq!(monthly[5].month, "202609");
        assert!(monthly[5].partial, "the current month has not finished yet");
        assert_eq!(
            exported_at.as_deref(),
            Some(rfc3339(1_790_600_400).as_str())
        );

        let json = serde_json::to_value(&trends).unwrap();
        assert_eq!(json["state"], "ok");
        assert_eq!(json["exportedAt"], rfc3339(1_790_600_400));
        assert!(json["daily"][0]["day"].is_string());
    }

    #[test]
    fn no_export_table_means_trends_are_not_enabled_either() {
        let dir = tempfile::tempdir().unwrap();
        let source = Source::Fixture {
            root: dir.path().to_path_buf(),
        };
        assert_eq!(
            trends(&Cloud::default(), &source, 0).unwrap(),
            Trends::NotEnabled {
                dataset: DEFAULT_DATASET.into()
            }
        );
    }
}
