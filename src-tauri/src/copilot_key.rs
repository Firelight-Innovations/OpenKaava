//! The Windows Copilot key, claimed below the webview.
//!
//! The key has no virtual-key code of its own: Windows sends Left Win, Left
//! Shift and F23 in a row. While OpenKaava is focused the page hears that as a
//! plain `keydown` (`src/shell/copilotKey.ts`). This module is the other route,
//! for when it is not: a low-level keyboard hook (`WH_KEYBOARD_LL`) that sees
//! every key before any window and before the Windows shell, swallows F23, and
//! tells the right OpenKaava window instead.
//!
//! It is off by default and installed only while `keys.copilotGlobal` is on,
//! because a global hook is a thing to opt in to. A hook needs a thread that
//! pumps messages, so [`sync`] starts one when the setting turns on and asks it
//! to quit, by posting `WM_QUIT`, when it turns off.
//!
//! `RegisterHotKey` was considered and rejected: it cannot be relied on to win
//! the chord from the shell, which registers its own for the key, and it would
//! not see a bare F23 at all.

use tauri::AppHandle;

/// The virtual-key code Windows gives F23.
const VK_F23: u32 = 0x86;

/// Whether a key press is the Copilot key: F23 with neither Ctrl nor Alt.
///
/// Win and Shift are not tested, on purpose. Windows sends both, but a
/// remapper or a third-party keyboard may send either or neither, and none of
/// those is a chord anyone else has a use for.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_copilot_key(vk: u32, ctrl: bool, alt: bool) -> bool {
    vk == VK_F23 && !ctrl && !alt
}

/// Make the hook match the settings: running when the toggle is on, stopped
/// when it is off. Safe to call again with nothing changed.
pub fn sync(app: &AppHandle) {
    #[cfg(windows)]
    hook::sync(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
mod hook {
    use super::is_copilot_key;
    use crate::settings::{self, keys};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter, Manager};
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_MENU};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
    };

    /// Sent to the window that should act on the key; the payload is empty.
    /// The same string as `COPILOT_KEY_EVENT` in `src/bindings.ts`.
    const COPILOT_KEY_EVENT: &str = "copilot-key:pressed";

    /// The hook procedure is a bare `extern "system"` function with no way to
    /// carry state, so the handle it needs lives here.
    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// The hook thread's id, or 0 when there is none. It is what `WM_QUIT` is
    /// posted to, and doubles as "is it running".
    static THREAD: AtomicU32 = AtomicU32::new(0);

    pub fn sync(app: &AppHandle) {
        let _ = APP.set(app.clone());
        let wanted = settings::flag(app, keys::KEYS_COPILOT_GLOBAL);
        let running = THREAD.load(Ordering::SeqCst);

        if wanted && running == 0 {
            std::thread::spawn(run);
        } else if !wanted && running != 0 {
            // SAFETY: posting a message to a thread id is sound even if the
            // thread has since gone; the call just fails.
            unsafe { PostThreadMessageW(running, WM_QUIT, 0, 0) };
        }
    }

    /// Install the hook, pump messages until told to quit, then remove it.
    ///
    /// A low-level hook is called on the thread that installed it, and only if
    /// that thread is reading messages, so the loop is not optional.
    fn run() {
        // SAFETY: plain Win32 calls with valid arguments. `hook_proc` matches
        // the `HOOKPROC` signature, and the module handle is this process's.
        unsafe {
            let module = GetModuleHandleW(std::ptr::null());
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), module, 0);
            if hook.is_null() {
                crate::kaava_log!("could not install the Copilot key hook");
                return;
            }
            THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}

            UnhookWindowsHookEx(hook);
            THREAD.store(0, Ordering::SeqCst);
        }
    }

    fn held(vk: u16) -> bool {
        // SAFETY: reads the keyboard state; no pointers involved. The high bit
        // means the key is down right now.
        unsafe { GetAsyncKeyState(i32::from(vk)) < 0 }
    }

    /// Runs on every key press and release system-wide, so it does almost
    /// nothing: compare one number and return. Anything slower risks Windows
    /// dropping the hook.
    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // SAFETY: for `WH_KEYBOARD_LL` with `HC_ACTION`, `lparam` points at
            // a `KBDLLHOOKSTRUCT` that outlives this call.
            let info = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
            if is_copilot_key(info.vkCode, held(VK_CONTROL), held(VK_MENU)) && claimed() {
                if matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN) {
                    // Off this thread: focusing a window from inside the hook
                    // would stall every keystroke on the machine behind it.
                    std::thread::spawn(notify);
                }
                // Non-zero swallows the key, press and release alike, so
                // neither the focused app nor Windows ever sees it.
                return 1;
            }
        }
        // SAFETY: passes the same arguments on, as the hook contract asks.
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }

    /// Whether OpenKaava wants the key: the action is not "none".
    fn claimed() -> bool {
        APP.get()
            .is_some_and(|app| settings::text(app, keys::KEYS_COPILOT_ACTION) != "none")
    }

    /// Bring the window that should act forward and tell it the key was hit.
    ///
    /// The focused OpenKaava window if there is one, otherwise the first by
    /// label, so the answer is stable. Raised first, so the palette does not
    /// open in a window behind another application.
    fn notify() {
        let Some(app) = APP.get() else { return };
        let mut windows: Vec<_> = app.webview_windows().into_values().collect();
        windows.sort_by(|a, b| a.label().cmp(b.label()));
        let target = windows
            .iter()
            .find(|w| w.is_focused().unwrap_or(false))
            .or_else(|| windows.first());
        let Some(window) = target else { return };

        if !window.is_focused().unwrap_or(false) {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        if let Err(e) = app.emit_to(window.label(), COPILOT_KEY_EVENT, ()) {
            crate::kaava_log!("could not deliver the Copilot key: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// F23 is the key, and only F23.
    #[test]
    fn f23_is_the_copilot_key() {
        assert!(is_copilot_key(VK_F23, false, false));
        assert!(!is_copilot_key(0x85, false, false), "F22");
        assert!(!is_copilot_key(0x87, false, false), "F24");
    }

    /// Ctrl or Alt makes it somebody's own chord.
    #[test]
    fn ctrl_or_alt_disqualifies_it() {
        assert!(!is_copilot_key(VK_F23, true, false));
        assert!(!is_copilot_key(VK_F23, false, true));
    }
}
