//! The Blender Viewer's Rust half.
//!
//! `docs/KAAVA-UX-REWORK.md` §3.1-3.2: Blender is never embedded. This app
//! finds a Blender install, opens a `.blend` in the real editor (detached),
//! and runs `blender -b` with a bundled script to *export*: a `.glb`, preview
//! renders and a parts list, cached under `.kaava/blender/`. The viewer shows
//! that export and its age, never the live scene. The machinery is in
//! [`crate::blender`]; this file is the RPC surface over it.
//!
//! Methods: `state`, `image`, `detect`, `set-executable`, `export-start`,
//! `export-status`, `export-cancel`, `open`. Comments anchored to a mesh part
//! (§3.4) go through [`crate::comments`], shared with every other viewer.

use crate::apps::CallContext;
use crate::blender::detect::{self, Detected, RealHost, VersionCache};
use crate::blender::job::{Jobs, Spec};
use crate::blender::{self, keys, Manifest};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The settings this app reads, gathered once per call.
#[derive(Debug, Clone, Default)]
pub struct Config {
    pub executable: String,
    pub engine: String,
    pub resolution: u32,
    pub export_dir: String,
}

fn config(app: &AppHandle) -> Config {
    Config {
        executable: crate::settings::text(app, keys::EXECUTABLE),
        engine: crate::settings::text(app, keys::ENGINE),
        resolution: crate::settings::number(app, keys::RESOLUTION).clamp(64, 4096) as u32,
        export_dir: crate::settings::text(app, keys::EXPORT_DIR),
    }
}

/// Everything a method needs besides its params, so [`dispatch`] runs in tests
/// without an `AppHandle`.
pub struct Services<'a> {
    pub config: Config,
    pub jobs: &'a Jobs,
    pub versions: &'a VersionCache,
    pub host: &'a dyn detect::Host,
    /// The cluster is on `main`: nothing may be written into the checkout.
    pub read_only: bool,
}

pub fn call(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    if method == "blender-viewer/set-executable" {
        return set_executable(app, params.as_ref());
    }
    let read_only = context.cluster_id.as_deref().is_some_and(|cluster| {
        app.state::<crate::shell_state::ShellState>()
            .cluster_environment(cluster)
            .is_some_and(|env| env.is_main())
    });
    let services = Services {
        config: config(app),
        jobs: &app.state::<Jobs>(),
        versions: &app.state::<VersionCache>(),
        host: &RealHost,
        read_only,
    };
    dispatch(context, &services, method, params)
}

/// "Open in Blender" for a path the caller already has, from the Files app's
/// context menu as well as from this viewer.
pub fn open_in_blender(app: &AppHandle, path: &Path) -> Result<Value, RpcError> {
    let cfg = config(app);
    open(&cfg, &RealHost, &app.state::<VersionCache>(), path)
}

