//! Live controller input, read out of Slippi Dolphin's emulated GameCube RAM.
//!
//! This is the data source for the OBS overlay's input viewer. The approach is the one
//! m-overlay uses (MIT licence, Copyright (c) 2020 Bkacjios — https://github.com/bkacjios/m-overlay):
//!
//!   1. `CreateToolhelp32Snapshot` to find the Dolphin process
//!   2. `OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)` — no admin rights needed
//!   3. `VirtualQueryEx` walk to locate the emulated GC RAM arena
//!   4. `ReadProcessMemory` to read it, mapping guest 0x80000000.. into that arena
//!
//! Why read memory rather than tail the `.slp`: it works in menus, training mode and modded
//! ISOs, with no replay being written and no file-write latency. Slippi does record offline CPU
//! games, so a replay-based viewer would half-work, but it can never show inputs outside a game.
//!
//! ⚠ Windows only. macOS needs `task_for_pid` (entitlements or root) and is deliberately
//! unsupported — every entry point returns `Ok(None)` elsewhere so the frontend can simply hide
//! the toggle.
//!
//! ⚠ The release profile is `panic = "abort"`, so a panic here kills the whole app. Nothing in
//! this module may unwrap, index or slice unchecked.

use serde::Serialize;

/// One port's controller state. Analog values are already in GameCube units
/// (sticks -1.0..1.0, triggers 0.0..1.0), exactly as Melee itself sees them.
#[derive(Serialize, Clone, Copy, Debug, Default)]
pub struct ControllerState {
    pub port: u8,
    /// Physical button bitfield. Same bit layout as the `.slp` pre-frame "physical buttons"
    /// field, so the overlay can render either source with one mapping.
    pub buttons: u16,
    pub joy_x: f32,
    pub joy_y: f32,
    pub c_x: f32,
    pub c_y: f32,
    pub trigger_l: f32,
    pub trigger_r: f32,
    /// Raw `plugged` byte (struct offset 0x41).
    ///
    /// ⚠ Semantics are EMPIRICAL, from one configuration: a connected port read 0 and the three
    /// empty ones read 255. That is backwards from the field's name, so this is exposed raw
    /// rather than as a bool — the page treats `!= 255` as present, which matches the observed
    /// data without claiming to know what 0 means.
    pub plugged: u8,
}

#[derive(Serialize, Clone, Debug)]
pub struct DolphinSnapshot {
    /// Six-character disc game ID, e.g. "GALE01". Lets the frontend say *which* game is booted
    /// rather than only that something is.
    pub game_id: String,
    pub controllers: Vec<ControllerState>,
}

// ── Melee NTSC 1.02 (GALE01) controller block ──────────────────────────────
// From m-overlay's source/modules/games/GALE01-2.lua.
// ⚠ These are Melee-NTSC-1.02 specific. A different revision needs a different table, which is
// why `game_id` is checked before any of this is read.
const CONTROLLER_BASE: u32 = 0x804C_1FAC;
const CONTROLLER_STRIDE: u32 = 0x44;
const OFF_BUTTONS: usize = 0x00;
const OFF_JOY_X: usize = 0x20;
const OFF_JOY_Y: usize = 0x24;
const OFF_C_X: usize = 0x28;
const OFF_C_Y: usize = 0x2C;
const OFF_TRIG_L: usize = 0x30;
const OFF_TRIG_R: usize = 0x34;
const OFF_PLUGGED: usize = 0x41;

const GUEST_BASE: u32 = 0x8000_0000;
const GUEST_END: u32 = 0x8180_0000;

/// GameCube disc magic, at offset 0x1C of the disc header. Melee copies its header to guest
/// 0x80000000 at boot.
///
/// ⚠ This, not the "GALE01" game ID, is what identifies the arena. The ID alone also appears in
/// Dolphin's own game-list cache and config strings — measured: 6 such false positives in a
/// Dolphin sitting at the game list, with no arena allocated at all.
const DISC_MAGIC: [u8; 4] = [0xC2, 0x33, 0x9F, 0x3D];

