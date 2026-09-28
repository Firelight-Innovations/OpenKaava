//! Cloud Monitoring time series: how long each machine ran, how much each
//! bucket held, how long each Cloud Run service was billed for.
//!
//! These are the usage half of a cost estimate. The fixture for a query is
//! `<root>/monitoring/<fixture>.json`, a `timeSeries.list` answer, filtered
//! to the query's interval so a test can move the clock.

use super::{fixture_json, get_json, http, rfc3339, Cloud, Result, Source};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// One series, with its resource and metric labels merged into one map.
#[derive(Debug, Clone, PartialEq)]
pub struct Series {
    pub labels: BTreeMap<String, String>,
    pub points: Vec<Point>,
}

/// One aligned value, stamped with the end of the period it covers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub end: i64,
    pub value: f64,
}

impl Series {
    pub fn label(&self, key: &str) -> &str {
        self.labels.get(key).map_or("", String::as_str)
    }

    /// The sum of the points whose period ended in `(from, to]`.
    pub fn sum(&self, from: i64, to: i64) -> f64 {
        self.points
            .iter()
            .filter(|p| p.end > from && p.end <= to)
            .map(|p| p.value)
            .sum()
    }

    /// The newest point, if any.
    pub fn latest(&self) -> Option<Point> {
        self.points.iter().copied().max_by_key(|p| p.end)
    }
}

pub struct Query<'a> {
    /// The fixture file's stem.
    pub fixture: &'a str,
    pub metric: &'a str,
    /// `ALIGN_SUM` for a delta such as uptime, `ALIGN_MEAN` for a gauge.
    pub aligner: &'a str,
    pub period_secs: u32,
    pub start: i64,
    pub end: i64,
}

pub fn series(cloud: &Cloud, source: &Source, query: &Query) -> Result<Vec<Series>> {
    let raw = match source {
        Source::Fixture { root } => {
            let page: Page = fixture_json(root, &format!("monitoring/{}.json", query.fixture))?;
            page.time_series
        }
        Source::Live { project } => fetch(cloud, project, query)?,
    };
    Ok(raw
        .into_iter()
        .map(|s| s.into_series(query.start, query.end))
        .collect())
}

fn fetch(cloud: &Cloud, project: &str, query: &Query) -> Result<Vec<RawSeries>> {
    let mut all = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut url = format!(
            "https://monitoring.googleapis.com/v3/projects/{}/timeSeries?filter={}\
             &interval.startTime={}&interval.endTime={}\
             &aggregation.alignmentPeriod={}s&aggregation.perSeriesAligner={}",
            http::encode(project),
            http::encode(&format!("metric.type=\"{}\"", query.metric)),
            http::encode(&rfc3339(query.start)),
            http::encode(&rfc3339(query.end)),
            query.period_secs,
            query.aligner,
        );
        if let Some(t) = &token {
            url.push_str(&format!("&pageToken={}", http::encode(t)));
        }
        let page: Page = get_json(cloud, &url, &format!("metric {}", query.metric), 32 << 20)?;
        all.extend(page.time_series);
        match page.next_page_token {
            Some(t) if !t.is_empty() => token = Some(t),
            _ => return Ok(all),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    #[serde(default)]
    time_series: Vec<RawSeries>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct RawSeries {
    #[serde(default)]
    metric: RawLabelled,
    #[serde(default)]
    resource: RawLabelled,
    #[serde(default)]
    points: Vec<RawPoint>,
}

#[derive(Default, Deserialize)]
struct RawLabelled {
    #[serde(default)]
    labels: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct RawPoint {
    interval: RawInterval,
    value: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInterval {
    end_time: String,
}

impl RawSeries {
    fn into_series(self, start: i64, end: i64) -> Series {
        let mut labels = self.resource.labels;
        labels.extend(self.metric.labels);
        let points = self
            .points
            .into_iter()
            .filter_map(|p| {
                let at = super::parse_rfc3339(&p.interval.end_time)?;
                // `int64Value` arrives as a string, `doubleValue` as a number.
                let value = p.value.values().find_map(|v| match v {
                    Value::Number(n) => n.as_f64(),
                    Value::String(s) => s.parse().ok(),
                    _ => None,
                })?;
                Some(Point { end: at, value })
            })
            .filter(|p| p.end > start && p.end <= end)
            .collect();
        Series { labels, points }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(json: &str) -> (tempfile::TempDir, Source) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("monitoring")).unwrap();
        std::fs::write(dir.path().join("monitoring/q.json"), json).unwrap();
        let root = dir.path().to_path_buf();
        (dir, Source::Fixture { root })
    }

    const ONE: &str = r#"{"timeSeries":[{
      "metric":{"type":"m","labels":{"instance_name":"vm"}},
      "resource":{"type":"gce_instance","labels":{"zone":"us-central1-a"}},
      "points":[
        {"interval":{"endTime":"2026-09-02T00:00:00Z"},"value":{"doubleValue":3600}},
        {"interval":{"endTime":"2026-09-01T00:00:00Z"},"value":{"int64Value":"1800"}},
        {"interval":{"endTime":"2026-08-01T00:00:00Z"},"value":{"doubleValue":99}}
      ]}]}"#;

    fn query(start: &str, end: &str) -> Query<'static> {
        Query {
            fixture: "q",
            metric: "m",
            aligner: "ALIGN_SUM",
            period_secs: 3600,
            start: super::super::parse_rfc3339(start).unwrap(),
            end: super::super::parse_rfc3339(end).unwrap(),
        }
    }

    #[test]
    fn labels_merge_and_both_value_kinds_read() {
        let (_dir, source) = fixture(ONE);
        let q = query("2026-08-15T00:00:00Z", "2026-09-30T00:00:00Z");
        let all = series(&Cloud::default(), &source, &q).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].label("instance_name"), "vm");
        assert_eq!(all[0].label("zone"), "us-central1-a");
        assert_eq!(
            all[0].points.len(),
            2,
            "the August point is outside the query"
        );
        assert_eq!(all[0].sum(q.start, q.end), 5400.0);
        assert_eq!(all[0].latest().unwrap().value, 3600.0);
    }

    #[test]
    fn sum_excludes_the_start_and_includes_the_end() {
        let (_dir, source) = fixture(ONE);
        let q = query("2026-08-15T00:00:00Z", "2026-09-30T00:00:00Z");
        let s = series(&Cloud::default(), &source, &q).unwrap().remove(0);
        let sept_1 = super::super::parse_rfc3339("2026-09-01T00:00:00Z").unwrap();
        let sept_2 = super::super::parse_rfc3339("2026-09-02T00:00:00Z").unwrap();
        assert_eq!(s.sum(sept_1, sept_2), 3600.0);
    }
}
