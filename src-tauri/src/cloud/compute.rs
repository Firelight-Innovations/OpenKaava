//! Compute Engine: list machines by role, and start a stopped one.
//!
//! `docs/cloud-services.md` §7. `TERMINATED` means stopped. Agent VMs stop
//! themselves when idle, so the UI offers a Start control. [`start`] is the
//! only write in this module and must only run for a press of that control.

use super::http::{self, Verb};
use super::{is_plain_segment, Cloud, Result, Source, Trouble};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub name: String,
    pub zone: String,
    /// `RUNNING`, `STAGING`, `STOPPING`, `TERMINATED`, and the rarer states
    /// Compute Engine adds (`PROVISIONING`, `SUSPENDED`, `REPAIRING`).
    pub status: String,
    pub machine_type: String,
    pub role: Option<String>,
    pub last_start: Option<String>,
    pub last_stop: Option<String>,
}

/// The fields of Compute Engine's instance resource this reads. A fixture's
/// `instances.json` is an array of these, in the API's own shape.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Instance {
    name: String,
    #[serde(default)]
    zone: String,
    status: String,
    #[serde(default)]
    machine_type: String,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_start_timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_stop_timestamp: Option<String>,
    /// Everything else, kept so a fixture `start` rewrites `instances.json`
    /// without dropping the fields `inventory` reads.
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

impl From<Instance> for Machine {
    fn from(i: Instance) -> Self {
        Machine {
            name: i.name,
            zone: last_segment(&i.zone),
            status: i.status,
            machine_type: last_segment(&i.machine_type),
            role: i.labels.get("role").cloned(),
            last_start: i.last_start_timestamp,
            last_stop: i.last_stop_timestamp,
        }
    }
}

fn last_segment(url: &str) -> String {
    url.rsplit('/').next().unwrap_or(url).to_string()
}

/// Every machine labelled `role=<role>`, sorted by name.
pub fn list(cloud: &Cloud, source: &Source, role: &str) -> Result<Vec<Machine>> {
    let mut machines: Vec<Machine> = match source {
        Source::Live { project } => list_live(cloud, project, role)?,
        Source::Fixture { root } => read_fixture(root)?
            .into_iter()
            .filter(|i| i.labels.get("role").map(String::as_str) == Some(role))
            .map(Machine::from)
            .collect(),
    };
    machines.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(machines)
}