pub fn dispatch(
    context: &CallContext,
    services: &Services,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    if let Some(result) = crate::comments::call(context, method, params.as_ref()) {
        return result;
    }

    match method {
        "blender-viewer/state" => state(context, services, params.as_ref()),
        "blender-viewer/image" => image(context, params.as_ref()),
        "blender-viewer/glb" => glb(context, params.as_ref()),
        "blender-viewer/markup-save" => markup_save(context, params.as_ref()),
        "blender-viewer/markup" => markup_load(context, params.as_ref()),
        "blender-viewer/detect" => {
            services.versions.forget();
            Ok(json!(detected(services)))
        }
        "blender-viewer/export-start" => export_start(context, services, params.as_ref()),
        "blender-viewer/export-status" => Ok(json!(services.jobs.snapshot())),
        "blender-viewer/export-cancel" => Ok(json!({ "cancelled": services.jobs.cancel() })),
        "blender-viewer/open" => {
            let blend = required_str(params.as_ref(), "blend")?;
            open(
                &services.config,
                services.host,
                services.versions,
                Path::new(&blend),
            )
        }
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(INVALID_PARAMS, message.into())
}

fn required_str(params: Option<&Value>, key: &str) -> Result<String, RpcError> {
    params
        .and_then(|p| p.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| invalid(format!("`{key}` is required")))
}

fn detected(services: &Services) -> Detected {
    detect::detect(
        services.host,
        &services.config.executable,
        services.versions,
    )
}

fn project_of(context: &CallContext) -> Result<&Path, RpcError> {
    context
        .project
        .as_deref()
        .ok_or_else(|| invalid("this cluster has no environment — open a project first"))
}

/// The `.blend` a request names, as an absolute path inside the project plus
/// its project-relative form. Refuses anything that is not a `.blend` there.
fn resolve_blend(project: &Path, raw: &str) -> Result<(PathBuf, String), RpcError> {
    let path = PathBuf::from(raw);
    let path = if path.is_absolute() {
        path
    } else {
        project.join(path)
    };
    let rel = blender::relative_blend(project, &path).ok_or_else(|| {
        invalid(format!(
            "{raw} is not a .blend file inside this environment"
        ))
    })?;
    Ok((path, rel))
}

fn state(
    context: &CallContext,
    services: &Services,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    let blender = detected(services);
    let job = services.jobs.snapshot();

    let Some(project) = context.project.as_deref() else {
        return Ok(json!({
            "blender": blender, "project": false, "readOnly": services.read_only,
            "blends": [], "blend": null, "rel": null,
            "model": null, "parts": [], "renders": [], "job": job,
        }));
    };

    let blends = blender::find_blends(project);
    let requested = params.and_then(|p| p.get("blend")).and_then(Value::as_str);
    // A path from before the project changed is no longer inside it: fall back
    // to this project's first .blend (or none) rather than failing the poll.
    let selected = requested
        .and_then(|raw| resolve_blend(project, raw).ok())
        .or_else(|| {
            blends
                .first()
                .and_then(|b| resolve_blend(project, &b.path).ok())
        });

    let mut value = json!({
        "blender": blender, "project": true, "readOnly": services.read_only,
        "blends": blends, "blend": null, "rel": null,
        "model": null, "parts": [], "renders": [], "job": job,
    });
    let Some((path, rel)) = selected else {
        return Ok(value);
    };

    let cache = blender::cache_dir(project, &rel);
    let current_mtime = blender::mtime_ms(&path);
    value["blend"] = json!(path.display().to_string());
    value["rel"] = json!(rel);
    value["blendMtime"] = json!(current_mtime);

    if let Some(m) = blender::read_manifest(&cache) {
        value["model"] = json!(m.glb);
        value["glbBytes"] = json!(m.glb_bytes);
        value["exportedAt"] = json!(m.exported_at);
        value["stale"] = json!(current_mtime != Some(m.blend_mtime));
        value["engine"] = json!(m.engine);
        value["resolution"] = json!(m.resolution);
        value["blenderVersion"] = json!(m.blender_version);
        value["stats"] = m.stats.clone();
        value["warnings"] = json!(m.warnings);
        value["parts"] = json!(m.parts);
        value["renders"] = json!(m
            .renders
            .iter()
            .map(|r| json!({ "id": r.id, "label": r.label, "createdAt": m.exported_at }))
            .collect::<Vec<_>>());
    }
    Ok(value)
}

/// One render's PNG, base64. Looked up by id in the manifest rather than by a
/// caller-supplied file name, so a request cannot name any other file.
fn image(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    let project = project_of(context)?;
    let (_, rel) = resolve_blend(project, &required_str(params, "blend")?)?;
    let id = required_str(params, "id")?;
    let cache = blender::cache_dir(project, &rel);
    let manifest: Manifest = blender::read_manifest(&cache)
        .ok_or_else(|| invalid("this file has not been exported yet"))?;
    let render = manifest
        .renders
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| invalid(format!("no render `{id}` in this export")))?;
    let file = cache.join("renders").join(&render.file);
    let bytes = std::fs::read(&file).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not read {}: {e}", file.display()),
        )
    })?;
    Ok(json!({ "mime": "image/png", "base64": BASE64.encode(bytes) }))
}

/// The exported `.glb`, base64, for the 3D preview. Reads the file the last
/// export's manifest names, never a caller-supplied path.
fn glb(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    let project = project_of(context)?;
    let (_, rel) = resolve_blend(project, &required_str(params, "blend")?)?;
    let cache = blender::cache_dir(project, &rel);
    let manifest: Manifest = blender::read_manifest(&cache)
        .ok_or_else(|| invalid("this file has not been exported yet"))?;
    let file = manifest
        .glb
        .ok_or_else(|| invalid("this export has no .glb"))?;
    let bytes = std::fs::read(&file)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not read {file}: {e}")))?;
    Ok(json!({ "base64": BASE64.encode(&bytes), "size": bytes.len() }))
}