/// Floor for a region that could hold the arena. Deliberately NOT "size is a multiple of 32 MiB
/// and type is MEM_MAPPED" (m-overlay's test) — that is an artifact of one Dolphin build's
/// allocator. Measured on a real Slippi Dolphin: its largest MEM_MAPPED region is 28.5 MB, which
/// is not a multiple of 32 MB and that test would reject. The disc magic needs no such guess.
const MIN_ARENA: usize = 0x0100_0000;

#[cfg(not(windows))]
pub fn read_dolphin_inputs() -> Result<Option<DolphinSnapshot>, String> {
    Ok(None)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Memory::{
        VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_GUARD, PAGE_NOACCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    const DOLPHIN_NAMES: &[&str] = &[
        "Slippi Dolphin.exe",
        "Dolphin.exe",
        "DolphinQt2.exe",
        "DolphinWx.exe",
        "dolphin-emu.exe",
    ];

    /// RAII wrapper so an early return can never leak the process handle.
    struct Proc(HANDLE);
    impl Drop for Proc {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn find_dolphin_pid() -> Option<u32> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
            let guard = Proc(snap);
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(guard.0, &mut entry).is_err() {
                return None;
            }
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                if DOLPHIN_NAMES.iter().any(|n| *n == name) {
                    return Some(entry.th32ProcessID);
                }
                if Process32NextW(guard.0, &mut entry).is_err() {
                    return None;
                }
            }
        }
    }

    fn read_bytes(h: HANDLE, addr: usize, len: usize) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; len];
        let mut got: usize = 0;
        unsafe {
            ReadProcessMemory(
                h,
                addr as *const c_void,
                buf.as_mut_ptr() as *mut c_void,
                len,
                Some(&mut got),
            )
            .ok()?;
        }
        if got != len {
            return None;
        }
        Some(buf)
    }

    /// Locate guest 0x80000000 by the disc magic. Returns (host base of the arena, game id).
    fn find_arena(h: HANDLE) -> Option<(usize, String)> {
        let mut addr: usize = 0;
        let mut mbi = MEMORY_BASIC_INFORMATION::default();
        let mbi_size = std::mem::size_of::<MEMORY_BASIC_INFORMATION>();

        while addr < 0x7FFF_FFFF_FFFF {
            let n = unsafe { VirtualQueryEx(h, Some(addr as *const c_void), &mut mbi, mbi_size) };
            if n == 0 {
                break;
            }
            let base = mbi.BaseAddress as usize;
            let size = mbi.RegionSize;
            let readable = mbi.State == MEM_COMMIT
                && (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)).0 == 0;

            if readable && size >= MIN_ARENA {
                // The arena normally starts exactly at the region base.
                if let Some(head) = read_bytes(h, base, 0x20) {
                    if head.get(0x1C..0x20) == Some(&DISC_MAGIC[..]) {
                        if let Some(id) = game_id(&head) {
                            return Some((base, id));
                        }
                    }
                }
            }

            let next = base.saturating_add(size);
            if next <= addr {
                break; // never go backwards; a stalled walk would spin forever
            }
            addr = next;
        }
        None
    }

    fn game_id(head: &[u8]) -> Option<String> {
        let raw = head.get(0..6)?;
        if !raw.iter().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        Some(String::from_utf8_lossy(raw).to_string())
    }

    fn guest_to_host(base: usize, addr: u32) -> Option<usize> {
        if !(GUEST_BASE..GUEST_END).contains(&addr) {
            return None;
        }
        Some(base + (addr - GUEST_BASE) as usize)
    }

    /// ⚠ GameCube memory is BIG-ENDIAN PowerPC. Every multi-byte value needs a `be` read; using
    /// native order here yields plausible-looking garbage rather than an obvious failure.
    fn be_f32(b: &[u8], off: usize) -> f32 {
        match b.get(off..off + 4) {
            Some(s) => f32::from_be_bytes([s[0], s[1], s[2], s[3]]),
            None => 0.0,
        }
    }

    fn be_u16(b: &[u8], off: usize) -> u16 {
        match b.get(off..off + 2) {
            Some(s) => u16::from_be_bytes([s[0], s[1]]),
            None => 0,
        }
    }

    pub fn read_dolphin_inputs() -> Result<Option<DolphinSnapshot>, String> {
        let Some(pid) = find_dolphin_pid() else {
            return Ok(None); // Dolphin not running: a normal state, not an error
        };

        let handle = unsafe {
            OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
                .map_err(|e| format!("OpenProcess failed: {e}"))?
        };
        let proc = Proc(handle);

        let Some((base, game_id)) = find_arena(proc.0) else {
            return Ok(None); // no game booted
        };

        // The address table below is Melee NTSC 1.02 only; reading it for another game would
        // return confident nonsense.
        if game_id != "GALE01" {
            return Ok(Some(DolphinSnapshot {
                game_id,
                controllers: Vec::new(),
            }));
        }

        let mut controllers = Vec::with_capacity(4);
        for port in 0u8..4 {
            let addr = CONTROLLER_BASE + CONTROLLER_STRIDE * port as u32;
            let Some(host) = guest_to_host(base, addr) else {
                continue;
            };
            let Some(blk) = read_bytes(proc.0, host, CONTROLLER_STRIDE as usize) else {
                continue;
            };
            controllers.push(ControllerState {
                port,
                // Low half of the 32-bit button word holds the physical bits.
                buttons: be_u16(&blk, OFF_BUTTONS + 2),
                joy_x: be_f32(&blk, OFF_JOY_X),
                joy_y: be_f32(&blk, OFF_JOY_Y),
                c_x: be_f32(&blk, OFF_C_X),
                c_y: be_f32(&blk, OFF_C_Y),
                trigger_l: be_f32(&blk, OFF_TRIG_L),
                trigger_r: be_f32(&blk, OFF_TRIG_R),
                plugged: blk.get(OFF_PLUGGED).copied().unwrap_or(0xFF),
            });
        }

        Ok(Some(DolphinSnapshot {
            game_id,
            controllers,
        }))
    }
}

