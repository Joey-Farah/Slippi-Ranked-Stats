//! Box / B0XX controller input, read over the controller's own USB serial interface.
//!
//! This is the second input source for the OBS input viewer. The first reads Melee's memory
//! (`dolphin.rs`), which is universal but can only see the ANALOG stick values a box produces —
//! so a modifier pressed on its own, which leaves the stick at neutral, is invisible there at
//! any threshold. The controller's serial interface reports real button states, so it can.
//!
//! ⚠ This does NOT replace the memory source. It works only for B0XX/HayBox-style controllers,
//! so GameCube-controller and keyboard users still need `dolphin.rs`. Two paths, permanently.
//!
//! ## Protocol (verified on hardware, and against HayBox's `B0XXInputViewer.cpp`)
//!
//! - Device is a composite: the game controller and this CDC serial port exist **at the same
//!   time**, so no mode switching is needed to use both.
//! - 115200 8N1. ⚠ **RTS must be asserted** or the controller sends nothing at all — the port
//!   opens cleanly and sits silent, which reads exactly like a dead feature.
//! - Each report is 25 bytes: 24 ASCII `'0'`/`'1'` flags then `\n`, about 167/sec (the firmware
//!   emits one report per 5 of its clock ticks).
//! - Buttons occupy indices 0..19 in a fixed order (see `ORDER`). Indices 20-22 are always `'0'`
//!   and index 23 is always `'1'` — in HayBox that is a literal `ASCII_BIT(true)`, which makes it
//!   a convenient fingerprint for "this really is a B0XX-protocol stream".
//!
//! ⚠ Serial is **exclusive**. If another input viewer is running it owns the port and our open
//! fails with access-denied; that is expected, not an error worth surfacing loudly.
//!
//! ⚠ The release profile is `panic = "abort"`, so nothing here may unwrap or index unchecked.

use serde::Serialize;

/// One frame of real button state. Every field is a physical button, not an inference.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BoxState {
    pub start: bool,
    pub y: bool,
    pub x: bool,
    pub b: bool,
    pub a: bool,
    pub l: bool,
    pub r: bool,
    pub z: bool,
    pub up: bool,
    pub down: bool,
    pub right: bool,
    pub left: bool,
    pub mod_x: bool,
    pub mod_y: bool,
    pub c_left: bool,
    pub c_right: bool,
    pub c_up: bool,
    pub c_down: bool,
    pub ls: bool,
    pub ms: bool,
}

/// Report index -> field, in the firmware's order. Index 23 is the constant terminator.
const REPORT_LEN: usize = 24;
const TERMINATOR_IDX: usize = 23;
const BUTTON_COUNT: usize = 20;

impl BoxState {
    /// Decode one report body (the 24 flags, without the trailing newline).
    ///
    /// Returns None when the frame does not look like a B0XX report, so a half-read line or an
    /// unrelated device on the same VID/PID can never be mistaken for all-buttons-released.
    fn parse(line: &[u8]) -> Option<BoxState> {
        if line.len() < REPORT_LEN {
            return None;
        }
        if line.get(TERMINATOR_IDX) != Some(&b'1') {
            return None; // the firmware's constant; its absence means this isn't our protocol
        }
        let mut f = [false; BUTTON_COUNT];
        for (i, slot) in f.iter_mut().enumerate() {
            match line.get(i) {
                Some(b'1') => *slot = true,
                Some(b'0') => {}
                _ => return None,
            }
        }
        Some(BoxState {
            start: f[0], y: f[1], x: f[2], b: f[3], a: f[4],
            l: f[5], r: f[6], z: f[7],
            up: f[8], down: f[9], right: f[10], left: f[11],
            mod_x: f[12], mod_y: f[13],
            c_left: f[14], c_right: f[15], c_up: f[16], c_down: f[17],
            ls: f[18], ms: f[19],
        })
    }
}

