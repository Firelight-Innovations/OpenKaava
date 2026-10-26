//! `veistra` — Schematify's command-line entry point. Today this binary has one
//! subcommand, `reconcile` (`SCHEMATIFY-PRD.md` section 9.3):
//!
//! ```text
//! veistra reconcile [--root <path>] [--out <path>] [--format text|json]
//! ```
//!
//! A later wave adding another `veistra` subcommand does so by matching on it
//! in `main` below and adding its own module — this file is not a shared
//! registration list the way `src-tauri/src/apps/mod.rs`'s `REGISTRY` is, so
//! there is nothing else to touch.

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use schematify_reconcile::{
    exit_code, reconcile, render_json, render_text, write_run_files, JsonFileGraph,
};

/// `veistra reconcile`'s two output formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Text,
    Json,
}

struct ReconcileArgs {
    root: PathBuf,
    out: Option<PathBuf>,
    format: Format,
}

fn usage() -> &'static str {
    "usage: veistra reconcile [--root <path>] [--out <path>] [--format text|json]"
}

fn main() -> ExitCode {
    let mut args = env::args();
    args.next(); // argv[0]

    match args.next().as_deref() {
        Some("reconcile") => run_reconcile(args.collect()),
        Some(other) => {
            eprintln!("veistra: unknown command `{other}`");
            eprintln!("{}", usage());
            ExitCode::from(2)
        }
        None => {
            eprintln!("{}", usage());
            ExitCode::from(2)
        }
    }
}

fn parse_args(raw: Vec<String>) -> Result<ReconcileArgs, String> {
    let mut root =
        env::current_dir().map_err(|err| format!("cannot read the working directory: {err}"))?;
    let mut out = None;
    let mut format = Format::Text;

    let mut iter = raw.into_iter();
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--root" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--root requires a path".to_string())?;
                root = PathBuf::from(value);
            }
            "--out" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--out requires a path".to_string())?;
                out = Some(PathBuf::from(value));
            }
            "--format" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--format requires text or json".to_string())?;
                format = match value.as_str() {
                    "text" => Format::Text,
                    "json" => Format::Json,
                    other => {
                        return Err(format!("--format must be `text` or `json`, got `{other}`"))
                    }
                };
            }
            other => return Err(format!("unrecognized argument `{other}`\n{}", usage())),
        }
    }

    Ok(ReconcileArgs { root, out, format })
}

/// Exit code used for every failure that stops `veistra reconcile` before it
/// can even produce a [`schematify_reconcile::ReconcileRun`]: an unparseable
/// argument, or a project that could not be read. PRD section 9.3 names exit
/// code 2 specifically for "the command read no project at that path"; the
/// PRD defines no separate code for a bad argument, so this binary uses the
/// same code for both rather than inventing an undocumented one.
const EXIT_CANNOT_START: u8 = 2;

/// Exit code used when reconciliation itself ran but its results could not be
/// persisted or reported: writing `.veistra/runs/<node-uuid>/reconcile.json`,
/// encoding the `--format json` report, or writing `--out`. This is
/// deliberately distinct from [`EXIT_CANNOT_START`] — PRD section 9.3
/// reserves exit code 2 for "the command read no project at that path," which
/// this is not: the project read fine and reconciliation completed, and only
/// a later I/O step failed. The PRD names no code for this failure class, so
/// this binary claims one it does not already use.
const EXIT_RESULT_NOT_WRITTEN: u8 = 3;

fn run_reconcile(raw_args: Vec<String>) -> ExitCode {
    let args = match parse_args(raw_args) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("veistra reconcile: {message}");
            return ExitCode::from(EXIT_CANNOT_START);
        }
    };

    let graph = match JsonFileGraph::load(&args.root) {
        Ok(graph) => graph,
        Err(err) => {
            eprintln!("veistra reconcile: {err}");
            return ExitCode::from(EXIT_CANNOT_START);
        }
    };

    let run = reconcile(&args.root, &graph);

    if let Err(err) = write_run_files(&args.root, &run) {
        eprintln!("veistra reconcile: {err}");
        return ExitCode::from(EXIT_RESULT_NOT_WRITTEN);
    }

    let rendered = match args.format {
        Format::Text => render_text(&run),
        Format::Json => match render_json(&run) {
            Ok(json) => json,
            Err(err) => {
                eprintln!("veistra reconcile: failed to encode report: {err}");
                return ExitCode::from(EXIT_RESULT_NOT_WRITTEN);
            }
        },
    };

    match &args.out {
        Some(path) => {
            if let Err(err) = std::fs::write(path, &rendered) {
                eprintln!(
                    "veistra reconcile: failed to write {}: {err}",
                    path.display()
                );
                return ExitCode::from(EXIT_RESULT_NOT_WRITTEN);
            }
        }
        None => println!("{rendered}"),
    }

    ExitCode::from(exit_code(&run))
}
