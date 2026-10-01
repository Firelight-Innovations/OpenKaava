//! Which MCP sessions have asked to hear about which resource.
//!
//! A subscription is a `(server, uri, session)` triple and a channel. The channel
//! is the point: the transport's peer lives in an async task, and
//! [`Subscriptions::notify`] is called from a sync Tauri command, so the two meet
//! at an unbounded queue. Whoever subscribed owns the receiving end and forwards
//! each uri to the wire; this type owns the sending end and never touches the
//! network, which is also what lets the tests run without a transport.
//!
//! **Dead sessions are found lazily.** A client that vanishes never sends
//! `resources/unsubscribe`; its forwarding task ends on the first failed send and
//! drops the receiver, and the next [`Subscriptions::notify`] finds the sender
//! closed and removes the entry. No timer, no session-close hook to wire up.

use std::sync::Mutex;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

struct Entry {
    server: String,
    uri: String,
    session: String,
    sender: UnboundedSender<String>,
}

#[derive(Default)]
pub struct Subscriptions {
    entries: Mutex<Vec<Entry>>,
}

impl Subscriptions {
    /// Subscribe a session to a uri and return the queue its updates arrive on.
    ///
    /// Subscribing twice with the same triple replaces the first: the old
    /// receiver sees its channel close, so a client that re-subscribes after a
    /// reconnect is not told everything twice.
    pub fn subscribe(&self, server: &str, uri: &str, session: &str) -> UnboundedReceiver<String> {
        let (sender, receiver) = unbounded_channel();
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|e| !(e.server == server && e.uri == uri && e.session == session));
            entries.push(Entry {
                server: server.to_string(),
                uri: uri.to_string(),
                session: session.to_string(),
                sender,
            });
        }
        receiver
    }

    /// Returns whether there was a subscription to remove.
    pub fn unsubscribe(&self, server: &str, uri: &str, session: &str) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let before = entries.len();
        entries.retain(|e| !(e.server == server && e.uri == uri && e.session == session));
        entries.len() != before
    }

    /// Queue `uri` for every session subscribed to it, and return how many were
    /// reached. Entries whose receiver is gone are dropped on the way past.
    pub fn notify(&self, server: &str, uri: &str) -> usize {
        let Ok(mut entries) = self.entries.lock() else {
            return 0;
        };
        let mut delivered = 0;
        entries.retain(|e| {
            if e.server != server || e.uri != uri {
                return true;
            }
            let alive = e.sender.send(e.uri.clone()).is_ok();
            if alive {
                delivered += 1;
            }
            alive
        });
        delivered
    }

    /// How many live subscriptions a uri has.
    #[cfg(test)]
    pub fn count(&self, server: &str, uri: &str) -> usize {
        self.entries
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|e| e.server == server && e.uri == uri && !e.sender.is_closed())
                    .count()
            })
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URI: &str = "kaava://workspace/focus";

    #[test]
    fn a_subscriber_hears_about_a_change() {
        let subs = Subscriptions::default();
        let mut rx = subs.subscribe("workspace", URI, "s1");

        assert_eq!(subs.notify("workspace", URI), 1);
        assert_eq!(rx.try_recv().as_deref(), Ok(URI));
    }

    #[test]
    fn every_subscribed_session_is_told() {
        let subs = Subscriptions::default();
        let mut a = subs.subscribe("workspace", URI, "s1");
        let mut b = subs.subscribe("workspace", URI, "s2");

        assert_eq!(subs.notify("workspace", URI), 2);
        assert!(a.try_recv().is_ok());
        assert!(b.try_recv().is_ok());
    }

    #[test]
    fn an_unsubscribed_session_hears_nothing() {
        let subs = Subscriptions::default();
        let mut rx = subs.subscribe("workspace", URI, "s1");
        assert!(subs.unsubscribe("workspace", URI, "s1"));
        assert!(!subs.unsubscribe("workspace", URI, "s1"), "already gone");

        assert_eq!(subs.notify("workspace", URI), 0);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn another_uri_or_server_is_not_notified() {
        let subs = Subscriptions::default();
        let mut rx = subs.subscribe("workspace", URI, "s1");

        assert_eq!(subs.notify("workspace", "kaava://workspace/other"), 0);
        assert_eq!(subs.notify("canvas", URI), 0);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn subscribing_twice_does_not_double_deliver() {
        let subs = Subscriptions::default();
        let mut first = subs.subscribe("workspace", URI, "s1");
        let mut second = subs.subscribe("workspace", URI, "s1");

        assert_eq!(subs.notify("workspace", URI), 1);
        assert!(second.try_recv().is_ok());
        assert!(
            matches!(
                first.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
            ),
            "the replaced queue is closed, which ends its forwarder"
        );
    }

    #[test]
    fn a_vanished_session_is_dropped_on_the_next_notify() {
        let subs = Subscriptions::default();
        let rx = subs.subscribe("workspace", URI, "gone");
        let mut live = subs.subscribe("workspace", URI, "live");
        drop(rx);

        assert_eq!(subs.count("workspace", URI), 1);
        assert_eq!(subs.notify("workspace", URI), 1);
        assert!(live.try_recv().is_ok());
        assert_eq!(subs.notify("workspace", URI), 1);
    }
}