/// Keeps the markup picture and JSON for a `.blend`, beside its export cache.
fn markup_save(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    let project = project_of(context)?;
    let (_, rel) = resolve_blend(project, &required_str(params, "blend")?)?;
    let png = BASE64
        .decode(required_str(params, "pngBase64")?)
        .map_err(|e| invalid(format!("pngBase64 is not base64: {e}")))?;
    let json = required_str(params, "json")?;
    let saved_at = blender::write_markup(&blender::cache_dir(project, &rel), &png, &json)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e))?;
    Ok(json!({ "savedAt": saved_at }))
}

/// `null` when nothing has been marked up on this `.blend` yet.
fn markup_load(context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    let project = project_of(context)?;
    let (_, rel) = resolve_blend(project, &required_str(params, "blend")?)?;
    Ok(
        match blender::read_markup(&blender::cache_dir(project, &rel)) {
            Some(m) => json!({
                "png": BASE64.encode(m.png),
                "json": m.json,
                "savedAt": m.saved_at,
            }),
            None => Value::Null,
        },
    )
}

const KNOWN_VIEWS: &[&str] = &["front", "three-quarter", "side", "wire"];

fn export_start(
    context: &CallContext,
    services: &Services,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    let project = project_of(context)?;
    let (blend, rel) = resolve_blend(project, &required_str(params, "blend")?)?;

    let exe = match detect::find(services.host, &services.config.executable).hit {
        Some((_, path)) => path,
        None => {
            return Err(invalid(
                "Blender was not found — set its path in Settings > Blender, or in this viewer",
            ))
        }
    };

    let cache = blender::cache_dir(project, &rel);
    let export_dir = services.config.export_dir.trim();
    // The cache is Kaava state and always allowed. A .glb written into the
    // checkout is a write to it, which main refuses (docs/KAAVA-UX-REWORK.md §2.3).
    if !export_dir.is_empty() && services.read_only {
        return Err(RpcError::new(
            crate::apps::READ_ONLY,
            "main is read-only — the .glb export folder is set, so exporting would write into the \
             checkout. Open a worktree, or clear Settings > Blender > Export the .glb into.",
        ));
    }
    let glb_target = blender::glb_target(project, &cache, &rel, export_dir).map_err(invalid)?;

    let views: Vec<String> = match params
        .and_then(|p| p.get("views"))
        .and_then(Value::as_array)
    {
        Some(list) => list
            .iter()
            .filter_map(Value::as_str)
            .filter(|v| KNOWN_VIEWS.contains(v))
            .map(str::to_string)
            .collect(),
        None => KNOWN_VIEWS.iter().map(|v| v.to_string()).collect(),
    };

    let root = blender::cache_root(project);
    std::fs::create_dir_all(&root).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not create {}: {e}", root.display()),
        )
    })?;
    let script = root.join("_export.py");
    std::fs::write(&script, blender::EXPORT_SCRIPT).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not write {}: {e}", script.display()),
        )
    })?;

    let pending = cache.join("pending");
    let _ = std::fs::remove_dir_all(&pending);
    let spec = Spec {
        exe,
        blend: blend.clone(),
        script,
        out_dir: pending.clone(),
        engine: services.config.engine.clone(),
        resolution: services.config.resolution,
        views,
        timeout: Duration::from_secs(15 * 60),
        log_path: Some(cache.join("export.log")),
    };

    let base = Manifest {
        blend: rel.clone(),
        blend_mtime: blender::mtime_ms(&blend).unwrap_or(0),
        exported_at: 0,
        engine: spec.engine.clone(),
        resolution: spec.resolution,
        blender_version: String::new(),
        glb: None,
        glb_bytes: None,
        renders: vec![],
        parts: vec![],
        stats: Value::Null,
        warnings: vec![],
    };
    let finish_cache = cache.clone();
    services
        .jobs
        .start(rel, spec, move |result| {
            blender::commit(&finish_cache, &pending, &glb_target, result, base).map(|_| ())
        })
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e))?;
    Ok(json!({ "started": true }))
}

fn open(
    config: &Config,
    host: &dyn detect::Host,
    versions: &VersionCache,
    blend: &Path,
) -> Result<Value, RpcError> {
    if !blend.is_file() {
        return Err(invalid(format!("{} does not exist", blend.display())));
    }
    let found = detect::detect(host, &config.executable, versions);
    let Some(exe) = found.path else {
        return Err(invalid(
            "Blender was not found — set its path in Settings > Blender, or in the Blender Viewer",
        ));
    };
    blender::launch_detached(Path::new(&exe), blend)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e))?;
    Ok(json!({ "launched": true, "executable": exe }))
}