#[cfg(windows)]
pub fn read_dolphin_inputs() -> Result<Option<DolphinSnapshot>, String> {
    imp::read_dolphin_inputs()
}

/// One-shot read of every port's controller state.
///
/// `Ok(None)` means "nothing to show" — Dolphin isn't running, no game is booted, or this isn't
/// Windows. Those are all normal, so the frontend treats them the same: hide the viewer.
#[tauri::command]
pub fn dolphin_inputs() -> Result<Option<DolphinSnapshot>, String> {
    read_dolphin_inputs()
}

// ── Pushing inputs to the OBS overlay ──────────────────────────────────────
//
// The overlay's normal channel is a file on disk that the page re-reads twice a second. That is
// right for the panel (rank, rating, set score change every few minutes) and useless at 60 Hz:
// writing and re-reading a file 60 times a second is pure churn and still arrives late.
//
// So the input viewer alone gets a push channel: Server-Sent Events over a localhost socket.
// SSE and not WebSockets because it needs no new dependency — it is an HTTP response that never
// ends — and the browser side is one `EventSource`.
//
// ⚠ This is a deliberate, scoped exception to the overlay's server-less design. Everything else
// keeps using `stats-state.js`, so if this socket is absent the rest of the overlay is unaffected
// and only the input panel goes missing. The port is advertised THROUGH `stats-state.js`, so the
// file channel stays the one thing the page needs to find at startup.

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;

/// Latest snapshot, pre-serialised so a frame is encoded once rather than per connection.
static LATEST: Mutex<Option<String>> = Mutex::new(None);
/// Port the server bound to; 0 until it is running. Doubles as the "already started" flag.
static PORT: AtomicU16 = AtomicU16::new(0);

/// First port tried. 14523 is already taken by the Discord OAuth callback, so start just above
/// and walk up — a fixed port would make a second instance, or any unrelated listener, fatal.
const PORT_BASE: u16 = 14524;
const PORT_TRIES: u16 = 12;
const POLL_HZ: u64 = 60;

fn set_latest(json: Option<String>) {
    if let Ok(mut g) = LATEST.lock() {
        *g = json;
    }
}

fn get_latest() -> Option<String> {
    LATEST.lock().ok().and_then(|g| g.clone())
}

/// Poll Dolphin on a dedicated OS thread.
///
/// ⚠ Deliberately a plain thread, not an async task: the Win32 reads are blocking, and the
/// process handle lives entirely inside this thread so it is never shared across threads.
fn spawn_poller() {
    std::thread::spawn(|| {
        let period = std::time::Duration::from_micros(1_000_000 / POLL_HZ);
        loop {
            match read_dolphin_inputs() {
                Ok(Some(snap)) => set_latest(serde_json::to_string(&snap).ok()),
                // Dolphin closed or no game booted — publish nothing rather than a stale frame,
                // so the overlay hides the panel instead of freezing on the last input.
                Ok(None) => set_latest(None),
                Err(_) => set_latest(None),
            }
            std::thread::sleep(period);
        }
    });
}

