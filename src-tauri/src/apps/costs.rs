//! The Cost Tracker's Rust half: what OpenKaava Cloud has cost this month at
//! list price, and where the month is heading against its budget.
//!
//! An estimate, not a bill. It multiplies what exists (`cloud::inventory`) by
//! how much it ran or held (`cloud::monitoring`) by the public price sheet
//! (`cloud::billing`). Discounts, credits, taxes and the services listed in
//! [`NOT_ESTIMATED`] are left out, and the page says so. The billed figure
//! from the BigQuery export is a later step.
//!
//! One method, `costs/estimate`, and it only reads.

use crate::apps::CallContext;
use crate::cloud::billing::{self, Sku};
use crate::cloud::inventory::{self, Address, Bucket, Disk, RunService, Vm};
use crate::cloud::monitoring::{self, Series};
use crate::cloud::{self, days_from_civil, parse_rfc3339, rfc3339, Cloud, Source, Trouble};
use kaava_rpc::{RpcError, INTERNAL_ERROR, METHOD_NOT_FOUND};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// The monthly budget OpenKaava Cloud is held to. `KAAVA_GCP_BUDGET` overrides it.
const BUDGET_USD: f64 = 150.0;

/// How far back the forecast looks for a running rate.
const TRAILING_SECS: i64 = 7 * 86_400;

const HOUR: f64 = 3600.0;

/// What the estimate does not cover, shown under it.
const NOT_ESTIMATED: [&str; 5] = [
    "Network egress and Cloud NAT.",
    "Secret Manager, Cloud Logging and Artifact Registry.",
    "Cloud Run's monthly free tier, which is not subtracted.",
    "Discounts, credits and taxes.",
    "Months are counted in UTC. Google bills in Pacific time, so the first and last hours of a month can land in the neighbouring one.",
];

pub fn call(
    app: &AppHandle,
    _context: &CallContext,
    method: &str,
    _params: Option<Value>,
) -> Result<Value, RpcError> {
    match method {
        "costs/estimate" => {
            let cloud = app.state::<Cloud>();
            let estimate = estimate(&cloud, &Source::from_env())?;
            serde_json::to_value(estimate).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
        }
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

// --- the answer ---------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub source: &'static str,
    pub project: String,
    pub currency: &'static str,
    pub budget: f64,
    pub now: String,
    pub month_start: String,
    pub month_end: String,
    pub to_date: f64,
    pub forecast: f64,
    pub categories: Vec<Category>,
    /// A part that failed while the rest answered, such as denied Monitoring.
    pub problems: Vec<Problem>,
    pub not_estimated: Vec<&'static str>,
    /// The newest `effectiveTime` among the prices used.
    pub prices_as_of: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: &'static str,
    pub label: &'static str,
    pub to_date: f64,
    pub forecast: f64,
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub resource: String,
    pub detail: String,
    pub item: String,
    pub quantity_to_date: f64,
    pub quantity_forecast: f64,
    pub unit: &'static str,
    /// Per `unit`, at the tier the month is forecast to reach. `None` when no
    /// list price matched, in which case both costs are zero and `note` says so.
    pub unit_price: Option<f64>,
    pub to_date: f64,
    pub forecast: f64,
    pub sku: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub part: &'static str,
    pub message: String,
}

// --- the month ----------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Month {
    pub now: i64,
    pub start: i64,
    pub end: i64,
}

impl Month {
    /// The UTC calendar month holding `now`.
    pub fn of(now: i64) -> Self {
        let text = rfc3339(now);
        let year: i64 = text[0..4].parse().unwrap_or(1970);
        let month: i64 = text[5..7].parse().unwrap_or(1);
        let (next_year, next_month) = if month == 12 {
            (year + 1, 1)
        } else {
            (year, month + 1)
        };
        Month {
            now,
            start: days_from_civil(year, month, 1) * 86_400,
            end: days_from_civil(next_year, next_month, 1) * 86_400,
        }
    }

    fn secs(&self) -> f64 {
        (self.end - self.start) as f64
    }

    fn remaining(&self) -> f64 {
        (self.end - self.now).max(0) as f64
    }

    /// Where the usage query starts: the month, or a week back if that is earlier.
    fn query_start(&self) -> i64 {
        self.start.min(self.now - TRAILING_SECS) - 3600
    }

