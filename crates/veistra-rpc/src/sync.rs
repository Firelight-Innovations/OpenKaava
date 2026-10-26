//! Lock access for the four mutexes a `ToolProcess` owns outright.
//!
//! Each guards state this crate is the sole author of: the pending-call map
//! keyed by request id, the child process handle, the stdin pipe requests go
//! out on, and the notification receiver. None of it is shared with the tool
//! on the far end — that side only ever sees bytes.
//!
//! A poisoned lock therefore means one of *this* crate's own threads panicked
//! partway through a write, leaving the map missing an entry it was moving or
//! the pipe holding half a line. STANDARDS.md §5 allows a panic for exactly
//! that — "a mutex you own" is its own example of a genuine invariant — as
//! long as a comment names it. This module is that comment, written once
//! instead of at eight call sites.

use std::sync::{Mutex, MutexGuard};

/// What a poisoned lock means here, in the one place it is said.
///
/// `#[track_caller]` on the accessor below puts the *caller's* file and line
/// in the panic, so this message does not have to name the lock the way the
/// `unwrap` calls it replaced could not.
const POISONED: &str = "lock poisoned: a thread panicked mid-write, so this state is half-applied";

/// `Mutex` access that treats poisoning as a bug rather than an error.
pub(crate) trait MutexExt<T: ?Sized> {
    /// Exclusive access. Blocks until the current holder is done.
    fn lock_or_panic(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> MutexExt<T> for Mutex<T> {
    #[track_caller]
    fn lock_or_panic(&self) -> MutexGuard<'_, T> {
        match self.lock() {
            Ok(guard) => guard,
            Err(_) => panic!("{POISONED}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_healthy_mutex_locks() {
        let lock = Mutex::new(String::new());
        lock.lock_or_panic().push_str("ok");
        assert_eq!(*lock.lock_or_panic(), "ok");
    }

    #[test]
    #[should_panic(expected = "lock poisoned")]
    fn a_poisoned_mutex_panics_on_lock() {
        let lock = Mutex::new(0);
        let _ = std::panic::catch_unwind(|| {
            let _guard = lock.lock_or_panic();
            panic!("poison it");
        });
        drop(lock.lock_or_panic());
    }
}
