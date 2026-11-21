//! Process identity and lifetime on Windows: what peer credentials, process
//! groups, `kill(2)`, `proc_pidpath` and `/proc` are on Unix.
use crate::paths::Canonical;
use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::time::Duration;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

pub(crate) fn pipe_server_pid(pipe: HANDLE) -> io::Result<u32> {
    let mut pid = 0;
    // SAFETY: `pipe` is a live client pipe handle for the call.
    if unsafe { GetNamedPipeServerProcessId(pipe, &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}

pub(crate) fn pipe_client_pid(pipe: HANDLE) -> io::Result<u32> {
    let mut pid = 0;
    // SAFETY: `pipe` is a live, connected server pipe handle for the call.
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}

/// An open process handle, closed on drop.
pub(crate) struct Process(OwnedHandle);

impl Process {
    pub(crate) fn open(pid: u32, access: u32) -> io::Result<Self> {
        // SAFETY: OpenProcess returns an owned handle or NULL.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh handle nobody else owns.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
    }

    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle() as HANDLE
    }

    pub(crate) fn image(&self) -> io::Result<PathBuf> {
        let mut buffer = vec![0u16; 32 * 1024];
        let mut size = buffer.len() as u32;
        // SAFETY: `buffer` holds `size` u16s.
        if unsafe { QueryFullProcessImageNameW(self.raw(), PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size) } == 0 {
            return Err(io::Error::last_os_error());
        }
        buffer.truncate(size as usize);
        Ok(PathBuf::from(OsString::from_wide(&buffer)))
    }

    pub(crate) fn running(&self) -> io::Result<bool> {
        let mut code = 0u32;
        // SAFETY: the handle has query access.
        if unsafe { GetExitCodeProcess(self.raw(), &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if code != STILL_ACTIVE as u32 {
            return Ok(false);
        }
        // A process can exit with 259 itself; only a wait is conclusive.
        Ok(self.wait(Duration::ZERO)?.is_none())
    }

    /// `Some(())` once the process has exited, `None` at the deadline.
    pub(crate) fn wait(&self, timeout: Duration) -> io::Result<Option<()>> {
        let millis = timeout.as_millis().min(u32::MAX as u128 - 1) as u32;
        // SAFETY: the handle carries SYNCHRONIZE whenever this is called.
        match unsafe { WaitForSingleObject(self.raw(), millis) } {
            WAIT_OBJECT_0 => Ok(Some(())),
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub(crate) fn terminate(&self, code: u32) -> io::Result<()> {
        // SAFETY: the handle carries PROCESS_TERMINATE whenever this is called.
        if unsafe { TerminateProcess(self.raw(), code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// The full path of the executable process `pid` runs.
pub(crate) fn image_path(pid: u32) -> io::Result<PathBuf> {
    Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?.image()
}

/// Whether process `pid` still runs. A pid nobody has is not running.
pub(crate) fn is_running(pid: u32) -> bool {
    Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)
        .and_then(|process| process.running())
        .unwrap_or(false)
}

fn same_file(left: &Path, right: &Path) -> bool {
    match (left.canonical(), right.canonical()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left.as_os_str().eq_ignore_ascii_case(right.as_os_str()),
    }
}

/// Terminate process `pid`, but only while it still runs `expected` as this
/// user: a pid that was reused since it was recorded is never killed.
/// Waits up to `wait` for it to go. `Ok(false)`: it was not running.
pub(crate) fn terminate_verified(pid: u32, expected: &Path, wait: Duration) -> io::Result<bool> {
    let process = match Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE) {
        Ok(process) => process,
        // ERROR_INVALID_PARAMETER: no such process.
        Err(error) if error.raw_os_error() == Some(87) => return Ok(false),
        Err(error) => return Err(error),
    };
    if !process.running()? {
        return Ok(false);
    }
    if !same_file(&process.image()?, expected) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("process {pid} no longer runs {}", expected.display())));
    }
    if super::security::process_user(pid)? != super::security::current_user()? {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("process {pid} belongs to another account")));
    }
    process.terminate(1)?;
    process.wait(wait)?;
    Ok(true)
}

/// When process `pid` started, in 100 ns units since 1601: with the pid, what
/// tells a process from a later one that was given the same pid.
pub(crate) fn started(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let process = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
    let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: four out-structs for a live handle with query access.
    if unsafe { GetProcessTimes(process.raw(), &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return None;
    }
    Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

/// What process `pid` uses now: its start time (as [`started`]), the
/// processor time it has used in 100 ns units, and its working set in bytes.
pub(crate) fn usage(pid: u32) -> Option<(u64, u64, u64)> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let process = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
    let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: four out-structs for a live handle with query access.
    if unsafe { GetProcessTimes(process.raw(), &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let ticks = |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    // SAFETY: an all-zero struct is a valid value of this plain C type.
    let mut memory = PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..unsafe { std::mem::zeroed() } };
    // SAFETY: `memory` is sized as `cb` says; the handle has limited query access, which this call takes.
    let resident = if unsafe { K32GetProcessMemoryInfo(process.raw(), &mut memory, memory.cb) } != 0 { memory.WorkingSetSize as u64 } else { 0 };
    Some((ticks(created), ticks(kernel).saturating_add(ticks(user)), resident))
}

/// The processes that have `file` open, as the Restart Manager (what
/// Windows asks before replacing a file in use) reports them. Empty when it
/// cannot say.
pub(crate) fn openers(file: &Path) -> Vec<u32> {
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::RestartManager::{RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY, RM_PROCESS_INFO};
    let mut session = 0u32;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    // SAFETY: `key` has room for the session key and its NUL.
    if unsafe { RmStartSession(&mut session, 0, key.as_mut_ptr()) } != ERROR_SUCCESS {
        return Vec::new();
    }
    let name = super::security::wide_path(file);
    let names = [name.as_ptr()];
    let mut found = Vec::new();
    // SAFETY: one NUL-terminated path, no applications or services.
    if unsafe { RmRegisterResources(session, 1, names.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null()) } == ERROR_SUCCESS {
        let mut infos: Vec<RM_PROCESS_INFO> = Vec::new();
        for _ in 0..3 {
            let (mut needed, mut count, mut reasons) = (0u32, infos.len() as u32, 0u32);
            // SAFETY: `infos` holds `count` entries, as the call is told.
            let status = unsafe { RmGetList(session, &mut needed, &mut count, infos.as_mut_ptr(), &mut reasons) };
            if status == ERROR_SUCCESS {
                found = infos[..count as usize].iter().map(|info| info.Process.dwProcessId).collect();
                break;
            }
            if status != ERROR_MORE_DATA {
                break;
            }
            // SAFETY: an all-zero RM_PROCESS_INFO is a valid empty entry.
            infos = (0..needed + 4).map(|_| unsafe { std::mem::zeroed() }).collect();
        }
    }
    // SAFETY: the session started above.
    unsafe { RmEndSession(session) };
    found
}

/// Give a process that has no console one with no window, once, at start.
///
/// A console program (git, a hook, `cmd`) started by a process without a
/// console gets a console window of its own, which flashes on screen each
/// time. Started by a process that has one, it shares that console instead.
/// The desktop app and the background runtime run without a console, so
/// each takes a windowless one here; a process already on a console (the
/// CLI in a terminal, a hook in an agent's pane) keeps it. What the
/// process's standard handles were (a log file, say) they stay.
pub(crate) fn windowless_console() {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{AllocConsole, GetConsoleProcessList, GetConsoleWindow, GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    let mut attached = [0u32; 1];
    // SAFETY: a one-entry buffer, as the call is told.
    if unsafe { GetConsoleProcessList(attached.as_mut_ptr(), 1) } != 0 {
        return;
    }
    // SAFETY: reads this process's standard handles.
    let saved = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].map(|which| (which, unsafe { GetStdHandle(which) }));
    /// `ALLOC_CONSOLE_OPTIONS` (Windows 11 24H2 and later).
    #[repr(C)]
    struct Options {
        mode: i32,
        use_show_window: i32,
        show_window: u16,
    }
    const ALLOC_CONSOLE_MODE_NO_WINDOW: i32 = 2;
    type AllocWithOptions = unsafe extern "system" fn(*const Options, *mut i32) -> i32;
    let kernel = super::security::wide(std::ffi::OsStr::new("kernel32.dll"));
    // SAFETY: kernel32 is loaded in every process; the name is NUL-terminated.
    let with_options = unsafe { GetProcAddress(GetModuleHandleW(kernel.as_ptr()), c"AllocConsoleWithOptions".as_ptr().cast()) };
    let made = match with_options {
        Some(found) => {
            // SAFETY: the export has this signature where it exists.
            let alloc: AllocWithOptions = unsafe { std::mem::transmute(found) };
            let options = Options { mode: ALLOC_CONSOLE_MODE_NO_WINDOW, use_show_window: 0, show_window: 0 };
            let mut result = 0i32;
            // SAFETY: both pointers are to live locals.
            let status = unsafe { alloc(&options, &mut result) };
            status >= 0
        }
        None => false,
    };
    if !made {
        // Older Windows: a console made, then its window hidden at once.
        // SAFETY: plain calls on this process's own new console.
        unsafe {
            if AllocConsole() == 0 {
                return;
            }
            let window = GetConsoleWindow();
            if !window.is_null() {
                ShowWindow(window, SW_HIDE);
            }
        }
    }
    for (which, handle) in saved {
        if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
            // SAFETY: puts back a handle this process already had.
            unsafe { SetStdHandle(which, handle) };
        }
    }
}

/// This machine's memory as `(total, available)` in bytes.
pub(crate) fn memory() -> Option<(u64, u64)> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: an all-zero struct is a valid value of this plain C type.
    let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..unsafe { std::mem::zeroed() } };
    // SAFETY: `status` is sized as `dwLength` says.
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some((status.ullTotalPhys, status.ullAvailPhys))
}

/// The console host (conhost.exe or OpenConsole.exe) process `pid` is
/// attached to: what a controlling terminal is on Unix. `Ok(None)` when it has
/// no console. Asked of the kernel with `ProcessConsoleHostProcess`, the
/// query Task Manager and Process Explorer use for the same column.
pub(crate) fn console_host(pid: u32) -> io::Result<Option<u32>> {
    use windows_sys::Wdk::System::Threading::NtQueryInformationProcess;
    const PROCESS_CONSOLE_HOST_PROCESS: i32 = 49;
    let process = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    let mut host: usize = 0;
    let mut written = 0u32;
    // SAFETY: the information class returns one ULONG_PTR into `host`.
    let status = unsafe {
        NtQueryInformationProcess(process.raw(), PROCESS_CONSOLE_HOST_PROCESS, std::ptr::addr_of_mut!(host).cast(), std::mem::size_of::<usize>() as u32, &mut written)
    };
    if status < 0 {
        return Err(io::Error::other(format!("the kernel would not say which console process {pid} has (status {status:#x})")));
    }
    // The low two bits are flags, not part of the pid.
    let host = (host & !3) as u32;
    Ok((host != 0).then_some(host))
}

/// A UNICODE_STRING as it lies in another process's memory (64-bit layout).
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct RemoteString {
    length: u16,
    maximum: u16,
    _pad: u32,
    buffer: u64,
}

/// The command line process `pid` was started with, as the kernel keeps it.
/// Read with the 64-bit layout, so only in a 64-bit build.
#[cfg(not(target_pointer_width = "64"))]
pub(crate) fn command_line(_pid: u32) -> Option<String> {
    None
}

/// The command line process `pid` was started with, as the kernel keeps it.
#[cfg(target_pointer_width = "64")]
pub(crate) fn command_line(pid: u32) -> Option<String> {
    use windows_sys::Wdk::System::Threading::NtQueryInformationProcess;
    const PROCESS_COMMAND_LINE_INFORMATION: i32 = 60;
    let process = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
    let mut needed = 0u32;
    // SAFETY: a size query.
    unsafe { NtQueryInformationProcess(process.raw(), PROCESS_COMMAND_LINE_INFORMATION, std::ptr::null_mut(), 0, &mut needed) };
    if !(16..=1 << 20).contains(&needed) {
        return None;
    }
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: the buffer holds `needed` bytes; the class writes a
    // UNICODE_STRING whose characters follow it in the same buffer.
    let status = unsafe { NtQueryInformationProcess(process.raw(), PROCESS_COMMAND_LINE_INFORMATION, buffer.as_mut_ptr().cast(), needed, &mut needed) };
    if status < 0 {
        return None;
    }
    // SAFETY: the start of the buffer is the UNICODE_STRING just written.
    let string = unsafe { *(buffer.as_ptr() as *const RemoteString) };
    let start = string.buffer as usize;
    let base = buffer.as_ptr() as usize;
    let len = string.length as usize / 2;
    if start < base || start + len * 2 > base + buffer.len() * 8 {
        return None;
    }
    // SAFETY: bounds-checked against the buffer just above.
    let units = unsafe { std::slice::from_raw_parts(start as *const u16, len) };
    Some(String::from_utf16_lossy(units))
}

/// A Windows command line split as `CommandLineToArgvW` splits it.
pub(crate) fn split_command_line(line: &str) -> Vec<String> {
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;
    if line.trim().is_empty() {
        return Vec::new();
    }
    let wide: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();
    let mut count = 0i32;
    // SAFETY: `wide` is NUL-terminated; the result is LocalAlloc'd and freed below.
    let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
    if argv.is_null() {
        return Vec::new();
    }
    let args = (0..count.max(0) as usize)
        .map(|index| {
            // SAFETY: `count` NUL-terminated strings, as the call reports.
            unsafe {
                let arg = *argv.add(index);
                let len = (0..).take_while(|&at| *arg.add(at) != 0).count();
                String::from_utf16_lossy(std::slice::from_raw_parts(arg, len))
            }
        })
        .collect();
    // SAFETY: allocated by CommandLineToArgvW, freed once.
    unsafe { windows_sys::Win32::Foundation::LocalFree(argv.cast()) };
    args
}

/// The current directory of process `pid`, read from its process parameters:
/// what `/proc/<pid>/cwd` is on Linux. Only for a 64-bit process of this
/// user's that lets its memory be read; `None` otherwise.
pub(crate) fn working_directory(pid: u32) -> Option<PathBuf> {
    use windows_sys::Wdk::System::Threading::NtQueryInformationProcess;
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Threading::{IsWow64Process, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
    // Offsets in the 64-bit PEB and RTL_USER_PROCESS_PARAMETERS, fixed
    // since Windows XP x64.
    const PARAMETERS_IN_PEB: u64 = 0x20;
    const DIRECTORY_IN_PARAMETERS: u64 = 0x38;
    if !cfg!(target_pointer_width = "64") {
        return None;
    }
    let process = Process::open(pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ).ok()?;
    let mut wow64 = 0;
    // SAFETY: a live handle with query access.
    if unsafe { IsWow64Process(process.raw(), &mut wow64) } == 0 || wow64 != 0 {
        return None;
    }
    let mut basic = PROCESS_BASIC_INFORMATION { ExitStatus: 0, PebBaseAddress: std::ptr::null_mut(), AffinityMask: 0, BasePriority: 0, UniqueProcessId: 0, InheritedFromUniqueProcessId: 0 };
    let mut written = 0u32;
    // SAFETY: ProcessBasicInformation (0) fills exactly this struct.
    if unsafe { NtQueryInformationProcess(process.raw(), 0, std::ptr::addr_of_mut!(basic).cast(), std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32, &mut written) } < 0 {
        return None;
    }
    let read = |address: u64, into: *mut core::ffi::c_void, size: usize| -> bool {
        let mut done = 0usize;
        // SAFETY: reads `size` bytes of the other process into `into`, which
        // the caller sized; a failed or short read is refused.
        unsafe { ReadProcessMemory(process.raw(), address as *const _, into, size, &mut done) != 0 && done == size }
    };
    let mut parameters = 0u64;
    if !read(basic.PebBaseAddress as u64 + PARAMETERS_IN_PEB, std::ptr::addr_of_mut!(parameters).cast(), 8) || parameters == 0 {
        return None;
    }
    let mut directory = RemoteString::default();
    if !read(parameters + DIRECTORY_IN_PARAMETERS, std::ptr::addr_of_mut!(directory).cast(), std::mem::size_of::<RemoteString>()) {
        return None;
    }
    let len = directory.length as usize / 2;
    if len == 0 || len > 32 * 1024 {
        return None;
    }
    let mut units = vec![0u16; len];
    if !read(directory.buffer, units.as_mut_ptr().cast(), len * 2) {
        return None;
    }
    let path = String::from_utf16_lossy(&units);
    Some(PathBuf::from(path.trim_end_matches('\\')))
}

/// Whether process `pid` sits in a console a person can see and type into:
/// its console host has a visible window of its own (a classic console), or
/// is the pseudo-console of a Windows Terminal tab. A hidden console (a
/// process started with `CREATE_NO_WINDOW`), a pseudo-console another
/// program hosts, or none at all is not one: what a controlling terminal of
/// a person's is to the Unix consent rule.
pub(crate) fn interactive_console(pid: u32) -> bool {
    let Ok(Some(host)) = console_host(pid) else { return false };
    if has_visible_window(host) {
        return true;
    }
    let Ok(table) = processes() else { return false };
    let Some(entry) = table.iter().find(|entry| entry.pid == host) else { return false };
    let hosted = entry.name.eq_ignore_ascii_case("OpenConsole.exe") || entry.name.eq_ignore_ascii_case("conhost.exe");
    let terminal = table.iter().find(|parent| parent.pid == entry.parent)
        .is_some_and(|parent| parent.name.eq_ignore_ascii_case("WindowsTerminal.exe")
            && matches!((started(parent.pid), started(host)), (Some(terminal), Some(console)) if terminal <= console));
    hosted && terminal
}

/// Whether process `pid` owns a visible top-level window.
fn has_visible_window(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};
    struct Search {
        pid: u32,
        found: bool,
    }
    unsafe extern "system" fn visit(window: HWND, search: LPARAM) -> windows_sys::core::BOOL {
        // SAFETY: `search` is the `Search` passed to EnumWindows below,
        // alive for the whole enumeration.
        let search = unsafe { &mut *(search as *mut Search) };
        let mut owner = 0u32;
        // SAFETY: a window handle EnumWindows just gave.
        unsafe { GetWindowThreadProcessId(window, &mut owner) };
        // SAFETY: as above.
        if owner == search.pid && unsafe { IsWindowVisible(window) } != 0 {
            search.found = true;
            return 0;
        }
        1
    }
    let mut search = Search { pid, found: false };
    // SAFETY: `visit` only reads windows and writes `search`, which outlives the call.
    unsafe { EnumWindows(Some(visit), std::ptr::addr_of_mut!(search) as LPARAM) };
    search.found
}

/// One row of the process table.
#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub pid: u32,
    pub parent: u32,
    /// The executable's file name, without its directory.
    pub name: String,
}