    /// Usage so far this month, and the month's forecast from the trailing rate.
    fn project(&self, series: &[&Series], cap_per_sec: Option<f64>) -> (f64, f64) {
        let to_date: f64 = series.iter().map(|s| s.sum(self.start, self.now)).sum();
        let week: f64 = series
            .iter()
            .map(|s| s.sum(self.now - TRAILING_SECS, self.now))
            .sum();
        let mut ahead = week / TRAILING_SECS as f64 * self.remaining();
        if let Some(cap) = cap_per_sec {
            ahead = ahead.min(cap * self.remaining());
        }
        (to_date, to_date + ahead)
    }

    /// The share of the month a thing that exists from `created` on is billed for.
    fn held(&self, created: Option<i64>) -> (f64, f64) {
        let from = created.unwrap_or(self.start).clamp(self.start, self.end);
        let to_date = (self.now - from).max(0) as f64;
        let whole = (self.end - from).max(0) as f64;
        (to_date, whole)
    }
}

// --- units --------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
struct Unit {
    /// The catalog's `usageUnit` a price must be quoted in.
    catalog: &'static str,
    label: &'static str,
}

const CORE_HOURS: Unit = Unit {
    catalog: "h",
    label: "vCPU·h",
};
const GIB_HOURS: Unit = Unit {
    catalog: "GiBy.h",
    label: "GiB·h",
};
const GPU_HOURS: Unit = Unit {
    catalog: "h",
    label: "GPU·h",
};
const IP_HOURS: Unit = Unit {
    catalog: "h",
    label: "IP·h",
};
const GIB_MONTHS: Unit = Unit {
    catalog: "GiBy.mo",
    label: "GiB·mo",
};
const CPU_SECONDS: Unit = Unit {
    catalog: "s",
    label: "vCPU·s",
};
const GIB_SECONDS: Unit = Unit {
    catalog: "GiBy.s",
    label: "GiB·s",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Group {
    Machines,
    Disks,
    Storage,
    Run,
    Addresses,
}

impl Group {
    const ALL: [Group; 5] = [
        Group::Machines,
        Group::Disks,
        Group::Storage,
        Group::Run,
        Group::Addresses,
    ];

    fn id(self) -> &'static str {
        match self {
            Group::Machines => "machines",
            Group::Disks => "disks",
            Group::Storage => "storage",
            Group::Run => "run",
            Group::Addresses => "addresses",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Group::Machines => "Machines",
            Group::Disks => "Disks",
            Group::Storage => "Cloud Storage",
            Group::Run => "Cloud Run",
            Group::Addresses => "Reserved IPs",
        }
    }
}

/// A line before pricing: what it is, how much, and which price applies.
struct Usage<'a> {
    group: Group,
    resource: String,
    detail: String,
    item: String,
    to_date: f64,
    forecast: f64,
    unit: Unit,
    sku: Option<&'a Sku>,
    note: Option<String>,
}

// --- gathering ------------------------------------------------------------------------

/// Everything the estimate is computed from, read once per call.
#[derive(Default)]
pub struct Inputs {
    pub vms: Vec<Vm>,
    pub disks: Vec<Disk>,
    pub addresses: Vec<Address>,
    pub buckets: Vec<Bucket>,
    pub services: Vec<RunService>,
    pub uptime: Vec<Series>,
    pub storage: Vec<Series>,
    pub run: Vec<Series>,
    pub compute_prices: Arc<Vec<Sku>>,
    pub storage_prices: Arc<Vec<Sku>>,
    pub run_prices: Arc<Vec<Sku>>,
}

#[derive(Default, Deserialize)]
struct Clock {
    now: Option<String>,
}

