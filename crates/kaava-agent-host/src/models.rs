//! The models each harness offers, asked of its agent before any session of
//! it runs, so the tab can list them before the first prompt.
//!
//! ACP has no way to ask an agent for its models without a session, so the
//! host opens one: it starts the harness's adapter in the asking tab's
//! worktree, sends `initialize` and `session/new`, reads the option of
//! category `model` from the reply, and kills the agent. It never sends a
//! prompt, so asking spends none of the user's quota. Each harness is asked
//! once per launch in each worktree, since a project's own settings can
//! narrow the list or change the default.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::config;
use crate::event::{AgentCommand, ConfigChoice};
use crate::guard::Worktree;
use crate::harness::{Harness, LaunchSpec};
use crate::job;
use crate::session::{hello, read_line_capped, MESSAGE_LIMIT};

/// The ACP category that marks an option as the session's model.
pub const MODEL_CATEGORY: &str = "model";

/// What one harness offers.
#[derive(Debug, Clone, PartialEq)]
pub struct Models {
    /// The values on offer, in the agent's order.
    pub choices: Vec<ConfigChoice>,
    /// The value a session starts on unless the tab chose another.
    pub default: String,
    /// Commands the adapter advertised without requiring an inference turn.
    pub commands: Vec<AgentCommand>,
}

/// The option of category `model` in a `configOptions` list, if it has one.
pub fn of(list: &Value) -> Option<Models> {
    let option = config::settings(list)
        .options
        .into_iter()
        .find(|o| o.category.as_deref() == Some(MODEL_CATEGORY))?;
    Some(Models {
        choices: option.choices,
        default: option.value,
        commands: Vec::new(),
    })
}

/// Ask the agent `spec` starts for its models, in `worktree`, giving each
/// request `wait` to be answered, as a session's handshake does. `None` if it
/// would not say: it did not start, it did not answer in time, it refused
/// `session/new` (a signed-out Codex does), or it offers no model option.
/// The agent is killed before this returns.
pub fn ask(spec: &LaunchSpec, worktree: &Worktree, wait: Duration) -> Option<Models> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .current_dir(worktree.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for key in &spec.env_remove {
        command.env_remove(key);
    }
    let (mut child, job) = job::spawn(&mut command).ok()?;
    let models = converse(&mut child, worktree, wait);
    job::kill(&mut child, job.as_ref());
    let _ = child.wait();
    models
}

/// `initialize`, then `session/new`, each answered within `wait` before the
/// next is sent.
fn converse(child: &mut Child, worktree: &Worktree, wait: Duration) -> Option<Models> {
    let mut stdin = child.stdin.take()?;
    let lines = read_lines(child.stdout.take()?);
    let cwd = worktree.path().to_string_lossy().into_owned();
    let requests = [
        ("initialize", hello()),
        ("session/new", json!({ "cwd": cwd, "mcpServers": [] })),
    ];
    let mut reply = Value::Null;
    let mut commands = None;
    for (id, (method, params)) in requests.into_iter().enumerate() {
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{request}").ok()?;
        stdin.flush().ok()?;
        reply = answer(&lines, id, Instant::now() + wait, &mut commands)?;
    }
    let mut models = of(reply.get("configOptions")?)?;
    // Some adapters publish their commands just after session/new's response.
    let deadline = Instant::now() + Duration::from_secs(1);
    while commands.is_none() {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let Ok(line) = lines.recv_timeout(left) else {
            break;
        };
        if let Ok(message) = serde_json::from_slice::<Value>(&line) {
            commands = advertised_commands(&message);
        }
    }
    models.commands = commands.unwrap_or_default();
    Some(models)
}

/// Every line the agent writes, from a thread of its own. It ends when the
/// agent's stdout closes, which killing the agent does.
fn read_lines(stdout: impl std::io::Read + Send + 'static) -> Receiver<Vec<u8>> {
    let (lines, got) = mpsc::channel();
    let _ = thread::Builder::new()
        .name("agent-models".to_string())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            while let Ok(Some(_)) = read_line_capped(&mut reader, &mut line, MESSAGE_LIMIT) {
                if lines.send(std::mem::take(&mut line)).is_err() {
                    return;
                }
            }
        });
    got
}