/// Every process on the machine, as Toolhelp sees it now.
pub(crate) fn processes() -> io::Result<Vec<Entry>> {
    // SAFETY: returns an owned snapshot handle or INVALID_HANDLE_VALUE.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a fresh handle, closed by OwnedHandle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot as RawHandle) };
    let raw = snapshot.as_raw_handle() as HANDLE;
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut rows = Vec::new();
    // SAFETY: `entry.dwSize` is set as the API requires.
    let mut more = unsafe { Process32FirstW(raw, &mut entry) } != 0;
    while more {
        let len = entry.szExeFile.iter().position(|&unit| unit == 0).unwrap_or(entry.szExeFile.len());
        rows.push(Entry {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..len]),
        });
        // SAFETY: as above.
        more = unsafe { Process32NextW(raw, &mut entry) } != 0;
    }
    Ok(rows)
}

/// Every descendant of `pid` (not `pid` itself), parents before children,
/// each with when it started. Windows records a parent by pid only and
/// reuses pids, so a process whose recorded parent started after it has
/// another parent's pid, and is not counted (nor what it started).
pub(crate) fn descendants(pid: u32) -> io::Result<Vec<(Entry, u64)>> {
    let table = processes()?;
    let mut found: Vec<(Entry, u64)> = Vec::new();
    let Some(root_started) = started(pid) else { return Ok(found) };
    let mut frontier = vec![(pid, root_started)];
    while let Some((parent, parent_started)) = frontier.pop() {
        for entry in table.iter().filter(|entry| entry.parent == parent && entry.pid != parent && entry.pid != pid) {
            let Some(child_started) = started(entry.pid) else { continue };
            if child_started < parent_started || found.iter().any(|(seen, _)| seen.pid == entry.pid) {
                continue;
            }
            frontier.push((entry.pid, child_started));
            found.push((entry.clone(), child_started));
        }
    }
    Ok(found)
}