fn now_for(source: &Source) -> i64 {
    if let Source::Fixture { root } = source {
        let clock: Clock = cloud::fixture_json(root, "clock.json").unwrap_or_default();
        if let Some(now) = clock.now.as_deref().and_then(parse_rfc3339) {
            return now;
        }
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

fn budget() -> f64 {
    std::env::var("KAAVA_GCP_BUDGET")
        .ok()
        .and_then(|b| b.parse::<f64>().ok())
        .filter(|b| *b > 0.0)
        .unwrap_or(BUDGET_USD)
}

pub fn estimate(cloud: &Cloud, source: &Source) -> Result<Estimate, Trouble> {
    let month = Month::of(now_for(source));
    let (inputs, problems) = gather(cloud, source, &month)?;
    let (categories, prices_as_of) = price(&inputs, &month);
    Ok(Estimate {
        source: source.kind(),
        project: source.project().to_string(),
        currency: "USD",
        budget: budget(),
        now: rfc3339(month.now),
        month_start: rfc3339(month.start),
        month_end: rfc3339(month.end),
        to_date: categories.iter().map(|c| c.to_date).sum(),
        forecast: categories.iter().map(|c| c.forecast).sum(),
        categories,
        problems,
        not_estimated: NOT_ESTIMATED.to_vec(),
        prices_as_of,
    })
}

/// Every read at once, one thread each. A signed-out or missing `gcloud`
/// fails the whole call so the page can draw the fix; anything else becomes
/// a [`Problem`] and that part of the estimate is simply absent.
fn gather(
    cloud: &Cloud,
    source: &Source,
    month: &Month,
) -> Result<(Inputs, Vec<Problem>), Trouble> {
    let query = |fixture, metric, aligner, period_secs| monitoring::Query {
        fixture,
        metric,
        aligner,
        period_secs,
        start: month.query_start(),
        end: month.now,
    };
    let uptime_q = query(
        "uptime",
        "compute.googleapis.com/instance/uptime",
        "ALIGN_SUM",
        3600,
    );
    let storage_q = query(
        "storage",
        "storage.googleapis.com/storage/total_bytes",
        "ALIGN_MEAN",
        86_400,
    );
    let run_q = query(
        "run",
        "run.googleapis.com/container/billable_instance_time",
        "ALIGN_SUM",
        3600,
    );

    let mut problems = Vec::new();
    let mut hard: Option<Trouble> = None;
    let mut keep = |part: &'static str, result: cloud::Result<()>| {
        if let Err(trouble) = result {
            match trouble {
                Trouble::GcloudMissing | Trouble::SignedOut { .. } => {
                    hard.get_or_insert(trouble);
                }
                other => problems.push(Problem {
                    part,
                    message: other.message(),
                }),
            }
        }
    };

    let mut inputs = Inputs::default();
    std::thread::scope(|scope| {
        let vms = scope.spawn(|| inventory::vms(cloud, source));
        let disks = scope.spawn(|| inventory::disks(cloud, source));
        let addresses = scope.spawn(|| inventory::addresses(cloud, source));
        let buckets = scope.spawn(|| inventory::buckets(cloud, source));
        let services = scope.spawn(|| inventory::run_services(cloud, source));
        let uptime = scope.spawn(|| monitoring::series(cloud, source, &uptime_q));
        let storage = scope.spawn(|| monitoring::series(cloud, source, &storage_q));
        let run = scope.spawn(|| monitoring::series(cloud, source, &run_q));
        let compute_prices =
            scope.spawn(|| billing::catalog(cloud, source, billing::COMPUTE_ENGINE));
        let storage_prices =
            scope.spawn(|| billing::catalog(cloud, source, billing::CLOUD_STORAGE));
        let run_prices = scope.spawn(|| billing::catalog(cloud, source, billing::CLOUD_RUN));

        keep("Machines", joined(vms).map(|v| inputs.vms = v));
        keep("Disks", joined(disks).map(|v| inputs.disks = v));
        keep(
            "Reserved IPs",
            joined(addresses).map(|v| inputs.addresses = v),
        );
        keep("Buckets", joined(buckets).map(|v| inputs.buckets = v));
        keep(
            "Cloud Run services",
            joined(services).map(|v| inputs.services = v),
        );
        keep("Machine uptime", joined(uptime).map(|v| inputs.uptime = v));
        keep("Bucket sizes", joined(storage).map(|v| inputs.storage = v));
        keep("Cloud Run usage", joined(run).map(|v| inputs.run = v));
        keep(
            "Compute Engine prices",
            joined(compute_prices).map(|v| inputs.compute_prices = v),
        );
        keep(
            "Cloud Storage prices",
            joined(storage_prices).map(|v| inputs.storage_prices = v),
        );
        keep(
            "Cloud Run prices",
            joined(run_prices).map(|v| inputs.run_prices = v),
        );
    });
    match hard {
        Some(trouble) => Err(trouble),
        None => Ok((inputs, problems)),
    }
}

/// A read's answer, with a panic in its thread turned into a [`Trouble`].
fn joined<T>(handle: std::thread::ScopedJoinHandle<'_, cloud::Result<T>>) -> cloud::Result<T> {
    handle.join().unwrap_or_else(|_| {
        Err(Trouble::Unreachable {
            detail: "a read panicked".into(),
        })
    })
}

// --- pricing --------------------------------------------------------------------------

/// The best price for `region` that passes `test`: a regional SKU over a global one.
fn find<'a>(skus: &'a [Sku], region: &str, test: impl Fn(&Sku) -> bool) -> Option<&'a Sku> {
    skus.iter()
        .filter(|s| s.serves(region) && test(s))
        .min_by_key(|s| (s.regions.iter().any(|r| r == "global"), s.regions.len()))
}