/// Save a Blender path from the viewer's setup panel, after checking that it
/// answers `--version` like Blender does. Empty clears it back to auto-detect.
fn set_executable(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let raw = required_str(params, "path")?;
    let raw = raw.trim();
    if !raw.is_empty() {
        let path = Path::new(raw);
        let resolved = if path.is_dir() {
            path.join(if cfg!(windows) {
                "blender.exe"
            } else {
                "blender"
            })
        } else {
            path.to_path_buf()
        };
        if detect::probe_version(&resolved).is_none() {
            return Err(invalid(format!(
                "{} did not answer `--version` like Blender does",
                resolved.display()
            )));
        }
    }
    let registry = app.state::<crate::settings::Registry>();
    crate::settings::commands::settings_set(
        app.clone(),
        registry,
        keys::EXECUTABLE.to_string(),
        json!(raw),
    )
    .map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;
    app.state::<VersionCache>().forget();
    Ok(json!(detect::detect(
        &RealHost,
        raw,
        &app.state::<VersionCache>()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blender::detect::tests::FakeHost;
    use crate::blender::job::tests::fake_blender;
    use tempfile::TempDir;

    fn context(root: &Path) -> CallContext {
        CallContext {
            cluster_id: Some("c1".to_string()),
            project: Some(root.to_path_buf()),
        }
    }

    struct Fixture {
        jobs: Jobs,
        versions: VersionCache,
        host: FakeHost,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                jobs: Jobs::default(),
                versions: VersionCache::default(),
                host: FakeHost::default(),
            }
        }
        fn services(&self, config: Config, read_only: bool) -> Services<'_> {
            Services {
                config,
                jobs: &self.jobs,
                versions: &self.versions,
                host: &self.host,
                read_only,
            }
        }
    }

    fn config_with(exe: &Path) -> Config {
        Config {
            executable: exe.display().to_string(),
            engine: "workbench".into(),
            resolution: 128,
            export_dir: String::new(),
        }
    }

    fn wait(jobs: &Jobs) {
        let until = std::time::Instant::now() + Duration::from_secs(30);
        while jobs.snapshot().running && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn state_reports_no_model_until_an_export_exists() {
        let env = TempDir::new().expect("tempdir");
        let fx = Fixture::new();
        let value = dispatch(
            &context(env.path()),
            &fx.services(Config::default(), false),
            "blender-viewer/state",
            None,
        )
        .expect("state");

        assert_eq!(value["model"], Value::Null);
        assert_eq!(value["parts"], json!([]));
        assert_eq!(value["renders"], json!([]));
        assert_eq!(value["blender"]["found"], false);
        assert_eq!(value["blends"], json!([]));
    }

    #[test]
    fn state_drops_a_blend_from_another_project() {
        let old = TempDir::new().expect("tempdir");
        let stale = old.path().join("room.blend");
        std::fs::write(&stale, b"x").expect("write");
        let env = TempDir::new().expect("tempdir");
        let fx = Fixture::new();
        let services = fx.services(Config::default(), false);
        let params = json!({ "blend": stale.display().to_string() });

        let empty = dispatch(
            &context(env.path()),
            &services,
            "blender-viewer/state",
            Some(params.clone()),
        )
        .expect("a stale path is not an error");
        assert_eq!(empty["blend"], Value::Null);
        assert_eq!(empty["blends"], json!([]));

        std::fs::write(env.path().join("new.blend"), b"x").expect("write");
        let listed = dispatch(
            &context(env.path()),
            &services,
            "blender-viewer/state",
            Some(params),
        )
        .expect("state");
        assert_eq!(listed["rel"], "new.blend");
    }

    #[test]
    fn an_unknown_method_is_method_not_found() {
        let env = TempDir::new().expect("tempdir");
        let fx = Fixture::new();
        let err = dispatch(
            &context(env.path()),
            &fx.services(Config::default(), false),
            "blender-viewer/nope",
            None,
        )
        .expect_err("unknown method");
        assert_eq!(err.code, kaava_rpc::METHOD_NOT_FOUND);
    }

    #[test]
    fn comment_methods_are_answered_by_the_shared_comments_store() {
        let env = TempDir::new().expect("tempdir");
        let fx = Fixture::new();
        let services = fx.services(Config::default(), false);
        let params = json!({
            "anchor": { "kind": "mesh", "part": "headboard", "material": "oak" },
            "body": "make this thinner",
        });
        let created = dispatch(
            &context(env.path()),
            &services,
            "comments/create",
            Some(params),
        )
        .expect("create");
        assert_eq!(created["anchor"]["kind"], "mesh");

        let listed =
            dispatch(&context(env.path()), &services, "comments/list", None).expect("list");
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn export_refuses_a_file_outside_the_environment() {
        let env = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        std::fs::write(elsewhere.path().join("x.blend"), b"b").unwrap();
        let fx = Fixture::new();
        let err = dispatch(
            &context(env.path()),
            &fx.services(Config::default(), false),
            "blender-viewer/export-start",
            Some(json!({ "blend": elsewhere.path().join("x.blend").display().to_string() })),
        )
        .unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn export_without_a_blender_says_where_to_set_one() {
        let env = TempDir::new().unwrap();
        std::fs::write(env.path().join("bed.blend"), b"b").unwrap();
        let fx = Fixture::new();
        let err = dispatch(
            &context(env.path()),
            &fx.services(Config::default(), false),
            "blender-viewer/export-start",
            Some(json!({ "blend": "bed.blend" })),
        )
        .unwrap_err();
        assert!(err.message.contains("Settings"), "{}", err.message);
    }

    #[test]
    fn a_configured_export_folder_is_refused_on_main_but_the_cache_is_not() {
        let env = TempDir::new().unwrap();
        let tools = TempDir::new().unwrap();
        let exe = fake_blender(tools.path(), "ok");
        std::fs::write(env.path().join("bed.blend"), b"b").unwrap();
        let mut fx = Fixture::new();
        fx.host.files.insert(exe.clone());

        let mut config = config_with(&exe);
        config.export_dir = "assets".into();
        let err = dispatch(
            &context(env.path()),
            &fx.services(config, true),
            "blender-viewer/export-start",
            Some(json!({ "blend": "bed.blend" })),
        )
        .unwrap_err();
        assert_eq!(err.code, crate::apps::READ_ONLY);
        assert!(!env.path().join("assets").exists());

        // Same main, no export folder: the cache is Kaava state and is allowed.
        let started = dispatch(
            &context(env.path()),
            &fx.services(config_with(&exe), true),
            "blender-viewer/export-start",
            Some(json!({ "blend": "bed.blend" })),
        );
        assert!(started.is_ok(), "{started:?}");
        wait(&fx.jobs);
    }

    #[test]
    fn an_export_end_to_end_lands_in_the_cache_and_shows_in_state() {
        let env = TempDir::new().unwrap();
        let tools = TempDir::new().unwrap();
        let exe = fake_blender(tools.path(), "ok");
        std::fs::create_dir_all(env.path().join("art")).unwrap();
        std::fs::write(env.path().join("art/bed.blend"), b"blend").unwrap();
        let mut fx = Fixture::new();
        fx.host.files.insert(exe.clone());
        let ctx = context(env.path());
        let services = fx.services(config_with(&exe), false);

        dispatch(
            &ctx,
            &services,
            "blender-viewer/export-start",
            Some(json!({ "blend": "art/bed.blend" })),
        )
        .unwrap();
        wait(&fx.jobs);
        let status = dispatch(&ctx, &services, "blender-viewer/export-status", None).unwrap();
        assert_eq!(status["outcome"], "ok", "{status}");

        let state = dispatch(&ctx, &services, "blender-viewer/state", None).unwrap();
        assert_eq!(state["rel"], "art/bed.blend");
        assert!(state["model"].as_str().unwrap().ends_with("model.glb"));
        assert_eq!(state["parts"][0]["name"], "Frame");
        assert_eq!(state["parts"][0]["tris"], 12);
        assert_eq!(state["renders"][0]["id"], "front");
        assert_eq!(state["stale"], false);
        assert_eq!(state["warnings"], json!(["a warning"]));

        let image = dispatch(
            &ctx,
            &services,
            "blender-viewer/image",
            Some(json!({ "blend": "art/bed.blend", "id": "front" })),
        )
        .unwrap();
        assert_eq!(image["mime"], "image/png");
        assert!(!image["base64"].as_str().unwrap().is_empty());

        // An id the manifest does not name reads nothing, whatever it looks like.
        let bad = dispatch(
            &ctx,
            &services,
            "blender-viewer/image",
            Some(json!({ "blend": "art/bed.blend", "id": "../../export" })),
        );
        assert!(bad.is_err());

        // Touching the .blend afterwards makes the export stale.
        std::thread::sleep(Duration::from_millis(1100));
        std::fs::write(env.path().join("art/bed.blend"), b"blend, edited").unwrap();
        let state = dispatch(&ctx, &services, "blender-viewer/state", None).unwrap();
        assert_eq!(state["stale"], true);
    }

    #[test]
    fn glb_and_markup_round_trip_per_blend() {
        let env = TempDir::new().unwrap();
        let tools = TempDir::new().unwrap();
        let exe = fake_blender(tools.path(), "ok");
        std::fs::write(env.path().join("bed.blend"), b"b").unwrap();
        std::fs::write(env.path().join("desk.blend"), b"b").unwrap();
        let mut fx = Fixture::new();
        fx.host.files.insert(exe.clone());
        let ctx = context(env.path());
        let services = fx.services(config_with(&exe), false);
        let bed = json!({ "blend": "bed.blend" });

        // Nothing exported yet: no glb, and no markup either.
        let none = dispatch(&ctx, &services, "blender-viewer/glb", Some(bed.clone()));
        assert!(none.is_err());
        let nothing =
            dispatch(&ctx, &services, "blender-viewer/markup", Some(bed.clone())).unwrap();
        assert_eq!(nothing, Value::Null);

        dispatch(
            &ctx,
            &services,
            "blender-viewer/export-start",
            Some(bed.clone()),
        )
        .unwrap();
        wait(&fx.jobs);
        let glb = dispatch(&ctx, &services, "blender-viewer/glb", Some(bed.clone())).unwrap();
        assert!(glb["size"].as_u64().unwrap() > 0);
        assert!(!glb["base64"].as_str().unwrap().is_empty());

        let png = BASE64.encode(b"\x89PNG\r\n\x1a\nrest");
        dispatch(
            &ctx,
            &services,
            "blender-viewer/markup-save",
            Some(json!({ "blend": "bed.blend", "pngBase64": png, "json": "{\"v\":1}" })),
        )
        .unwrap();
        let back = dispatch(&ctx, &services, "blender-viewer/markup", Some(bed.clone())).unwrap();
        assert_eq!(back["json"], "{\"v\":1}");
        assert_eq!(back["png"], png);

        // Another .blend keeps its own, and a non-PNG is refused.
        let other = dispatch(
            &ctx,
            &services,
            "blender-viewer/markup",
            Some(json!({ "blend": "desk.blend" })),
        )
        .unwrap();
        assert_eq!(other, Value::Null);
        let bad = dispatch(
            &ctx,
            &services,
            "blender-viewer/markup-save",
            Some(
                json!({ "blend": "bed.blend", "pngBase64": BASE64.encode(b"nope"), "json": "{}" }),
            ),
        );
        assert!(bad.is_err());
    }

    #[test]
    fn cancel_leaves_the_previous_export_alone() {
        let env = TempDir::new().unwrap();
        let tools = TempDir::new().unwrap();
        let ok = fake_blender(tools.path(), "ok");
        std::fs::write(env.path().join("bed.blend"), b"b").unwrap();
        let mut fx = Fixture::new();
        fx.host.files.insert(ok.clone());
        let ctx = context(env.path());
        let start = json!({ "blend": "bed.blend" });
        {
            let services = fx.services(config_with(&ok), false);
            dispatch(
                &ctx,
                &services,
                "blender-viewer/export-start",
                Some(start.clone()),
            )
            .unwrap();
            wait(&fx.jobs);
        }

        let tools2 = TempDir::new().unwrap();
        let hang = fake_blender(tools2.path(), "hang");
        fx.host.files.insert(hang.clone());
        let services = fx.services(config_with(&hang), false);
        dispatch(
            &ctx,
            &services,
            "blender-viewer/export-start",
            Some(start.clone()),
        )
        .unwrap();
        let second = dispatch(&ctx, &services, "blender-viewer/export-start", Some(start));
        assert!(second.is_err(), "a second export while one runs is refused");
        let cancelled = dispatch(&ctx, &services, "blender-viewer/export-cancel", None).unwrap();
        assert_eq!(cancelled["cancelled"], true);
        wait(&fx.jobs);

        let status = dispatch(&ctx, &services, "blender-viewer/export-status", None).unwrap();
        assert_eq!(status["outcome"], "cancelled");
        let state = dispatch(&ctx, &services, "blender-viewer/state", None).unwrap();
        assert_eq!(
            state["parts"][0]["name"], "Frame",
            "the earlier export survives a cancel"
        );
    }
}
