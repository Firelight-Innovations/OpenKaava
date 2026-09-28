//! What exists in the project and bills while it does: machines, disks,
//! reserved addresses, buckets and Cloud Run services.
//!
//! Every read here lists; none changes anything. Fixtures sit beside the
//! Agents app's: `compute/{instances,machineTypes,disks,addresses}.json`,
//! `storage/buckets.json` and `run/services.json`, each a plain array (or,
//! for machine types, a map by name) in the API's own resource shape.

use super::{fixture_json, get_json, http, parse_rfc3339, Cloud, Result, Source};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, PartialEq)]
pub struct Vm {
    pub name: String,
    pub zone: String,
    pub region: String,
    pub status: String,
    pub machine_type: String,
    pub spot: bool,
    pub cpus: f64,
    pub memory_gib: f64,
    /// Accelerator type (`nvidia-l4`) and how many.
    pub gpus: Vec<(String, u32)>,
    pub external_ips: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Disk {
    pub name: String,
    pub region: String,
    /// `pd-balanced`, `pd-standard`, `pd-ssd`, …
    pub kind: String,
    pub size_gib: f64,
    pub created: Option<i64>,
    pub attached_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Address {
    pub name: String,
    pub region: String,
    /// `RESERVED` (billing as idle) or `IN_USE`.
    pub status: String,
    pub external: bool,
    pub created: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Bucket {
    pub name: String,
    /// Lower case, as the catalog writes regions: `us-central1`, `us`.
    pub location: String,
    /// `region`, `dual-region` or `multi-region`.
    pub location_type: String,
    pub storage_class: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunService {
    pub name: String,
    pub region: String,
    pub cpu: f64,
    pub memory_gib: f64,
    /// CPU only while serving (`cpuIdle`), billed per request-time rather
    /// than per instance-time.
    pub request_based: bool,
    pub min_instances: u32,
}

/// `us-central1` from `us-central1-a`.
pub fn region_of(zone: &str) -> String {
    match zone.rsplit_once('-') {
        Some((region, suffix)) if suffix.len() == 1 => region.to_string(),
        _ => zone.to_string(),
    }
}

fn last_segment(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or(url)
}

// --- machines ------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInstance {
    name: String,
    #[serde(default)]
    zone: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    machine_type: String,
    #[serde(default)]
    scheduling: RawScheduling,
    #[serde(default)]
    guest_accelerators: Vec<RawAccelerator>,
    #[serde(default)]
    network_interfaces: Vec<RawInterface>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawScheduling {
    provisioning_model: Option<String>,
    #[serde(default)]
    preemptible: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAccelerator {
    #[serde(default)]
    accelerator_type: String,
    #[serde(default)]
    guest_accelerator_type: String,
    #[serde(default)]
    accelerator_count: u32,
    #[serde(default)]
    guest_accelerator_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInterface {
    #[serde(default)]
    access_configs: Vec<Value>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMachineType {
    #[serde(default)]
    guest_cpus: f64,
    #[serde(default)]
    memory_mb: f64,
    #[serde(default)]
    accelerators: Vec<RawAccelerator>,
}

impl RawAccelerator {
    fn parts(&self) -> (String, u32) {
        let kind = if self.accelerator_type.is_empty() {
            &self.guest_accelerator_type
        } else {
            &self.accelerator_type
        };
        let count = self.accelerator_count.max(self.guest_accelerator_count);
        (last_segment(kind).to_string(), count)
    }
}

/// Every machine in the project, stopped ones included: a stopped machine
/// still pays for its disk, and a started one is a line in the estimate.
pub fn vms(cloud: &Cloud, source: &Source) -> Result<Vec<Vm>> {
    let instances: Vec<RawInstance> = match source {
        Source::Fixture { root } => fixture_json(root, "compute/instances.json")?,
        Source::Live { project } => aggregated(cloud, project, "instances")?,
    };
    let fixture_types: HashMap<String, RawMachineType> = match source {
        Source::Fixture { root } => fixture_json(root, "compute/machineTypes.json")?,
        Source::Live { .. } => HashMap::new(),
    };
    let mut live_types: HashMap<(String, String), RawMachineType> = HashMap::new();
    let mut vms = Vec::new();
    for i in instances {
        let zone = last_segment(&i.zone).to_string();
        let machine_type = last_segment(&i.machine_type).to_string();
        let spec = match source {
            Source::Fixture { .. } => fixture_types
                .get(&machine_type)
                .cloned()
                .unwrap_or_default(),
            Source::Live { project } => {
                let key = (zone.clone(), machine_type.clone());
                if !live_types.contains_key(&key) {
                    let url = format!(
                        "https://compute.googleapis.com/compute/v1/projects/{}/zones/{}/machineTypes/{}",
                        http::encode(project),
                        http::encode(&zone),
                        http::encode(&machine_type)
                    );
                    let spec = get_json(
                        cloud,
                        &url,
                        &format!("machine type {machine_type}"),
                        1 << 20,
                    )?;
                    live_types.insert(key.clone(), spec);
                }
                live_types[&key].clone()
            }
        };
        // A G2 carries its GPU in the machine type; an N1 declares it on the instance.
        let gpus = if i.guest_accelerators.is_empty() {
            &spec.accelerators
        } else {
            &i.guest_accelerators
        };
        vms.push(Vm {
            region: region_of(&zone),
            zone,
            name: i.name,
            status: i.status,
            machine_type,
            spot: i.scheduling.preemptible
                || i.scheduling.provisioning_model.as_deref() == Some("SPOT"),
            cpus: spec.guest_cpus,
            memory_gib: spec.memory_mb / 1024.0,
            gpus: gpus
                .iter()
                .map(RawAccelerator::parts)
                .filter(|g| g.1 > 0)
                .collect(),
            external_ips: i
                .network_interfaces
                .iter()
                .map(|n| n.access_configs.len() as u32)
                .sum(),
        });
    }
    vms.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(vms)
}

// --- disks and addresses ---------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDisk {
    name: String,
    #[serde(default)]
    zone: String,
    #[serde(default)]
    region: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    size_gb: String,
    creation_timestamp: Option<String>,
    #[serde(default)]
    users: Vec<String>,
}

pub fn disks(cloud: &Cloud, source: &Source) -> Result<Vec<Disk>> {
    let raw: Vec<RawDisk> = match source {
        Source::Fixture { root } => fixture_json(root, "compute/disks.json")?,
        Source::Live { project } => aggregated(cloud, project, "disks")?,
    };
    let mut disks: Vec<Disk> = raw
        .into_iter()
        .map(|d| Disk {
            region: if d.region.is_empty() {
                region_of(last_segment(&d.zone))
            } else {
                last_segment(&d.region).to_string()
            },
            kind: last_segment(&d.kind).to_string(),
            size_gib: d.size_gb.parse().unwrap_or(0.0),
            created: d.creation_timestamp.as_deref().and_then(parse_rfc3339),
            attached_to: d.users.first().map(|u| last_segment(u).to_string()),
            name: d.name,
        })
        .collect();
    disks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(disks)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAddress {
    name: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    status: String,
    address_type: Option<String>,
    creation_timestamp: Option<String>,
}

pub fn addresses(cloud: &Cloud, source: &Source) -> Result<Vec<Address>> {
    let raw: Vec<RawAddress> = match source {
        Source::Fixture { root } => fixture_json(root, "compute/addresses.json")?,
        Source::Live { project } => aggregated(cloud, project, "addresses")?,
    };
    let mut all: Vec<Address> = raw
        .into_iter()
        .map(|a| Address {
            region: if a.region.is_empty() {
                "global".into()
            } else {
                last_segment(&a.region).to_string()
            },
            status: a.status,
            // Compute Engine leaves `addressType` out for EXTERNAL.
            external: a.address_type.as_deref().unwrap_or("EXTERNAL") == "EXTERNAL",
            created: a.creation_timestamp.as_deref().and_then(parse_rfc3339),
            name: a.name,
        })
        .collect();
    all.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(all)
}

/// Every page of `aggregated/<collection>`, flattened across zones or regions.
fn aggregated<T: DeserializeOwned>(
    cloud: &Cloud,
    project: &str,
    collection: &str,
) -> Result<Vec<T>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        #[serde(default)]
        items: BTreeMap<String, BTreeMap<String, Value>>,
        next_page_token: Option<String>,
    }
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut url = format!(
            "https://compute.googleapis.com/compute/v1/projects/{}/aggregated/{collection}?returnPartialSuccess=true",
            http::encode(project)
        );
        if let Some(t) = &token {
            url.push_str(&format!("&pageToken={}", http::encode(t)));
        }
        let page: Page = get_json(cloud, &url, &format!("project {project}"), 16 << 20)?;
        for scoped in page.items.into_values() {
            if let Some(list) = scoped.get(collection) {
                let items: Vec<T> =
                    serde_json::from_value(list.clone()).map_err(|e| super::Trouble::Api {
                        status: 200,
                        detail: format!("unreadable {collection}: {e}"),
                    })?;
                out.extend(items);
            }
        }
        match page.next_page_token {
            Some(t) if !t.is_empty() => token = Some(t),
            _ => return Ok(out),
        }
    }
}

// --- buckets ---------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBucket {
    name: String,
    #[serde(default)]
    location: String,
    #[serde(default)]
    location_type: String,
    #[serde(default)]
    storage_class: String,
}

pub fn buckets(cloud: &Cloud, source: &Source) -> Result<Vec<Bucket>> {
    let raw: Vec<RawBucket> = match source {
        Source::Fixture { root } => fixture_json(root, "storage/buckets.json")?,
        Source::Live { project } => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Page {
                #[serde(default)]
                items: Vec<RawBucket>,
                next_page_token: Option<String>,
            }
            let mut all = Vec::new();
            let mut token: Option<String> = None;
            loop {
                let mut url = format!(
                    "https://storage.googleapis.com/storage/v1/b?project={}\
                     &fields=items(name,location,locationType,storageClass),nextPageToken",
                    http::encode(project)
                );
                if let Some(t) = &token {
                    url.push_str(&format!("&pageToken={}", http::encode(t)));
                }
                let page: Page = get_json(cloud, &url, &format!("project {project}"), 4 << 20)?;
                all.extend(page.items);
                match page.next_page_token {
                    Some(t) if !t.is_empty() => token = Some(t),
                    _ => break all,
                }
            }
        }
    };
    let mut buckets: Vec<Bucket> = raw
        .into_iter()
        .map(|b| Bucket {
            name: b.name,
            location: b.location.to_lowercase(),
            location_type: b.location_type,
            storage_class: b.storage_class,
        })
        .collect();
    buckets.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(buckets)
}

// --- Cloud Run ---------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawService {
    name: String,
    #[serde(default)]
    template: RawTemplate,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTemplate {
    #[serde(default)]
    containers: Vec<RawContainer>,
    #[serde(default)]
    scaling: RawScaling,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawScaling {
    #[serde(default)]
    min_instance_count: u32,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawContainer {
    #[serde(default)]
    resources: RawResources,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawResources {
    #[serde(default)]
    limits: BTreeMap<String, String>,
    cpu_idle: Option<bool>,
}

pub fn run_services(cloud: &Cloud, source: &Source) -> Result<Vec<RunService>> {
    let raw: Vec<RawService> = match source {
        Source::Fixture { root } => fixture_json(root, "run/services.json")?,
        Source::Live { project } => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Page {
                #[serde(default)]
                services: Vec<RawService>,
                next_page_token: Option<String>,
            }
            let mut all = Vec::new();
            let mut token: Option<String> = None;
            loop {
                let mut url = format!(
                    "https://run.googleapis.com/v2/projects/{}/locations/-/services",
                    http::encode(project)
                );
                if let Some(t) = &token {
                    url.push_str(&format!("?pageToken={}", http::encode(t)));
                }
                let page: Page = get_json(cloud, &url, &format!("project {project}"), 8 << 20)?;
                all.extend(page.services);
                match page.next_page_token {
                    Some(t) if !t.is_empty() => token = Some(t),
                    _ => break all,
                }
            }
        }
    };
    let mut services: Vec<RunService> = raw
        .into_iter()
        .map(|s| {
            // projects/<p>/locations/<region>/services/<name>
            let parts: Vec<&str> = s.name.split('/').collect();
            let region = parts.get(3).copied().unwrap_or("").to_string();
            let name = parts.last().copied().unwrap_or("").to_string();
            let (mut cpu, mut memory_gib, mut request_based) = (0.0, 0.0, true);
            for c in &s.template.containers {
                cpu += c.resources.limits.get("cpu").map_or(1.0, |v| parse_cpu(v));
                memory_gib += c
                    .resources
                    .limits
                    .get("memory")
                    .map_or(0.5, |v| parse_memory_gib(v));
                request_based &= c.resources.cpu_idle.unwrap_or(true);
            }
            RunService {
                name,
                region,
                cpu,
                memory_gib,
                request_based,
                min_instances: s.template.scaling.min_instance_count,
            }
        })
        .collect();
    services.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(services)
}

/// `1`, `2`, `1000m` — Kubernetes quantities, as Cloud Run writes them.
pub fn parse_cpu(text: &str) -> f64 {
    match text.strip_suffix('m') {
        Some(milli) => milli.parse::<f64>().map_or(0.0, |m| m / 1000.0),
        None => text.parse().unwrap_or(0.0),
    }
}

/// `512Mi`, `2Gi`, `1G` in GiB.
pub fn parse_memory_gib(text: &str) -> f64 {
    const SUFFIXES: [(&str, f64); 6] = [
        ("Ki", 1024.0),
        ("Mi", 1024.0 * 1024.0),
        ("Gi", 1024.0 * 1024.0 * 1024.0),
        ("K", 1e3),
        ("M", 1e6),
        ("G", 1e9),
    ];
    for (suffix, bytes) in SUFFIXES {
        if let Some(n) = text.strip_suffix(suffix) {
            return n
                .parse::<f64>()
                .map_or(0.0, |n| n * bytes / (1u64 << 30) as f64);
        }
    }
    text.parse::<f64>().map_or(0.0, |b| b / (1u64 << 30) as f64)
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
    fn machines_carry_their_specs_gpus_and_spot_flag() {
        let vms = vms(&Cloud::default(), &fixtures()).unwrap();
        let gpu = vms.iter().find(|v| v.name == "kaava-gpu").unwrap();
        assert_eq!(gpu.region, "us-central1");
        assert_eq!(gpu.cpus, 8.0);
        assert_eq!(gpu.memory_gib, 32.0);
        assert_eq!(gpu.gpus, vec![("nvidia-l4".to_string(), 1)]);
        assert!(!gpu.spot);
        let spot = vms.iter().find(|v| v.name == "kaava-worker-2").unwrap();
        assert!(spot.spot);
        assert_eq!(spot.external_ips, 1);
    }

    #[test]
    fn disks_addresses_buckets_and_services_read() {
        let (cloud, source) = (Cloud::default(), fixtures());
        let disks = disks(&cloud, &source).unwrap();
        assert_eq!(disks.len(), 4);
        assert_eq!(disks[0].kind, "pd-balanced");
        assert_eq!(disks[0].attached_to.as_deref(), Some("kaava-gpu"));
        let spare = addresses(&cloud, &source)
            .unwrap()
            .into_iter()
            .find(|a| a.name == "spare-ip")
            .unwrap();
        assert_eq!((spare.status.as_str(), spare.external), ("RESERVED", true));
        let buckets = buckets(&cloud, &source).unwrap();
        assert_eq!(buckets[0].location, "us");
        let run = run_services(&cloud, &source).unwrap();
        assert_eq!(run[0].name, "hindsight");
        assert_eq!(run[0].region, "us-central1");
        assert_eq!((run[0].cpu, run[0].memory_gib), (1.0, 0.5));
        assert!(run[0].request_based);
    }

    #[test]
    fn quantities_parse_as_cloud_run_writes_them() {
        assert_eq!(parse_cpu("1000m"), 1.0);
        assert_eq!(parse_cpu("2"), 2.0);
        assert_eq!(parse_memory_gib("512Mi"), 0.5);
        assert_eq!(parse_memory_gib("2Gi"), 2.0);
        assert!((parse_memory_gib("1G") - 0.931).abs() < 1e-3);
    }

    #[test]
    fn a_region_is_a_zone_without_its_letter() {
        assert_eq!(region_of("us-central1-a"), "us-central1");
        assert_eq!(region_of("us-central1"), "us-central1");
    }
}