/// `L4` from `nvidia-l4`, `Tesla T4` from `nvidia-tesla-t4` — the catalog's spelling.
fn gpu_name(kind: &str) -> String {
    kind.trim_start_matches("nvidia-")
        .split('-')
        .map(|part| {
            if part == "tesla" {
                "Tesla".to_string()
            } else {
                part.to_uppercase()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn machine_usage<'a>(inputs: &'a Inputs, month: &Month, out: &mut Vec<Usage<'a>>) {
    let prices = inputs.compute_prices.as_slice();
    for vm in &inputs.vms {
        let series: Vec<&Series> = inputs
            .uptime
            .iter()
            .filter(|s| s.label("instance_name") == vm.name)
            .collect();
        let (secs, secs_fc) = month.project(&series, Some(1.0));
        let (hours, hours_fc) = (secs / HOUR, secs_fc / HOUR);
        let family = vm
            .machine_type
            .split('-')
            .next()
            .unwrap_or("")
            .to_uppercase();
        let spot = if vm.spot { "Spot Preemptible " } else { "" };
        let usage = if vm.spot { "Preemptible" } else { "OnDemand" };
        let detail = format!(
            "{} · {}{} · {}",
            vm.machine_type,
            vm.zone,
            if vm.spot { " · spot" } else { "" },
            vm.status.to_lowercase()
        );
        let mut line = |item: String, per_hour: f64, unit: Unit, sku: Option<&'a Sku>| {
            out.push(Usage {
                group: Group::Machines,
                resource: vm.name.clone(),
                detail: detail.clone(),
                item,
                to_date: hours * per_hour,
                forecast: hours_fc * per_hour,
                unit,
                sku,
                note: None,
            });
        };
        let by_prefix = |prefix: String| {
            find(prices, &vm.region, move |s| {
                s.usage_type == usage && s.description.starts_with(&prefix)
            })
        };
        line(
            "vCPU".into(),
            vm.cpus,
            CORE_HOURS,
            by_prefix(format!("{spot}{family} Instance Core running in ")),
        );
        line(
            "Memory".into(),
            vm.memory_gib,
            GIB_HOURS,
            by_prefix(format!("{spot}{family} Instance Ram running in ")),
        );
        for (kind, count) in &vm.gpus {
            let name = gpu_name(kind);
            let prefix = if vm.spot {
                format!("Nvidia {name} GPU attached to Spot Preemptible VMs running in ")
            } else {
                format!("Nvidia {name} GPU running in ")
            };
            line(
                format!("{name} GPU"),
                f64::from(*count),
                GPU_HOURS,
                by_prefix(prefix),
            );
        }
        if vm.external_ips > 0 {
            let description = if vm.spot {
                "External IP Charge on a Spot Preemptible VM"
            } else {
                "External IP Charge on a Standard VM"
            };
            line(
                "External IP".into(),
                f64::from(vm.external_ips),
                IP_HOURS,
                find(prices, &vm.region, |s| s.description == description),
            );
        }
    }
}

fn disk_usage<'a>(inputs: &'a Inputs, month: &Month, out: &mut Vec<Usage<'a>>) {
    for disk in &inputs.disks {
        let description = match disk.kind.as_str() {
            "pd-balanced" => Some("Balanced PD Capacity"),
            "pd-standard" => Some("Storage PD Capacity"),
            "pd-ssd" => Some("SSD backed PD Capacity"),
            "pd-extreme" => Some("Extreme PD Capacity"),
            _ => None,
        };
        let sku = description.and_then(|d| {
            find(&inputs.compute_prices, &disk.region, |s| {
                s.usage_type == "OnDemand" && s.description == d
            })
        });
        let (secs, whole) = month.held(disk.created);
        out.push(Usage {
            group: Group::Disks,
            resource: disk.name.clone(),
            detail: match &disk.attached_to {
                Some(vm) => format!("{} · {} GiB · on {vm}", disk.kind, disk.size_gib),
                None => format!("{} · {} GiB · unattached", disk.kind, disk.size_gib),
            },
            item: "Capacity".into(),
            to_date: disk.size_gib * secs / month.secs(),
            forecast: disk.size_gib * whole / month.secs(),
            unit: GIB_MONTHS,
            sku,
            note: None,
        });
    }
}

fn address_usage<'a>(inputs: &'a Inputs, month: &Month, out: &mut Vec<Usage<'a>>) {
    // An address in use bills as its machine's external IP, counted above.
    for address in inputs
        .addresses
        .iter()
        .filter(|a| a.external && a.status == "RESERVED")
    {
        let (secs, whole) = month.held(address.created);
        out.push(Usage {
            group: Group::Addresses,
            resource: address.name.clone(),
            detail: format!("{} · reserved, not in use", address.region),
            item: "Static IP".into(),
            to_date: secs / HOUR,
            forecast: whole / HOUR,
            unit: IP_HOURS,
            sku: find(&inputs.compute_prices, &address.region, |s| {
                s.usage_type == "OnDemand"
                    && (s.description == "Static Ip Charge"
                        || s.description.starts_with("Static Ip Charge in "))
            }),
            note: None,
        });
    }
}

