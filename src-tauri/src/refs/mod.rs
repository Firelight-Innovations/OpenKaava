//! `kaava://` references: one way for a person and an agent to point at the
//! same file, asset, canvas frame, comment or context item.
//!
//! `docs/design/KAAVA-CONTEXT-REFS.md` is the long form. In short:
//!
//! ```text
//! kaava://file/<path>[#L10-L20]        a file or asset, relative to the cluster's root
//! kaava://canvas/<id>[#frame=<id>]     a canvas, or one frame on it
//! kaava://canvas/<id>#comment=<id>     a comment on a canvas
//! kaava://comment/<id>                 a viewer comment and its screenshot
//! kaava://design-comment/<id>          a Design Mode comment and its screenshot
//! kaava://context/<id>                 an item in the context store
//! kaava://selection                    what is selected in the cluster's panes
//! ```
//!
//! A reference only ever resolves inside the cluster it is resolved for.

pub mod assets;
pub mod policy;
pub mod resolve;
pub mod uri;
