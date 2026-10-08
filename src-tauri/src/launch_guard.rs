//! What a launch does when the OpenKaava already running has stopped answering.
//!
//! `tauri-plugin-single-instance` hands a second launch's arguments to the
//! first process with `SendMessageW`, which has no timeout. A first process
//! whose main thread is stuck never answers, so the second launch waits for
//! ever, with no window and no message. The person sees an application that
//! will not start.
//!
//! [`clear_hung_primary`] runs before the plugin does. It asks the first
//! process a question that costs nothing to answer, and gives it
//! [`PATIENCE`] to do so. A process that answers is left to the plugin. One
//! that does not is named in a dialog that offers to end it.
//!
//! Rejected: forking the plugin to use `SendMessageTimeoutW`. The timeout would
//! then cover the handoff itself, but the fork would have to be carried across
//! every plugin release for the sake of one call.

/// How long the running process has to answer before it is called hung.
///
/// Windows itself calls a window hung after five seconds without a message
/// being taken, so this agrees with the "Not Responding" a person sees.
#[cfg(windows)]
const PATIENCE_MS: u32 = 5_000;

/// How long to wait for a process that was ended, and for the launches that
/// were stuck behind it, to be gone.
#[cfg(windows)]
const SETTLE_MS: u32 = 5_000;

/// The three names the plugin derives from the bundle identifier.
///
/// They are the plugin's, not ours: `platform_impl/windows.rs` builds them the
/// same way. The test below pins the spelling, so a plugin upgrade that
/// changes it fails here instead of quietly disarming the guard.
#[derive(Debug, PartialEq, Eq)]
struct Names {
    class: String,
    window: String,
    mutex: String,
}

fn names(identifier: &str) -> Names {
    Names {
        class: format!("{identifier}-sic"),
        window: format!("{identifier}-siw"),
        mutex: format!("{identifier}-sim"),
    }
}

/// A string as the NUL-terminated UTF-16 the `W` half of Win32 takes.
#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// If an OpenKaava is running and not answering, offer to end it.
///
/// Returns when this launch may carry on: nothing was running, what was
/// running is healthy, or the hung process has been ended. Exits this process
/// when the person declines, because carrying on would only wait for ever.
#[cfg(windows)]
pub fn clear_hung_primary(identifier: &str) {
    let names = names(identifier);
    let Some(hwnd) = win::find(&names) else {
        return;
    };
    if win::responds(hwnd, PATIENCE_MS) {
        return;
    }

    let product = crate::branding::product_name();
    let text = format!(
        "{product} is already running but is not responding.\n\n\
         End it and start again? Anything unsaved in it will be lost."
    );
    if !win::confirm(product, &text) {
        std::process::exit(0);
    }

    if let Err(e) = win::end(hwnd, SETTLE_MS) {
        crate::kaava_log!("could not end the unresponsive {product}: {e}");
    }
    // The launches that were stuck behind it each hold the mutex too, and they
    // let go only as they exit. Starting before they have would leave the
    // plugin seeing a mutex with no window behind it, and this process would
    // run without claiming to be the first.
    win::wait_until_unclaimed(&names, SETTLE_MS);
}

/// Nothing to do: the other platforms hand off over a socket, which fails
/// rather than waits when nobody is listening.
#[cfg(not(windows))]
pub fn clear_hung_primary(_identifier: &str) {}

