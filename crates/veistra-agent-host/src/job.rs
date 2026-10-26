//! The agent's process and everything it starts, ended together.
//!
//! On Windows an agent is often an npm shim, `cmd.exe` running `node`, and
//! either may start more. Each agent starts suspended, goes into a Job Object
//! of its own, and only then runs, so all it ever starts is in the job and
//! stopping it is one `TerminateJobObject`. The job also ends everything in it
//! when its last handle closes, so an agent cannot outlive this process.
//!
//! `taskkill /T` did this before. It walked every process on the machine on
//! each stop, which took most of a second idle and several under load, and it
//! missed a process whose parent had already exited. It is still the fallback
//! for an agent no job could be made for. Elsewhere the child alone is killed.

#[cfg(windows)]
pub(crate) use windows::{kill, spawn, Job};

#[cfg(not(windows))]
pub(crate) use other::{kill, spawn, Job};

#[cfg(windows)]
mod windows {
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    /// The job an agent runs in. Closing it ends everything still in it.
    pub(crate) struct Job(HANDLE);

    // SAFETY: a kernel handle names the same object from any thread, and
    // nothing here depends on the thread that opened it.
    unsafe impl Send for Job {}
    // SAFETY: as above; the job's calls are safe to make concurrently.
    unsafe impl Sync for Job {}

    impl Job {
        /// A job that ends everything in it when its last handle closes.
        fn new() -> Option<Self> {
            // SAFETY: no attributes and no name; the handle is checked below.
            let handle = unsafe { CreateJobObjectW(null(), null()) };
            if handle.is_null() {
                return None;
            }
            let job = Self(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `limits` is the struct this class takes, alive for the call.
            let set = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast(),
                    size_of_u32::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>(),
                )
            };
            (set != 0).then_some(job)
        }

        fn assign(&self, child: &Child) -> bool {
            // SAFETY: both handles are open; the child's lives as long as `child`.
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is ours and closed once, here.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Start `command` with no console window, inside a job of its own when
    /// one can be made. It runs only once it is in the job.
    pub(crate) fn spawn(command: &mut Command) -> io::Result<(Child, Option<Job>)> {
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = command.spawn()?;
        let job = Job::new().filter(|job| job.assign(&child));
        if !resume(child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("the agent's process could not be resumed"));
        }
        Ok((child, job))
    }

    /// End the agent and all it started. With a job this returns at once.
    pub(crate) fn kill(child: &mut Child, job: Option<&Job>) {
        match job {
            // SAFETY: the job's handle is open until it is dropped.
            Some(job) => unsafe {
                TerminateJobObject(job.0, 1);
            },
            None => taskkill(child.id()),
        }
        let _ = child.kill();
    }

    fn taskkill(pid: u32) {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }

    /// Let a suspended process run. `std` keeps its main thread's handle to
    /// itself, so the thread is found by the process it belongs to.
    fn resume(pid: u32) -> bool {
        // SAFETY: a snapshot of every thread, checked here and closed below.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry = THREADENTRY32 {
            dwSize: size_of_u32::<THREADENTRY32>(),
            ..THREADENTRY32::default()
        };
        let mut resumed = false;
        // SAFETY: `entry` is sized as the walk requires and outlives each call.
        let mut more = unsafe { Thread32First(snapshot, &raw mut entry) } != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                resumed |= resume_thread(entry.th32ThreadID);
            }
            // SAFETY: as for `Thread32First`.
            more = unsafe { Thread32Next(snapshot, &raw mut entry) } != 0;
        }
        // SAFETY: the snapshot is ours and closed once.
        unsafe { CloseHandle(snapshot) };
        resumed
    }

    fn resume_thread(id: u32) -> bool {
        // SAFETY: the handle is checked before use and closed after.
        unsafe {
            let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, id);
            if thread.is_null() {
                return false;
            }
            let resumed = ResumeThread(thread) != u32::MAX;
            CloseHandle(thread);
            resumed
        }
    }

    /// A Win32 struct's size, as the `u32` its `cb` and `dwSize` fields take.
    fn size_of_u32<T>() -> u32 {
        u32::try_from(size_of::<T>()).unwrap_or(u32::MAX)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::{Duration, Instant};
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;

        fn in_job(child: &Child, job: &Job) -> bool {
            let mut result = 0;
            // SAFETY: both handles are open, and `result` outlives the call.
            let ok = unsafe { IsProcessInJob(child.as_raw_handle(), job.0, &raw mut result) };
            ok != 0 && result != 0
        }

        fn exit_code(child: &mut Child) -> Option<i32> {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if let Some(status) = child.try_wait().unwrap() {
                    return status.code();
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            None
        }

        #[test]
        fn a_spawned_process_runs_and_is_inside_its_job() {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit 3"]);
            let (mut child, job) = spawn(&mut command).unwrap();
            let job = job.expect("a job for the child");
            assert!(in_job(&child, &job));
            assert_eq!(exit_code(&mut child), Some(3), "it was resumed and ran");
        }

        #[test]
        fn killing_with_the_job_ends_the_process() {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
            let (mut child, job) = spawn(&mut command).unwrap();
            assert!(child.try_wait().unwrap().is_none());
            kill(&mut child, job.as_ref());
            assert!(exit_code(&mut child).is_some(), "the job took it");
        }
    }
}

#[cfg(not(windows))]
mod other {
    use std::io;
    use std::process::{Child, Command};

    /// No job outside Windows; the child is killed alone.
    pub(crate) enum Job {}

    pub(crate) fn spawn(command: &mut Command) -> io::Result<(Child, Option<Job>)> {
        Ok((command.spawn()?, None))
    }

    pub(crate) fn kill(child: &mut Child, _job: Option<&Job>) {
        let _ = child.kill();
    }
}