/// Ask Compute Engine to start `machine`. Returns once the request is
/// accepted, not once the machine is up; the next list shows `STAGING`.
pub fn start(cloud: &Cloud, source: &Source, machine: &Machine) -> Result<()> {
    if !is_plain_segment(&machine.name) || !is_plain_segment(&machine.zone) {
        return Err(Trouble::Missing {
            what: format!("machine {:?}", machine.name),
        });
    }
    match source {
        Source::Live { project } => {
            let url = format!(
                "https://compute.googleapis.com/compute/v1/projects/{}/zones/{}/instances/{}/start",
                http::encode(project),
                machine.zone,
                machine.name
            );
            http::send(
                &cloud.tokens,
                Verb::Post,
                &url,
                &format!("machine {}", machine.name),
                None,
                1 << 20,
            )?;
            Ok(())
        }
        Source::Fixture { root } => {
            let mut instances = read_fixture(root)?;
            for i in instances.iter_mut().filter(|i| i.name == machine.name) {
                i.status = "RUNNING".into();
            }
            let text = serde_json::to_string_pretty(&instances).map_err(|e| Trouble::Fixture {
                detail: e.to_string(),
            })?;
            std::fs::write(root.join("compute").join("instances.json"), text).map_err(|e| {
                Trouble::Fixture {
                    detail: e.to_string(),
                }
            })
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Aggregated {
    #[serde(default)]
    items: BTreeMap<String, Scoped>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct Scoped {
    #[serde(default)]
    instances: Vec<Instance>,
}

fn list_live(cloud: &Cloud, project: &str, role: &str) -> Result<Vec<Machine>> {
    let mut machines = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut url = format!(
            "https://compute.googleapis.com/compute/v1/projects/{}/aggregated/instances?filter={}&returnPartialSuccess=true",
            http::encode(project),
            http::encode(&format!("labels.role={role}"))
        );
        if let Some(t) = &token {
            url.push_str(&format!("&pageToken={}", http::encode(t)));
        }
        let reply = http::send(
            &cloud.tokens,
            Verb::Get,
            &url,
            &format!("project {project}"),
            None,
            8 << 20,
        )?;
        let page: Aggregated = serde_json::from_slice(&reply.body).map_err(|e| Trouble::Api {
            status: 200,
            detail: format!("unreadable instance list: {e}"),
        })?;
        machines.extend(
            page.items
                .into_values()
                .flat_map(|s| s.instances)
                .map(Machine::from),
        );
        match page.next_page_token {
            Some(t) if !t.is_empty() => token = Some(t),
            _ => return Ok(machines),
        }
    }
}

fn read_fixture(root: &Path) -> Result<Vec<Instance>> {
    let path = root.join("compute").join("instances.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(Trouble::Fixture {
                detail: format!("{}: {e}", path.display()),
            })
        }
    };
    serde_json::from_str(&text).map_err(|e| Trouble::Fixture {
        detail: format!("{}: {e}", path.display()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(json: &str) -> (tempfile::TempDir, Source) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("compute")).unwrap();
        std::fs::write(dir.path().join("compute/instances.json"), json).unwrap();
        let source = Source::Fixture {
            root: dir.path().to_path_buf(),
        };
        (dir, source)
    }

    const TWO: &str = r#"[
      {"name":"kaava-worker","zone":"https://x/zones/us-central1-a","status":"TERMINATED",
       "machineType":"https://x/machineTypes/e2-standard-8","labels":{"role":"agent"}},
      {"name":"kaava-gpu","zone":"https://x/zones/us-central1-a","status":"TERMINATED",
       "machineType":"https://x/machineTypes/g2-standard-8","labels":{"role":"gpu"}}
    ]"#;

    #[test]
    fn list_filters_by_role_and_shortens_urls() {
        let (_dir, source) = fixture(TWO);
        let machines = list(&Cloud::default(), &source, "agent").unwrap();
        assert_eq!(machines.len(), 1);
        assert_eq!(machines[0].name, "kaava-worker");
        assert_eq!(machines[0].zone, "us-central1-a");
        assert_eq!(machines[0].machine_type, "e2-standard-8");
    }

    #[test]
    fn start_in_a_fixture_marks_the_machine_running() {
        let (_dir, source) = fixture(TWO);
        let cloud = Cloud::default();
        let worker = list(&cloud, &source, "agent").unwrap().remove(0);
        start(&cloud, &source, &worker).unwrap();
        assert_eq!(list(&cloud, &source, "agent").unwrap()[0].status, "RUNNING");
        assert_eq!(
            list(&cloud, &source, "gpu").unwrap()[0].status,
            "TERMINATED"
        );
    }

    #[test]
    fn start_in_a_fixture_keeps_fields_it_does_not_read() {
        let (dir, source) = fixture(
            r#"[{"name":"kaava-worker","zone":"z/us-central1-a","status":"TERMINATED",
                 "labels":{"role":"agent"},"scheduling":{"provisioningModel":"SPOT"}}]"#,
        );
        let cloud = Cloud::default();
        let worker = list(&cloud, &source, "agent").unwrap().remove(0);
        start(&cloud, &source, &worker).unwrap();
        let text = std::fs::read_to_string(dir.path().join("compute/instances.json")).unwrap();
        assert!(text.contains("\"provisioningModel\": \"SPOT\""), "{text}");
    }

    #[test]
    fn a_fixture_with_no_compute_file_has_no_machines() {
        let dir = tempfile::tempdir().unwrap();
        let source = Source::Fixture {
            root: dir.path().to_path_buf(),
        };
        assert!(list(&Cloud::default(), &source, "agent")
            .unwrap()
            .is_empty());
    }
}