/// Start the input push server if it isn't already running, and return its port.
///
/// Idempotent: the frontend calls this whenever the input-viewer toggle turns on, which can
/// happen repeatedly in one session.
#[tauri::command]
pub async fn start_dolphin_input_stream() -> Result<u16, String> {
    let existing = PORT.load(Ordering::SeqCst);
    if existing != 0 {
        return Ok(existing);
    }

    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    let mut bound: Option<(TcpListener, u16)> = None;
    for off in 0..PORT_TRIES {
        let port = PORT_BASE + off;
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)).await {
            bound = Some((l, port));
            break;
        }
    }
    let (listener, port) = bound.ok_or_else(|| {
        format!(
            "no free port in {}..{}",
            PORT_BASE,
            PORT_BASE + PORT_TRIES
        )
    })?;

    // Claim the port before spawning, so two rapid calls can't both start a server.
    if PORT
        .compare_exchange(0, port, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        // Someone else won the race; drop our listener and use theirs.
        return Ok(PORT.load(Ordering::SeqCst));
    }

    spawn_poller();

    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                continue;
            };
            tauri::async_runtime::spawn(async move {
                // Swallow the request head; we serve exactly one thing and ignore the path.
                // Not parsed, because there is nothing to route and a malformed request should
                // simply get the stream.
                let _ = stream.readable().await;
                let mut discard = [0u8; 1024];
                let _ = stream.try_read(&mut discard);

                // `Access-Control-Allow-Origin: *` because the OBS Browser Source loads the page
                // from a file:// URL, which is a null origin — without this the EventSource is
                // blocked. Nothing sensitive is served: it is controller button state.
                let head = concat!(
                    "HTTP/1.1 200 OK\r\n",
                    "Content-Type: text/event-stream\r\n",
                    "Cache-Control: no-store\r\n",
                    "Connection: keep-alive\r\n",
                    "Access-Control-Allow-Origin: *\r\n",
                    "\r\n"
                );
                if stream.write_all(head.as_bytes()).await.is_err() {
                    return;
                }

                let period = std::time::Duration::from_micros(1_000_000 / POLL_HZ);
                let mut last: Option<String> = None;
                let mut since_keepalive = 0u32;
                // ⚠ Send the current state once before the change-detection below takes over.
                // Without this a client that connects while the state is already null receives
                // NOTHING until something changes, so it cannot tell "connected, nothing to
                // show" from "never connected".
                let mut primed = false;
                loop {
                    let cur = get_latest();
                    // Only send on change. A controller at rest is the common case and would
                    // otherwise cost 60 identical frames a second for nothing.
                    let payload = if !primed || cur != last {
                        primed = true;
                        last = cur.clone();
                        Some(match cur {
                            Some(ref j) => format!("data: {j}\n\n"),
                            // An explicit null is not the same as silence: it tells the page to
                            // hide the panel (Dolphin gone) rather than hold the last frame.
                            None => "data: null\n\n".to_string(),
                        })
                    } else if since_keepalive >= POLL_HZ as u32 * 15 {
                        // SSE comment. Keeps idle connections from being reaped by a proxy or the
                        // browser, and surfaces a dead client as a write error.
                        since_keepalive = 0;
                        Some(":\n\n".to_string())
                    } else {
                        None
                    };

                    if let Some(p) = payload {
                        if stream.write_all(p.as_bytes()).await.is_err() {
                            return; // client went away
                        }
                        since_keepalive = 0;
                    } else {
                        since_keepalive = since_keepalive.saturating_add(1);
                    }
                    tokio::time::sleep(period).await;
                }
            });
        }
    });

    Ok(port)
}

/// The running stream's port, or 0 when it has never been started. Lets the frontend put the
/// port into `stats-state.js` without starting the server as a side effect.
#[tauri::command]
pub fn dolphin_input_stream_port() -> u16 {
    PORT.load(Ordering::SeqCst)
}
