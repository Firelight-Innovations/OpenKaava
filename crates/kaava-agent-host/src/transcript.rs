//! Every item a session has drawn, each in its latest state.
//!
//! This is what `attach` answers, so an agent tab that mounts late — or
//! remounts after its cluster was hidden — gets the whole conversation in one
//! reply instead of a replay of every chunk. The same [`Event`]s the tab
//! applies are applied here, in the same order, so the two cannot disagree.

use std::collections::VecDeque;

use crate::event::{Event, Item, ItemKind};

/// The most items kept. Past it the oldest go; a tab that attaches then sees
/// the conversation from part-way through.
pub const MAX_ITEMS: usize = 2000;

/// The items, oldest first.
#[derive(Debug, Default, Clone)]
pub struct Transcript {
    items: VecDeque<Item>,
}

impl Transcript {
    /// A transcript continuing from `items`.
    pub fn from_items(items: Vec<Item>) -> Self {
        Self {
            items: items.into(),
        }
    }

    /// Apply one event, as the tab would.
    pub fn apply(&mut self, event: &Event) {
        match event {
            Event::ItemStarted { item }
            | Event::ItemUpdated { item }
            | Event::ItemCompleted { item } => self.upsert(item),
            Event::ItemDelta { item_id, text } => {
                if let Some(
                    ItemKind::AssistantText { text: have } | ItemKind::Reasoning { text: have },
                ) = self.find_mut(item_id).map(|item| &mut item.kind)
                {
                    have.push_str(text);
                }
            }
            Event::Reset => self.items.clear(),
            Event::Status { .. } | Event::TurnStarted { .. } | Event::TurnCompleted { .. } => {}
        }
    }

    /// One item by id.
    pub fn get(&self, id: &str) -> Option<&Item> {
        self.items.iter().rev().find(|item| item.id == id)
    }

    /// Every item, oldest first.
    pub fn items(&self) -> Vec<Item> {
        self.items.iter().cloned().collect()
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut Item> {
        self.items.iter_mut().rev().find(|item| item.id == id)
    }

    fn upsert(&mut self, item: &Item) {
        if let Some(have) = self.find_mut(&item.id) {
            *have = item.clone();
            return;
        }
        self.items.push_back(item.clone());
        while self.items.len() > MAX_ITEMS {
            self.items.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(id: &str, text: &str) -> Item {
        Item {
            id: id.into(),
            turn_id: "t1".into(),
            kind: ItemKind::AssistantText { text: text.into() },
        }
    }

    #[test]
    fn deltas_append_and_completion_replaces() {
        let mut t = Transcript::default();
        t.apply(&Event::ItemStarted {
            item: text("i1", "He"),
        });
        t.apply(&Event::ItemDelta {
            item_id: "i1".into(),
            text: "llo".into(),
        });
        assert_eq!(t.get("i1"), Some(&text("i1", "Hello")));
        t.apply(&Event::ItemCompleted {
            item: text("i1", "Hello!"),
        });
        assert_eq!(t.items(), vec![text("i1", "Hello!")]);
    }

    #[test]
    fn a_completed_item_never_seen_is_added() {
        let mut t = Transcript::default();
        t.apply(&Event::ItemCompleted {
            item: text("i1", "x"),
        });
        assert_eq!(t.items().len(), 1);
    }

    #[test]
    fn the_oldest_items_go_past_the_cap_and_reset_clears() {
        let mut t = Transcript::default();
        for n in 0..=MAX_ITEMS {
            t.apply(&Event::ItemCompleted {
                item: text(&format!("i{n}"), ""),
            });
        }
        assert_eq!(t.items().len(), MAX_ITEMS);
        assert!(t.get("i0").is_none());
        t.apply(&Event::Reset);
        assert!(t.items().is_empty());
    }
}