/// The catalog's resource group for a storage class in a kind of location.
fn storage_group(class: &str, location_type: &str) -> Option<&'static str> {
    match (class, location_type) {
        ("STANDARD", "region") => Some("RegionalStorage"),
        ("STANDARD", _) => Some("MultiRegionalStorage"),
        ("NEARLINE", _) => Some("NearlineStorage"),
        ("COLDLINE", _) => Some("ColdlineStorage"),
        ("ARCHIVE", _) => Some("ArchiveStorage"),
        _ => None,
    }
}

fn storage_usage<'a>(inputs: &'a Inputs, month: &Month, out: &mut Vec<Usage<'a>>) {
    const GIB: f64 = (1u64 << 30) as f64;
    for bucket in &inputs.buckets {
        let series: Vec<&Series> = inputs
            .storage
            .iter()
            .filter(|s| s.label("bucket_name") == bucket.name)
            .collect();
        let class = series
            .first()
            .map(|s| s.label("storage_class"))
            .filter(|c| !c.is_empty())
            .unwrap_or(&bucket.storage_class);
        // Daily means: each point is one day of the month at that size.
        let mut to_date = 0.0;
        let mut latest_gib = 0.0;
        for s in &series {
            to_date += s.sum(month.start, month.now) / GIB * 86_400.0 / month.secs();
            if let Some(latest) = s.latest() {
                let covered = latest.end.max(month.start);
                latest_gib += latest.value / GIB;
                to_date += latest.value / GIB * (month.now - covered).max(0) as f64 / month.secs();
            }
        }
        let forecast = to_date + latest_gib * month.remaining() / month.secs();
        let wanted = storage_group(class, &bucket.location_type);
        let sku = wanted.and_then(|group| {
            find(&inputs.storage_prices, &bucket.location, |s| {
                let d = &s.description;
                let shape = match bucket.location_type.as_str() {
                    "region" => !d.contains("Dual-region") && !d.contains("Multi-region"),
                    "dual-region" => d.contains("Dual-region"),
                    _ => d.contains("Multi-region"),
                };
                s.resource_group == group
                    && s.usage_type == "OnDemand"
                    && shape
                    && !d.contains("Early Delete")
                    && !d.contains("Autoclass")
            })
        });
        out.push(Usage {
            group: Group::Storage,
            resource: bucket.name.clone(),
            detail: format!(
                "{} · {} · {latest_gib:.1} GiB now",
                class.to_lowercase(),
                bucket.location
            ),
            item: "Stored data".into(),
            to_date,
            forecast,
            unit: GIB_MONTHS,
            sku,
            note: series
                .is_empty()
                .then(|| "No size reported yet.".to_string()),
        });
    }
}

