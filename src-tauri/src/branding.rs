//! The product's name, read from `branding.toml`.
//!
//! Every OS-level place the name appears comes from here: the window title
//! `project::retitle` writes, the title a detached window is built with, and the
//! caption on the folder picker Home raises.
//!
//! **Embedded at compile time, unlike `veistra.toml`.** The manifest is located on
//! disk at run time because it points at checkouts that differ per machine.
//! Branding is the opposite: Tauri bakes `productName` and the window title into
//! the bundle when it is built, so a name read at run time could disagree with
//! the installer that delivered it. `docs/branding.md` §3 has the full argument,
//! and the list of surfaces this one is a part of.

use serde::Deserialize;
use std::sync::OnceLock;

/// `CARGO_MANIFEST_DIR` is `src-tauri/`, so the repository root is its parent.
/// Resolved when this crate is compiled, which is what makes it independent of
/// whatever working directory the process is started in.
const RAW: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../branding.toml"));

/// A deliberately partial read: `[assets]` and the rest of `[product]` are for
/// the frontend generator, and nothing in Rust draws them. Modelling the whole
/// file here would be a second schema to keep in step with the one in
/// `scripts/check-branding.mjs`, which is the reader that does see all of it.
#[derive(Deserialize)]
struct BrandingFile {
    product: Product,
}

#[derive(Deserialize)]
struct Product {
    name: String,
}

static PRODUCT_NAME: OnceLock<String> = OnceLock::new();

/// The product's name, as it belongs in a window title or a dialog caption.
///
/// The panic is `sync.rs`'s category: an invariant, not a fallible call. `RAW`
/// is compiled into this binary rather than being anything the filesystem, a
/// process or a user can influence, so a parse failure is a build that should
/// never have shipped — and the first test below is what stops it shipping.
pub fn product_name() -> &'static str {
    PRODUCT_NAME.get_or_init(|| match toml::from_str::<BrandingFile>(RAW) {
        Ok(file) => file.product.name,
        Err(source) => panic!("branding.toml does not parse: {source}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_file_parses_and_names_something() {
        assert!(!product_name().is_empty());
    }

    /// The bug this module was written for: the title bar and the About item
    /// both used to call the shell an engine. Veistra is an ADE — it hosts the
    /// tools you work in, and is not a runtime that anything ships on top of.
    /// The guard stays because the wrong name is easy to reintroduce and reads
    /// as authoritative wherever it appears.
    #[test]
    fn the_name_is_not_an_engine() {
        assert!(!product_name().to_lowercase().contains("engine"));
    }
}