/// Terminate process `pid` only while it is still the process that was
/// seen: the same image, started at the same time, of this user. `Ok(false)`
/// when it has gone or is another process now.
pub(crate) fn terminate_if(pid: u32, image: &Path, when: u64, wait: Duration) -> io::Result<bool> {
    let process = match Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE) {
        Ok(process) => process,
        Err(error) if error.raw_os_error() == Some(87) => return Ok(false),
        Err(error) => return Err(error),
    };
    // With the handle open the pid cannot pass to another process, so what
    // is read now is this process's.
    if !process.running()? || started(pid) != Some(when) || !same_file(&process.image()?, image) {
        return Ok(false);
    }
    if super::security::process_user(pid)? != super::security::current_user()? {
        return Ok(false);
    }
    process.terminate(1)?;
    process.wait(wait)?;
    Ok(true)
}

/// A Job Object that kills every process in it when the last handle to it
/// closes, or when [`Job::terminate`] is called: what a process group and
/// `killpg` are on Unix, without the race of walking the tree.
pub(crate) struct Job(OwnedHandle);

impl Job {
    pub(crate) fn new() -> io::Result<Self> {
        // SAFETY: an unnamed job with default security, owned below.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh handle nobody else owns.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is the struct this information class names.
        if unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle() as HANDLE
    }