fn run_usage<'a>(inputs: &'a Inputs, month: &Month, out: &mut Vec<Usage<'a>>) {
    let prices = inputs.run_prices.as_slice();
    for service in &inputs.services {
        let series: Vec<&Series> = inputs
            .run
            .iter()
            .filter(|s| s.label("service_name") == service.name)
            .collect();
        let (secs, secs_fc) = month.project(&series, None);
        let billing = if service.request_based {
            "Request-based billing"
        } else {
            "Instance-based billing"
        };
        let by = |resource: &'static str| {
            let exact = format!("Services {resource} ({billing})");
            let regional = format!("{exact} in ");
            find(prices, &service.region, move |s| {
                s.description == exact || s.description.starts_with(&regional)
            })
        };
        let note = (service.min_instances > 0).then(|| {
            format!(
                "Keeps {} instance(s) warm; idle minimum-instance time is not included.",
                service.min_instances
            )
        });
        let detail = format!(
            "{} · {} vCPU · {} GiB · {}",
            service.region,
            service.cpu,
            service.memory_gib,
            billing.to_lowercase()
        );
        for (item, per_sec, unit, sku) in [
            ("CPU", service.cpu, CPU_SECONDS, by("CPU")),
            ("Memory", service.memory_gib, GIB_SECONDS, by("Memory")),
        ] {
            out.push(Usage {
                group: Group::Run,
                resource: service.name.clone(),
                detail: detail.clone(),
                item: item.into(),
                to_date: secs * per_sec,
                forecast: secs_fc * per_sec,
                unit,
                sku,
                note: note.clone(),
            });
        }
    }
}