/// The result of request `id`, skipping every other message. `None` for an
/// error, for an agent that stopped writing, and at `deadline`.
fn answer(
    lines: &Receiver<Vec<u8>>,
    id: usize,
    deadline: Instant,
    commands: &mut Option<Vec<AgentCommand>>,
) -> Option<Value> {
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        let line = lines.recv_timeout(left).ok()?;
        let Ok(mut message) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if let Some(advertised) = advertised_commands(&message) {
            *commands = Some(advertised);
        }
        let is_reply = message.get("method").is_none()
            && message.get("id").and_then(Value::as_u64) == Some(id as u64);
        if is_reply {
            return message.get_mut("result").map(Value::take);
        }
    }
}

/// Read only ACP's command notification; ignore unrelated session traffic.
fn advertised_commands(message: &Value) -> Option<Vec<AgentCommand>> {
    let update = message.pointer("/params/update")?;
    if message.get("method").and_then(Value::as_str) != Some("session/update")
        || update.get("sessionUpdate").and_then(Value::as_str) != Some("available_commands_update")
    {
        return None;
    }
    Some(crate::normalize::commands(
        update.get("availableCommands")?.as_array()?,
    ))
}

/// What each harness's agent answered in each worktree, asked once per launch.
#[derive(Default, Clone)]
pub struct Catalogue {
    book: Arc<Mutex<Book>>,
}

#[derive(Default)]
struct Book {
    known: HashMap<Key, Known>,
    /// The asks [`Catalogue::retry`] has forgotten once already.
    retried: HashSet<Key>,
}

/// A harness, and the root of the worktree its agent was asked in.
type Key = (Harness, PathBuf);

#[derive(Debug, Clone)]
enum Known {
    Asking,
    Answered(Option<Models>),
}

impl Catalogue {
    fn book(&self) -> MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// What `harness`'s agent offers in `worktree`, once it has said.
    pub fn models(&self, harness: Harness, worktree: &Path) -> Option<Models> {
        match self.book().known.get(&(harness, worktree.to_path_buf())) {
            Some(Known::Answered(models)) => models.clone(),
            _ => None,
        }
    }

    /// Ask `harness`'s agent in `worktree`, on a thread of its own, unless it
    /// has been asked there already; `then` runs once an answer with models
    /// is in. Whether this started an ask.
    pub fn ask(
        &self,
        harness: Harness,
        worktree: &Path,
        question: impl FnOnce() -> Option<Models> + Send + 'static,
        then: impl FnOnce() + Send + 'static,
    ) -> bool {
        let key = (harness, worktree.to_path_buf());
        {
            let known = &mut self.book().known;
            if known.contains_key(&key) {
                return false;
            }
            known.insert(key.clone(), Known::Asking);
        }
        let catalogue = self.clone();
        let asked = key.clone();
        let started = thread::Builder::new()
            .name("agent-models-ask".to_string())
            .spawn(move || {
                let models = question();
                let answered = models.is_some();
                catalogue
                    .book()
                    .known
                    .insert(asked, Known::Answered(models));
                if answered {
                    then();
                }
            });
        if started.is_err() {
            self.book().known.remove(&key);
        }
        started.is_ok()
    }

