# Proposal: add-desktop-app

## Why

The harness ships three operator surfaces — headless CLI, browser web-app, ACP for editors — but no standalone desktop application. A Codex-style experience (click an icon, get a persistent native window) currently requires keeping a browser tab pointed at `dsh web`. The web-app bundle already delivers the entire in-window experience over a loopback HTTP server, so a thin native shell closes this gap without touching the core.

## What Changes

- New top-level `desktop/`: a Tauri v2 Rust shell. MVP scope is window + process lifecycle only.
- The shell spawns the existing web host as a sidecar on a dedicated fixed port, falling back to an OS-assigned port on bind conflict (a stable origin keeps localStorage-backed drafts and view state across restarts). No new bundle layer in the MVP — a `desktop-app` patch layer is added only when a row actually diverges.
- Handshake reuses the existing stdout line `dsh web: http://127.0.0.1:<port>`; the shell navigates the webview there. The browser-trust fence is unchanged — a loopback Host passes by design, as verified in WebKit (36/36 `/api` calls succeed, zero console errors).
- A shell-side webview interaction contract (no frontend changes): disable Tauri's native drag-drop so the SPA's HTML5 drop handlers work, delegate external http(s) links to the system browser (WKWebView leaves `target="_blank"` as a silent no-op otherwise), and install a default menu with standard Edit items so Cmd+C/V/A work on macOS.
- Sidecar packaging: one executable via Node SEA over `apps/cli`'s existing single-file bundle (`lib/bin.js`).
- Lifecycle: single-instance lock; SIGTERM to the sidecar on quit (the host already drains telemetry on SIGINT/SIGTERM); orphaned-sidecar cleanup on start.
- Follow-ups, out of MVP scope: tray, system notifications, native directory picker bridging, code signing/notarization, auto-update, Windows/Linux shells.

## Capabilities

### New Capabilities

- `desktop-app`: the desktop shell's externally observable contract — sidecar spawn and stdout handshake, a window bound to the handshake URL, single-instance behavior, and teardown that terminates the host.

### Modified Capabilities

(none — the web bundle, trust fence, and client roster are consumed as-is)

## Impact

- New: `desktop/` (Rust crate, Tauri v2) and a build script producing the SEA sidecar from `apps/cli` output.
- Reused unchanged: `apps/cli` bundle output, the `web` profile and web-app bundle, browser-trust fence, client plugin roster (platform `web`).
- New toolchain in the repo: Rust/Cargo and tauri-cli as dev-only dependencies; CI implications deferred with the platform matrix.
- Distribution (signing, updater feed, DMG/MSI artifacts) is explicitly deferred; the MVP target is a runnable local build.
