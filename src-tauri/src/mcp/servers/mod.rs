//! The MCP servers this build hosts.
//!
//! One module each, owning its tool descriptors, schemas and handler, and
//! declaring a single `pub static SERVER` for [`seed`] to register.
//!
//! **If the harness can already do it, it does not get a server.** No file
//! reading, writing or listing, no search, no git. Every agent worth pointing at
//! OpenKaava arrives with those, and a second worse copy costs a permission surface
//! and a pile of tool descriptions competing for the model's attention.
//!
//! What earns a server is something that exists only inside OpenKaava and has no
//! filesystem equivalent — Schematify's design model is the first real case, because
//! an agent cannot read a spec's *boundaries* by opening a file. [`debug`] is
//! the second, [`design`] the third and [`ui`] the fourth; each module's doc says
//! what earns its place, and what decides its gate where it writes.
//!
//! [`agent`] is the fifth and the exception, earning its place on the client's
//! axis rather than a capability's: nine of its twelve tools are [`ui`]'s and
//! [`debug`]'s, composed so one job needs one connection instead of four. It
//! indexes their arrays and delegates, so nothing here is a second copy.

pub mod agent;
pub mod debug;
#[cfg(feature = "design-mode")]
pub mod design;
pub mod echo;
pub mod ui;

use super::Registry;

/// Register every server this build hosts, in the order settings lists them.
///
/// `echo` and `debug` are registered in every build, release included, but are
/// `dev_only`: a `cfg` would put them out of reach of the build somebody most
/// needs to diagnose, so the gate is developer mode, checked at the point of use.
///
/// `design` ships for the ordinary user rather than for us — the comments it
/// serves are theirs — which is why it is the one write surface with no gate.
/// `ui` ships too and can click; what makes that safe is not a `cfg` but
/// `dev_only`, a gate the tests below can hold to account.
///
/// `agent` is last because it is the one that composes the others, and it
/// carries `ui`'s gate for `ui`'s reason: it can click too.
pub fn seed(registry: &Registry) {
    registry.register(&echo::SERVER);
    registry.register(&debug::SERVER);
    #[cfg(feature = "design-mode")]
    registry.register(&design::SERVER);
    registry.register(&ui::SERVER);
    registry.register(&agent::SERVER);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeding_registers_every_server_this_build_hosts() {
        let registry = Registry::default();
        seed(&registry);

        let ids: Vec<String> = registry.list(true).into_iter().map(|s| s.id).collect();
        #[cfg(feature = "design-mode")]
        assert_eq!(ids, vec!["echo", "debug", "design", "ui", "agent"]);
        #[cfg(not(feature = "design-mode"))]
        assert_eq!(ids, vec!["echo", "debug", "ui", "agent"]);
    }

    /// Every ordinary server is usable the moment OpenKaava starts. The one that
    /// can click is not, and no amount of the rest being convenient is a reason
    /// to make it so.
    #[test]
    fn an_ordinary_server_starts_on_and_the_developer_only_one_starts_off() {
        let registry = Registry::default();
        seed(&registry);

        for server in registry.list(true) {
            assert_eq!(
                server.enabled, !server.dev_only,
                "{} starts in the wrong state",
                server.id
            );
        }
    }

    /// With developer mode off, the ordinary user sees only what is for them.
    /// `design` is meant to be here: it is the one write surface an ordinary
    /// user is supposed to have, for the reasons in its module doc. `echo`,
    /// `debug`, `ui` and `agent` are all developer-only.
    #[test]
    fn a_default_install_sees_only_the_servers_that_are_not_developer_only() {
        let registry = Registry::default();
        seed(&registry);

        #[cfg(feature = "design-mode")]
        let expected: Vec<&str> = vec!["design"];
        #[cfg(not(feature = "design-mode"))]
        let expected: Vec<&str> = vec![];

        let ids: Vec<String> = registry.list(false).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, expected);
        assert_eq!(registry.enabled_ids(false), expected);
    }

    /// With developer mode on, echo and debug are listed and badged, but start
    /// off like `ui` and `agent`: revealing is not enabling. Once switched on
    /// they are reachable, and switching developer mode off takes them away.
    #[test]
    fn echo_and_debug_appear_with_developer_mode_and_need_their_own_switch() {
        let registry = Registry::default();
        seed(&registry);

        for id in ["echo", "debug"] {
            let row = registry
                .list(true)
                .into_iter()
                .find(|s| s.id == id)
                .unwrap_or_else(|| panic!("{id} is listed with developer mode on"));
            assert!(row.dev_only, "{id} carries the developer badge");
            assert!(!row.enabled, "{id} starts off");
            assert!(!registry.enabled_ids(true).contains(&id.to_string()));

            assert!(registry.set_enabled(id, true));
            assert!(registry.enabled_ids(true).contains(&id.to_string()));
            assert!(!registry.enabled_ids(false).contains(&id.to_string()));
            assert!(registry.tools(id, false).is_empty());
            assert!(!registry.tools(id, true).is_empty());
        }
    }

    /// The id reaches two places a typo would not be caught in: a URL path and a
    /// key in the user's own `.mcp.json`.
    #[test]
    fn each_server_gets_a_namespaced_key_and_route() {
        let registry = Registry::default();
        seed(&registry);

        for server in registry.list(true) {
            assert_eq!(server.config_key, format!("kaava-{}", server.id));
            assert_eq!(server.path, format!("/mcp/{}", server.id));
        }
    }

    /// Seeding twice is what a re-seed after a settings change would do, and it
    /// must not double the list.
    #[test]
    fn seeding_is_idempotent() {
        let registry = Registry::default();
        seed(&registry);
        let once = registry.list(true).len();
        seed(&registry);

        assert_eq!(registry.list(true).len(), once);
    }

    /// Held against the servers this build actually registers, not against a
    /// fixture. `registry.rs` has the same check over its own test doubles,
    /// which proves the rule and not the shipped set — and the shipped set is
    /// the one where an id becomes a URL path (`/mcp/<id>`) and a `.mcp.json`
    /// key (`kaava-<id>`). The same rule `kaava-tool-manifest` holds tool ids
    /// to, for the same reason.
    #[test]
    fn every_registered_server_id_is_url_safe() {
        let registry = Registry::default();
        seed(&registry);

        for server in registry.list(true) {
            let mut chars = server.id.chars();
            assert!(
                matches!(chars.next(), Some(c) if c.is_ascii_lowercase()),
                "server id {:?} must start with a lowercase letter",
                server.id
            );
            assert!(
                chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "server id {:?} must match ^[a-z][a-z0-9-]*$",
                server.id
            );
        }
    }
}