#[cfg(not(windows))]
pub fn start_box_reader() {}
#[cfg(not(windows))]
pub fn latest_box() -> Option<BoxState> {
    None
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    /// B0XX identity. HayBox emulates it, and Windows consequently mis-attaches an Xbox 360
    /// driver to the composite device — so the HID side is a red herring; only the CDC
    /// interface matters here.
    const VID: u16 = 0x0738;
    const PID: u16 = 0x4726;
    const BAUD: u32 = 115_200;

    static LATEST: Mutex<Option<BoxState>> = Mutex::new(None);
    static RUNNING: AtomicBool = AtomicBool::new(false);

    pub fn latest_box() -> Option<BoxState> {
        LATEST.lock().ok().and_then(|g| *g)
    }

    fn set_latest(v: Option<BoxState>) {
        if let Ok(mut g) = LATEST.lock() {
            *g = v;
        }
    }

    /// Port name of a connected box controller, if any.
    fn find_port() -> Option<String> {
        let ports = serialport::available_ports().ok()?;
        for p in ports {
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                if info.vid == VID && info.pid == PID {
                    return Some(p.port_name.clone());
                }
            }
        }
        None
    }

    /// Read one connection until it fails. Returns so the caller can retry.
    fn pump(port_name: &str) {
        let port = serialport::new(port_name, BAUD)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .timeout(Duration::from_millis(500))
            .open();

        let mut port = match port {
            Ok(p) => p,
            // Access-denied here is the normal case when another viewer holds the port.
            Err(e) => { eprintln!("[boxx] open {port_name} failed: {e}"); return; }
        };

        // ⚠ BOTH lines are required, and without them the controller stays completely silent:
        // the port opens, every read times out, and it looks exactly like the feature does not
        // work. DTR is the USB-CDC "host is listening" signal and RTS is what the firmware waits
        // on before it starts emitting reports. Asserting only RTS was not enough.
        if port.write_data_terminal_ready(true).is_err() {
            eprintln!("[boxx] could not assert DTR");
            return;
        }
        if port.write_request_to_send(true).is_err() {
            eprintln!("[boxx] could not assert RTS");
            return;
        }

        eprintln!("[boxx] connected: {port_name}");
        let mut reader = BufReader::with_capacity(256, port);
        let mut line = Vec::with_capacity(32);
        let mut misses = 0u32;
        let mut timeouts = 0u32;
        loop {
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => return, // port closed
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // ⚠ A read timeout is NORMAL — it just means no report arrived inside the
                    // window. Treating it as fatal (the first version did) kills the connection
                    // on the first quiet moment and the source never produces anything.
                    // `line` is deliberately NOT cleared: a timeout can land mid-report and the
                    // rest arrives on the next read.
                    timeouts = timeouts.saturating_add(1);
                    if timeouts > 20 {
                        return; // genuinely silent: let the outer loop re-discover the port
                    }
                    continue;
                }
                Err(_) => return, // unplugged, or the port was taken
            }
            timeouts = 0;
            if line.last() != Some(&b'\n') {
                continue; // partial read; keep accumulating
            }
            while matches!(line.last(), Some(b'\n') | Some(b'\r')) {
                line.pop();
            }
            match BoxState::parse(&line) {
                Some(st) => {
                    misses = 0;
                    set_latest(Some(st));
                }
                None => {
                    // A partial first line after connecting is normal; a sustained run of
                    // unparseable frames means this is not a B0XX stream, so stop claiming it is.
                    misses = misses.saturating_add(1);
                    if misses == 1 {
                        eprintln!("[boxx] parse REJECTED len={} raw={:?}", line.len(), String::from_utf8_lossy(&line));
                    }
                    if misses > 200 {
                        set_latest(None);
                        return;
                    }
                }
            }
            line.clear();
        }
    }

    /// Start the reader thread once. Idempotent.
    pub fn start_box_reader() {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| loop {
            match find_port() {
                Some(name) => {
                    pump(&name);
                    // pump() returned: unplugged, or someone else took the port.
                    set_latest(None);
                    std::thread::sleep(Duration::from_millis(1500));
                }
                None => {
                    set_latest(None);
                    std::thread::sleep(Duration::from_millis(2000));
                }
            }
        });
    }
}

#[cfg(windows)]
pub use imp::{latest_box, start_box_reader};

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(high: &[usize]) -> Vec<u8> {
        let mut v = vec![b'0'; REPORT_LEN];
        v[TERMINATOR_IDX] = b'1';
        for &i in high {
            v[i] = b'1';
        }
        v
    }

    /// Diagnostic, not an assertion: prints what the serial crate actually reports on this
    /// machine. Run with `cargo test -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn list_ports_diagnostic() {
        match serialport::available_ports() {
            Ok(ports) => {
                println!("ports: {}", ports.len());
                for p in ports {
                    println!("  name={}  type={:?}", p.port_name, p.port_type);
                }
            }
            Err(e) => println!("available_ports failed: {e}"),
        }
    }

    #[test]
    fn decodes_the_documented_button_order() {
        let s = BoxState::parse(&frame(&[4])).expect("valid frame");
        assert!(s.a, "index 4 is A");
        assert!(!s.b);
        let s = BoxState::parse(&frame(&[12])).expect("valid frame");
        assert!(s.mod_x, "index 12 is Mod X");
    }

    #[test]
    fn mod_alone_is_representable() {
        // The entire point of this source: a modifier with no direction. The memory reader
        // cannot express this, because the stick stays at neutral.
        let s = BoxState::parse(&frame(&[12])).expect("valid frame");
        assert!(s.mod_x);
        assert!(!s.left && !s.right && !s.up && !s.down);
    }

    #[test]
    fn rejects_frames_without_the_firmware_terminator() {
        let mut f = frame(&[4]);
        f[TERMINATOR_IDX] = b'0';
        assert!(BoxState::parse(&f).is_none(), "not a B0XX stream");
    }

    #[test]
    fn rejects_short_and_non_binary_frames() {
        assert!(BoxState::parse(b"0101").is_none());
        let mut f = frame(&[]);
        f[2] = b'x';
        assert!(BoxState::parse(&f).is_none());
    }
}