    /// Put process `pid` (and so everything it starts from now on) in the job.
    pub(crate) fn assign_pid(&self, pid: u32) -> io::Result<()> {
        use windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA;
        let process = Process::open(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE)?;
        // SAFETY: both handles are live with the access the call needs.
        if unsafe { AssignProcessToJobObject(self.raw(), process.raw()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn assign(&self, child: &std::process::Child) -> io::Result<()> {
        // SAFETY: the child's handle is live for as long as `child`.
        if unsafe { AssignProcessToJobObject(self.raw(), child.as_raw_handle() as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// How many processes in the job are still running: a process the job's
    /// first process started counts even once that one has exited.
    pub(crate) fn active(&self) -> io::Result<u32> {
        use windows_sys::Win32::System::JobObjects::{JobObjectBasicAccountingInformation, QueryInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION};
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: `info` is the struct this information class fills.
        if unsafe {
            QueryInformationJobObject(
                self.raw(),
                JobObjectBasicAccountingInformation,
                std::ptr::addr_of_mut!(info).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(info.ActiveProcesses)
    }

    /// Kill every process in the job now.
    pub(crate) fn terminate(&self, code: u32) -> io::Result<()> {
        // SAFETY: a live job handle.
        if unsafe { TerminateJobObject(self.raw(), code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// The jobs of processes this one started and must never outlive it, by
/// pid. A job kills what is in it when its last handle closes, which is at
/// the latest when this process ends, however it ends.
fn owned_jobs() -> &'static std::sync::Mutex<std::collections::HashMap<u32, Job>> {
    static JOBS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, Job>>> = std::sync::OnceLock::new();
    JOBS.get_or_init(Default::default)
}

/// Bind `child` and everything it starts to this process's life: what a
/// process group with a watchdog on a pipe is on Unix.
///
/// The jobs of tied processes that have since exited are let go first:
/// closing such a job ends what that process left running, which nothing
/// would otherwise end before this process does. A pid is only given out
/// again once its process has gone, so an entry for this child's pid is
/// always such a job.
pub(crate) fn tie_to_this_process(child: &std::process::Child) -> io::Result<()> {
    let job = Job::new()?;
    job.assign(child)?;
    let mut jobs = owned_jobs().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    jobs.retain(|pid, _| *pid != child.id() && is_running(*pid));
    jobs.insert(child.id(), job);
    Ok(())
}

/// End process `pid` and everything it started, when it was tied to this
/// process; `false` when it was not.
pub(crate) fn kill_tree(pid: u32) -> bool {
    let job = owned_jobs().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&pid);
    match job {
        Some(job) => {
            let _ = job.terminate(1);
            true
        }
        None => false,
    }
}

/// Close a raw handle someone gave up ownership of.
pub(crate) fn close(handle: HANDLE) {
    if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
        // SAFETY: the caller owns `handle` and never uses it again.
        unsafe { CloseHandle(handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn ping() -> std::process::Child {
        Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap()
    }

    #[test]
    fn this_process_is_running_and_has_an_image() {
        assert!(is_running(std::process::id()));
        let image = image_path(std::process::id()).unwrap();
        assert!(same_file(&image, &std::env::current_exe().unwrap()), "{}", image.display());
        assert!(processes().unwrap().iter().any(|entry| entry.pid == std::process::id()));
    }

    #[test]
    fn terminate_refuses_another_image_and_kills_the_expected_one() {
        let mut child = ping();
        let pid = child.id();
        let wrong = std::env::current_exe().unwrap();
        assert!(terminate_verified(pid, &wrong, Duration::from_secs(1)).is_err());
        assert!(is_running(pid));
        let image = image_path(pid).unwrap();
        assert!(terminate_verified(pid, &image, Duration::from_secs(5)).unwrap());
        child.wait().unwrap();
        assert!(!is_running(pid));
    }

    #[test]
    fn a_job_kills_its_processes() {
        let job = Job::new().unwrap();
        let mut child = ping();
        job.assign(&child).unwrap();
        job.terminate(1).unwrap();
        assert!(!child.wait().unwrap().success());
        let mut child = ping();
        let pid = child.id();
        {
            let job = Job::new().unwrap();
            job.assign_pid(pid).unwrap();
        }
        // Closing the last handle to the job kills what is in it, with exit
        // code 0: that it ended, long before its 30 pings, is what tells.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while is_running(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!is_running(pid));
        child.wait().unwrap();
    }
}
