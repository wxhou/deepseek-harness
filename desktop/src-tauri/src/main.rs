// dsh desktop shell: spawns the private web host (SEA sidecar), handshakes on
// its stdout URL line, and opens one window against that loopback URL. See
// openspec/changes/add-desktop-app/ for the contract this implements.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::Menu;
use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// The dedicated fixed port: a stable origin keeps localStorage-backed client
/// state (drafts, last session) across restarts. Falls back to port 0 when
/// held by another process.
const DESKTOP_PORT: u16 = 3199;
/// Bounded startup window before the shell reports a named failure.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Bounded teardown window between SIGTERM and SIGKILL.
const TERM_WAIT: Duration = Duration::from_secs(5);
const SIDECAR_NAME: &str = "dsh-desktop-host";

/// The owned sidecar process; taken once at teardown.
struct SidecarState(Mutex<Option<Child>>);

/// Locate the sidecar executable: explicit override, the repo checkout's
/// `desktop/bin` (dev), then the bundled resource. Tauri encodes a `../`
/// resource path as `_up_`; the manual layout is authoritative because the
/// resolver disagrees with the bundle layout under some install paths.
fn sidecar_path(app: &tauri::App) -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("DSH_DESKTOP_SIDECAR") {
        return Some(path.into());
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let dev = std::path::Path::new(manifest)
            .parent()?
            .join("bin")
            .join(SIDECAR_NAME);
        if dev.exists() {
            return Some(dev);
        }
    }
    if let Some(contents) = contents_dir() {
        let bundled = contents.join("Resources/_up_/bin").join(SIDECAR_NAME);
        if bundled.exists() {
            return Some(bundled);
        }
    }
    app.path()
        .resolve("../bin/dsh-desktop-host", BaseDirectory::Resource)
        .ok()
        .filter(|path| path.exists())
}

/// The `.app` Contents directory derived from the running executable.
fn contents_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()?
        .parent()
        .map(|path| path.to_path_buf())
}

/// Locate the CLI bundle the sidecar's launcher imports: explicit override,
/// the repo checkout's `apps/cli/lib/bin.js` (dev), then the bundled runtime
/// (`Resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`, whose
/// node_modules walk covers every runtime plugin import).
fn bundle_path(app: &tauri::App) -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("DSH_DESKTOP_BUNDLE") {
        return Some(path.into());
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let dev = std::path::Path::new(manifest)
            .parent()?
            .parent()?
            .join("apps/cli/lib/bin.js");
        if dev.exists() {
            return Some(dev);
        }
    }
    if let Some(contents) = contents_dir() {
        let bundled = contents
            .join("Resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js");
        if bundled.exists() {
            return Some(bundled);
        }
    }
    app.path()
        .resolve(
            "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js",
            BaseDirectory::Resource,
        )
        .ok()
        .filter(|path| path.exists())
}

/// Spawn the sidecar on `port` and wait for its `dsh web: <url>` stdout line.
/// The reader runs on its own thread so the handshake honors the deadline.
fn spawn_sidecar(
    port: u16,
    sidecar: &std::path::Path,
    bundle: &std::path::Path,
) -> Result<(Child, String), String> {
    let mut child = Command::new(sidecar)
        .args(["web", "--port", &port.to_string()])
        .stdout(Stdio::piped())
        .env("DSH_DESKTOP_BUNDLE", bundle)
        .spawn()
        .map_err(|error| format!("failed to spawn {}: {error}", sidecar.display()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
    let (tx, rx): (Sender<String>, _) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(|line| line.ok()) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            terminate(&mut child);
            return Err("host did not announce its URL within 30s".to_string());
        }
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                if let Some(url) = line.strip_prefix("dsh web: ") {
                    let url = url.trim();
                    if url.starts_with("http://127.0.0.1:") {
                        return Ok((child, url.to_string()));
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                terminate(&mut child);
                return Err("host did not announce its URL within 30s".to_string());
            }
            Err(RecvTimeoutError::Disconnected) => {
                // stdout closed before any URL line: the host exited (a held
                // port on the fixed attempt takes this path).
                let status = child
                    .wait()
                    .map(|status| format!("{status}"))
                    .unwrap_or_else(|error| format!("unreadable status: {error}"));
                return Err(format!("host exited before announcing its URL ({status})"));
            }
        }
    }
}

/// SIGTERM, bounded wait, then SIGKILL. The host drains telemetry on SIGTERM.
fn terminate(child: &mut Child) {
    if child.try_wait().map(|state| state.is_some()).unwrap_or(false) {
        return;
    }
    let pid = child.id().to_string();
    let _ = Command::new("kill").args(["-TERM", &pid]).status();
    let deadline = Instant::now() + TERM_WAIT;
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map(|state| state.is_some())
            .unwrap_or(false)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Route SIGTERM through the app's normal exit path so the sidecar teardown
/// runs. macOS sends SIGTERM on logout and shutdown; without this, the
/// default disposition kills the shell and orphans the sidecar. The signal
/// must be blocked on the main thread BEFORE tauri spawns its event-loop
/// threads (they inherit the mask), so delivery lands on the helper's
/// `sigwait` instead of a thread with the default disposition.
fn install_sigterm_exit(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGTERM);
            let mut signal = 0;
            libc::sigwait(&set, &mut signal);
        }
        handle.exit(0);
    });
}

/// Block SIGTERM on the calling thread; every thread spawned afterwards
/// inherits the block. Call first thing in `main`, before tauri builds.
fn block_sigterm() {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }
}

fn main() {
    block_sigterm();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // Standard application menu keeps macOS Edit key equivalents
        // (Cmd+C/V/A) alive inside WKWebView text fields.
        .menu(|handle| Menu::default(handle))
        .setup(|app| {
            let sidecar = sidecar_path(app)
                .ok_or_else(|| "sidecar executable not found; run `pnpm run desktop:sidecar` first".to_string())?;
            let bundle = bundle_path(app)
                .ok_or_else(|| "CLI bundle not found; run `pnpm run desktop:sidecar` first".to_string())?;
            let (child, url) = match spawn_sidecar(DESKTOP_PORT, &sidecar, &bundle).or_else(|fixed_err| {
                if fixed_err.contains("exited before announcing") {
                    spawn_sidecar(0, &sidecar, &bundle)
                        .map_err(|zero_err| format!("{fixed_err}; OS-assigned-port retry also failed: {zero_err}"))
                } else {
                    Err(fixed_err)
                }
            }) {
                Ok(ready) => ready,
                Err(message) => {
                    app.dialog()
                        .message(format!("dsh desktop failed to start:\n\n{message}"))
                        .kind(MessageDialogKind::Error)
                        .show(|_| std::process::exit(1));
                    return Ok(());
                }
            };
            app.manage(SidecarState(Mutex::new(Some(child))));
            let url = tauri::Url::parse(&url)
                .map_err(|error| format!("handshake URL unparseable ({url}): {error}"))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("DeepSeek Harness")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 600.0)
                .disable_drag_drop_handler()
                // External http(s) leaves the app: the system browser owns it.
                // The loopback origin stays in-window; other schemes are kept
                // in-window rather than dropped.
                .on_navigation(|url: &tauri::Url| {
                    let target = url.as_str();
                    if target.starts_with("http://127.0.0.1:") {
                        true
                    } else if target.starts_with("http://") || target.starts_with("https://") {
                        let _ = open::that_detached(target);
                        false
                    } else {
                        true
                    }
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    install_sigterm_exit(app.handle().clone());
    app.run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        terminate(&mut child);
                    }
                }
            }
        });
}