/// The Win32 calls, kept together so every `unsafe` block is in one place.
#[cfg(windows)]
mod win {
    use super::{wide, Names};
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenMutexW, OpenProcess, TerminateProcess, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetWindowThreadProcessId, MessageBoxW, SendMessageTimeoutW, IDYES,
        MB_ICONWARNING, MB_SETFOREGROUND, MB_YESNO, SMTO_ABORTIFHUNG, WM_NULL,
    };

    /// `HWND` in `windows-sys` is a raw pointer. Named so signatures read.
    pub type Hwnd = *mut c_void;

    const SYNCHRONIZE: u32 = 0x0010_0000;
    const PROCESS_TERMINATE: u32 = 0x0001;

    /// The window the first process listens on, if there is one.
    pub fn find(names: &Names) -> Option<Hwnd> {
        let (class, window) = (wide(&names.class), wide(&names.window));
        // SAFETY: both pointers are NUL-terminated buffers that outlive the call.
        let hwnd = unsafe { FindWindowW(class.as_ptr(), window.as_ptr()) };
        (!hwnd.is_null()).then_some(hwnd)
    }

    /// Whether the thread that owns `hwnd` takes a message within `timeout_ms`.
    ///
    /// `WM_NULL` is the message Windows defines as doing nothing, so a window
    /// that answers it has been asked for no work. `SMTO_ABORTIFHUNG` returns
    /// at once when Windows has already decided the thread is hung.
    pub fn responds(hwnd: Hwnd, timeout_ms: u32) -> bool {
        let mut result = 0usize;
        // SAFETY: `result` is a live `usize` for the call to write through, and
        // a stale `hwnd` makes the call fail, which reads as "did not answer".
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_NULL,
                0,
                0,
                SMTO_ABORTIFHUNG,
                timeout_ms,
                &mut result,
            )
        };
        sent != 0
    }

    /// Ask a yes-or-no question in a system dialog. No window of ours exists yet.
    pub fn confirm(caption: &str, text: &str) -> bool {
        let (caption, text) = (wide(caption), wide(text));
        let style = MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND;
        // SAFETY: both pointers are NUL-terminated buffers that outlive the call.
        let answer =
            unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), style) };
        answer == IDYES
    }

    /// End the process that owns `hwnd` and wait for it to be gone.
    pub fn end(hwnd: Hwnd, wait_ms: u32) -> Result<(), String> {
        let mut pid = 0u32;
        // SAFETY: `pid` is a live `u32` for the call to write through.
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == 0 {
            // The window went away between the probe and here: it has exited.
            return Ok(());
        }

        // SAFETY: plain value arguments; the handle is checked and closed below.
        let process = unsafe { OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            return Err(format!("process {pid} could not be opened"));
        }
        // SAFETY: `process` is a handle this function opened and has not closed.
        let ended = unsafe {
            let ended = TerminateProcess(process, 1) != 0;
            WaitForSingleObject(process, wait_ms);
            CloseHandle(process);
            ended
        };
        if ended {
            Ok(())
        } else {
            Err(format!("process {pid} refused to end"))
        }
    }

    /// Wait until nobody holds the single-instance mutex, or `wait_ms` passes.
    pub fn wait_until_unclaimed(names: &Names, wait_ms: u32) {
        let mutex = wide(&names.mutex);
        let step = std::time::Duration::from_millis(50);
        for _ in 0..(wait_ms / 50) {
            // SAFETY: the name is a NUL-terminated buffer that outlives the call.
            let handle = unsafe { OpenMutexW(SYNCHRONIZE, 0, mutex.as_ptr()) };
            if handle.is_null() {
                return;
            }
            // SAFETY: `handle` was opened on the line above and is closed once.
            unsafe { CloseHandle(handle) };
            std::thread::sleep(step);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_names_are_the_ones_the_plugin_derives() {
        assert_eq!(
            names("com.example.app"),
            Names {
                class: "com.example.app-sic".to_string(),
                window: "com.example.app-siw".to_string(),
                mutex: "com.example.app-sim".to_string(),
            }
        );
    }

    /// The whole feature rests on telling a thread that takes messages from
    /// one that does not, so both are built for real: a window whose owner
    /// pumps, and one whose owner sleeps.
    #[cfg(windows)]
    mod probe {
        use super::super::{names, wide, win};
        use std::sync::mpsc;
        use std::time::Duration;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
            RegisterClassExW, MSG, PM_REMOVE, WNDCLASSEXW,
        };

        /// Create the window a first process would, on a thread of its own,
        /// then either pump messages or ignore them until told to stop.
        fn primary(identifier: &'static str, pumps: bool) -> mpsc::Sender<()> {
            let (ready_tx, ready_rx) = mpsc::channel();
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            std::thread::spawn(move || {
                let names = names(identifier);
                let (class, window) = (wide(&names.class), wide(&names.window));
                // SAFETY: a zeroed `WNDCLASSEXW` is the documented starting
                // point, the strings outlive the calls, and the window is
                // destroyed on the thread that made it.
                unsafe {
                    let mut wc: WNDCLASSEXW = std::mem::zeroed();
                    wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
                    wc.lpfnWndProc = Some(DefWindowProcW);
                    wc.lpszClassName = class.as_ptr();
                    RegisterClassExW(&wc);
                    let hwnd = CreateWindowExW(
                        0,
                        class.as_ptr(),
                        window.as_ptr(),
                        0,
                        0,
                        0,
                        0,
                        0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null(),
                    );
                    let _ = ready_tx.send(!hwnd.is_null());
                    while stop_rx.recv_timeout(Duration::from_millis(5)).is_err() {
                        let mut msg: MSG = std::mem::zeroed();
                        while pumps
                            && PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0
                        {
                            DispatchMessageW(&msg);
                        }
                    }
                    DestroyWindow(hwnd);
                }
            });
            assert_eq!(ready_rx.recv(), Ok(true), "the window was created");
            stop_tx
        }

        #[test]
        fn a_primary_that_pumps_messages_answers() {
            let id = "test.openkaava.launch-guard.healthy";
            let stop = primary(id, true);
            let hwnd = win::find(&names(id)).expect("the window is found by name");

            assert!(win::responds(hwnd, 2_000));
            let _ = stop.send(());
        }

        #[test]
        fn a_primary_that_has_stopped_pumping_does_not_answer() {
            let id = "test.openkaava.launch-guard.hung";
            let stop = primary(id, false);
            let hwnd = win::find(&names(id)).expect("the window is found by name");

            assert!(!win::responds(hwnd, 300));
            let _ = stop.send(());
        }

        #[test]
        fn no_primary_means_no_window_to_ask() {
            assert!(win::find(&names("test.openkaava.launch-guard.absent")).is_none());
        }
    }
}