/// Price every line. Tiers apply to a SKU's whole month, so each SKU is costed
/// on its total and the cost shared out by quantity.
pub fn price(inputs: &Inputs, month: &Month) -> (Vec<Category>, Option<String>) {
    let mut usage = Vec::new();
    machine_usage(inputs, month, &mut usage);
    disk_usage(inputs, month, &mut usage);
    storage_usage(inputs, month, &mut usage);
    run_usage(inputs, month, &mut usage);
    address_usage(inputs, month, &mut usage);

    let mut totals: HashMap<&str, (f64, f64)> = HashMap::new();
    for u in &usage {
        if let Some(sku) = u.sku.filter(|s| s.unit == u.unit.catalog) {
            let t = totals.entry(sku.id.as_str()).or_default();
            t.0 += u.to_date;
            t.1 += u.forecast;
        }
    }
    let share = |cost: f64, part: f64, whole: f64| {
        if whole > 0.0 {
            cost * part / whole
        } else {
            0.0
        }
    };

    let mut prices_as_of: Option<String> = None;
    let mut categories: Vec<Category> = Group::ALL
        .iter()
        .map(|g| Category {
            id: g.id(),
            label: g.label(),
            to_date: 0.0,
            forecast: 0.0,
            lines: Vec::new(),
        })
        .collect();
    for u in usage {
        let mut line = Line {
            resource: u.resource,
            detail: u.detail,
            item: u.item,
            quantity_to_date: u.to_date,
            quantity_forecast: u.forecast,
            unit: u.unit.label,
            unit_price: None,
            to_date: 0.0,
            forecast: 0.0,
            sku: None,
            note: u.note,
        };
        match u.sku {
            Some(sku) if sku.unit == u.unit.catalog => {
                let (all_to_date, all_forecast) = totals[sku.id.as_str()];
                line.to_date = share(sku.cost(all_to_date), u.to_date, all_to_date);
                line.forecast = share(sku.cost(all_forecast), u.forecast, all_forecast);
                line.unit_price = Some(sku.marginal(all_forecast));
                line.sku = Some(format!("{} ({})", sku.description, sku.id));
                if sku.effective > prices_as_of {
                    prices_as_of.clone_from(&sku.effective);
                }
            }
            Some(sku) => {
                line.note = Some(format!(
                    "The list price is per {}, not per {}; left out.",
                    sku.unit, u.unit.catalog
                ));
            }
            None => line.note = Some("No list price matched; left out of the totals.".into()),
        }
        let category = &mut categories[Group::ALL.iter().position(|g| *g == u.group).unwrap_or(0)];
        category.to_date += line.to_date;
        category.forecast += line.forecast;
        category.lines.push(line);
    }
    categories.retain(|c| !c.lines.is_empty());
    (categories, prices_as_of)
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

    fn at(text: &str) -> i64 {
        parse_rfc3339(text).unwrap()
    }

    fn line<'a>(e: &'a Estimate, resource: &str, item: &str) -> &'a Line {
        e.categories
            .iter()
            .flat_map(|c| &c.lines)
            .find(|l| l.resource == resource && l.item == item)
            .unwrap_or_else(|| panic!("no {item} line for {resource}"))
    }

    #[test]
    fn a_month_is_its_utc_calendar_month() {
        let m = Month::of(at("2026-09-28T21:00:00Z"));
        assert_eq!(rfc3339(m.start), "2026-09-01T00:00:00Z");
        assert_eq!(rfc3339(m.end), "2026-10-01T00:00:00Z");
        let december = Month::of(at("2026-12-31T23:59:59Z"));
        assert_eq!(rfc3339(december.end), "2027-01-01T00:00:00Z");
    }

    #[test]
    fn something_held_all_month_bills_the_whole_month() {
        let m = Month::of(at("2026-09-16T00:00:00Z"));
        let (to_date, whole) = m.held(Some(at("2026-08-01T00:00:00Z")));
        assert_eq!(to_date / m.secs(), 0.5);
        assert_eq!(whole / m.secs(), 1.0);
        let (to_date, whole) = m.held(Some(at("2026-09-21T00:00:00Z")));
        assert_eq!(to_date, 0.0, "created after now has cost nothing yet");
        assert_eq!(whole / 86_400.0, 10.0);
    }

    #[test]
    fn the_forecast_runs_the_trailing_week_forward_and_never_past_full_time() {
        let m = Month::of(at("2026-09-24T00:00:00Z"));
        // Two hours a day, every day, for the whole month so far.
        let points = (1..=23 * 24)
            .filter(|h| h % 24 < 2)
            .map(|h| monitoring::Point {
                end: m.start + h * 3600,
                value: 3600.0,
            })
            .collect();
        let s = Series {
            labels: Default::default(),
            points,
        };
        let (to_date, forecast) = m.project(&[&s], Some(1.0));
        assert_eq!(to_date / HOUR, 46.0);
        assert!((forecast / HOUR - 60.0).abs() < 1e-9, "{}", forecast / HOUR);
        // A machine that ran flat out cannot be forecast past the hours left.
        let busy = Series {
            labels: Default::default(),
            points: vec![monitoring::Point {
                end: m.now,
                value: 30.0 * 86_400.0,
            }],
        };
        let (_, capped) = m.project(&[&busy], Some(1.0));
        assert_eq!(capped - 30.0 * 86_400.0, m.remaining());
    }

    #[test]
    fn gpu_names_follow_the_catalog() {
        assert_eq!(gpu_name("nvidia-l4"), "L4");
        assert_eq!(gpu_name("nvidia-tesla-t4"), "Tesla T4");
    }

    #[test]
    fn the_fixture_prices_every_resource_it_should() {
        let e = estimate(&Cloud::default(), &fixtures()).unwrap();
        assert_eq!((e.source, e.currency, e.budget), ("fixture", "USD", 150.0));
        assert_eq!(e.now, "2026-09-28T21:00:00Z");
        assert!(e.problems.is_empty(), "{:?}", e.problems);

        let core = line(&e, "kaava-worker", "vCPU");
        assert_eq!(
            core.sku.as_deref(),
            Some("E2 Instance Core running in Americas (CF4E-A0C7-E3BF)")
        );
        assert_eq!(core.unit, "vCPU·h");
        assert!(core.to_date > 0.0 && core.forecast > core.to_date);
        // 8 vCPUs at the list price, exactly.
        let expected = core.quantity_to_date * 0.021_811_59;
        assert!((core.to_date - expected).abs() < 1e-9);

        let spot = line(&e, "kaava-worker-2", "vCPU");
        assert!(spot
            .sku
            .as_deref()
            .unwrap()
            .starts_with("Spot Preemptible E2"));
        let gpu = line(&e, "kaava-gpu", "L4 GPU");
        assert_eq!(
            gpu.sku.as_deref(),
            Some("Nvidia L4 GPU running in Americas (A88A-5A60-E821)")
        );
        assert!(gpu.to_date > 0.0);

        let disk = line(&e, "kaava-gpu", "Capacity");
        assert!(
            (disk.forecast - 200.0 * 0.1).abs() < 1e-9,
            "a whole month of 200 GiB balanced"
        );

        let spare = line(&e, "spare-ip", "Static IP");
        assert!(spare
            .sku
            .as_deref()
            .unwrap()
            .starts_with("Static Ip Charge"));
        assert!(spare.to_date > 0.0);
        assert!(
            e.categories
                .iter()
                .flat_map(|c| &c.lines)
                .all(|l| l.resource != "plane-ip"),
            "an address in use bills as its machine's IP"
        );

        let run = line(&e, "hindsight", "CPU");
        assert_eq!(run.unit, "vCPU·s");
        assert!(run
            .sku
            .as_deref()
            .unwrap()
            .starts_with("Services CPU (Request-based billing)"));
        assert!(run.to_date > 0.0);

        let assets = line(&e, "veistra-prod-assets", "Stored data");
        assert!(assets
            .sku
            .as_deref()
            .unwrap()
            .starts_with("Standard Storage US Regional"));
        // The archive bucket is multi-region Coldline, which the fixture's
        // catalog leaves out on purpose: it shows, unpriced, with a note.
        let archive = line(&e, "veistra-prod-archive", "Stored data");
        assert!(archive.sku.is_none() && archive.note.is_some());
        assert_eq!(archive.to_date, 0.0);

        let sum: f64 = e.categories.iter().map(|c| c.to_date).sum();
        assert!((e.to_date - sum).abs() < 1e-9);
        assert!(e.forecast >= e.to_date);
        assert!(e.prices_as_of.is_some());
    }

    #[test]
    fn a_tier_is_applied_to_the_skus_whole_month() {
        // Two buckets share the regional Standard price, whose first 5 GiB-months
        // are free. Costed alone, each would get its own free 5; together they get one.
        let sku = Sku {
            id: "S".into(),
            description: "Standard Storage US Regional".into(),
            resource_group: "RegionalStorage".into(),
            usage_type: "OnDemand".into(),
            regions: vec!["us-central1".into()],
            unit: "GiBy.mo".into(),
            tiers: vec![
                billing::Tier {
                    start: 0.0,
                    price: 0.0,
                },
                billing::Tier {
                    start: 5.0,
                    price: 0.02,
                },
            ],
            effective: None,
        };
        let month = Month::of(at("2026-09-30T23:59:59Z"));
        let bucket = |name: &str| Bucket {
            name: name.into(),
            location: "us-central1".into(),
            location_type: "region".into(),
            storage_class: "STANDARD".into(),
        };
        // 10 GiB each, every day of the month.
        let size = |name: &str| Series {
            labels: [("bucket_name".to_string(), name.to_string())].into(),
            points: (1..30)
                .map(|d| monitoring::Point {
                    end: month.start + d * 86_400,
                    value: 10.0 * (1u64 << 30) as f64,
                })
                .collect(),
        };
        let inputs = Inputs {
            buckets: vec![bucket("a"), bucket("b")],
            storage: vec![size("a"), size("b")],
            storage_prices: Arc::new(vec![sku]),
            ..Inputs::default()
        };
        let (categories, _) = price(&inputs, &month);
        let lines = &categories[0].lines;
        assert_eq!(lines.len(), 2);
        assert!(
            (lines[0].forecast - 10.0 * 0.02 * 0.75).abs() < 1e-4,
            "{}",
            lines[0].forecast
        );
        assert!((categories[0].forecast - (20.0 - 5.0) * 0.02).abs() < 1e-4);
        assert_eq!(lines[0].unit_price, Some(0.02));
    }
}