    /// Forget an ask that `harness`'s agent did not answer in `worktree`, so
    /// the next [`Catalogue::ask`] there asks again. For once a session of it
    /// has started, which a signed-out Codex's never does. Only the first
    /// retry forgets: an agent that a running session shows is signed in, and
    /// still does not answer, would otherwise be started again on every call.
    pub fn retry(&self, harness: Harness, worktree: &Path) {
        let key = (harness, worktree.to_path_buf());
        let book = &mut *self.book();
        let unanswered = matches!(book.known.get(&key), Some(Known::Answered(None)));
        if unanswered && book.retried.insert(key.clone()) {
            book.known.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn select(id: &str, category: &str, current: &str, values: &[&str]) -> Value {
        let options: Vec<Value> = values
            .iter()
            .map(|v| json!({ "value": v, "name": v.to_uppercase() }))
            .collect();
        json!({ "id": id, "name": id, "category": category, "type": "select",
                "currentValue": current, "options": options })
    }

    fn values(models: &Models) -> Vec<&str> {
        models.choices.iter().map(|c| c.value.as_str()).collect()
    }

    #[test]
    fn the_models_are_the_model_options_choices_and_its_value_the_default() {
        let list = json!([
            select("mode", "mode", "default", &["default", "plan"]),
            select("effort", "thought_level", "medium", &["low", "medium"]),
            select("model", "model", "gpt-5.2", &["gpt-5.2", "gpt-5.2-codex"]),
        ]);
        let models = of(&list).unwrap();
        assert_eq!(values(&models), ["gpt-5.2", "gpt-5.2-codex"]);
        assert_eq!(models.choices[1].name, "GPT-5.2-CODEX");
        assert_eq!(models.default, "gpt-5.2");
    }

    #[test]
    fn a_list_without_a_model_option_has_no_models() {
        let list = json!([select("mode", "mode", "default", &["default"])]);
        assert_eq!(of(&list), None);
        assert_eq!(of(&Value::Null), None);
    }

    const HERE: &str = "C:/wt/a";

    fn answered(catalogue: &Catalogue, harness: Harness) -> bool {
        let key = (harness, PathBuf::from(HERE));
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(catalogue.book().known.get(&key), Some(Known::Answered(_))) {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    fn some_models() -> Option<Models> {
        Some(Models {
            choices: Vec::new(),
            default: "opus".into(),
            commands: Vec::new(),
        })
    }

    fn here() -> &'static Path {
        Path::new(HERE)
    }

    #[test]
    fn each_harness_is_asked_once_and_its_answer_kept() {
        let catalogue = Catalogue::default();
        let (told, heard) = mpsc::channel();
        assert!(
            catalogue.ask(Harness::Claude, here(), some_models, move || {
                told.send(()).unwrap();
            })
        );
        heard.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(catalogue.models(Harness::Claude, here()), some_models());
        assert!(!catalogue.ask(Harness::Claude, here(), some_models, || {}));
        assert_eq!(catalogue.models(Harness::Codex, here()), None);
    }

    /// A project's own settings can narrow an agent's models, so another
    /// worktree's answer is not this one's.
    #[test]
    fn each_worktree_is_asked_on_its_own() {
        let catalogue = Catalogue::default();
        let there = Path::new("C:/wt/b");
        assert!(catalogue.ask(Harness::Claude, here(), some_models, || {}));
        assert!(answered(&catalogue, Harness::Claude));
        assert_eq!(catalogue.models(Harness::Claude, there), None);
        assert!(catalogue.ask(Harness::Claude, there, || None, || {}));
    }

    #[test]
    fn an_unanswered_ask_is_asked_again_only_after_a_retry() {
        let catalogue = Catalogue::default();
        let (told, heard) = mpsc::channel::<()>();
        assert!(catalogue.ask(Harness::Codex, here(), || None, move || drop(told)));
        assert!(answered(&catalogue, Harness::Codex));
        // `then` never ran, so it never sent; its sender is gone with it.
        assert!(heard.recv_timeout(Duration::from_secs(1)).is_err());
        assert!(!catalogue.ask(Harness::Codex, here(), some_models, || {}));
        catalogue.retry(Harness::Codex, here());
        assert!(catalogue.ask(Harness::Codex, here(), some_models, || {}));
        assert!(answered(&catalogue, Harness::Codex));
        assert_eq!(catalogue.models(Harness::Codex, here()), some_models());
    }

    #[test]
    fn an_ask_unanswered_twice_is_never_asked_again() {
        let catalogue = Catalogue::default();
        assert!(catalogue.ask(Harness::Codex, here(), || None, || {}));
        assert!(answered(&catalogue, Harness::Codex));
        catalogue.retry(Harness::Codex, here());
        assert!(catalogue.ask(Harness::Codex, here(), || None, || {}));
        assert!(answered(&catalogue, Harness::Codex));
        catalogue.retry(Harness::Codex, here());
        assert!(!catalogue.ask(Harness::Codex, here(), some_models, || {}));
        assert_eq!(catalogue.models(Harness::Codex, here()), None);
    }

    #[test]
    fn a_retry_keeps_an_answer_with_models() {
        let catalogue = Catalogue::default();
        assert!(catalogue.ask(Harness::Claude, here(), some_models, || {}));
        assert!(answered(&catalogue, Harness::Claude));
        catalogue.retry(Harness::Claude, here());
        assert!(!catalogue.ask(Harness::Claude, here(), || None, || {}));
        assert_eq!(catalogue.models(Harness::Claude, here()), some_models());
    }
}
