# Tasks: add-desktop-app

## 1. Sidecar build pipeline

- [x] 1.1 Add a script that builds `apps/cli` and asserts the single-file entry `lib/bin.js` exists after the build
- [x] 1.2 Add the SEA bake step (sea-config + postject) producing `desktop/bin/dsh-desktop-host`; verify it answers `--help` with no Node on PATH
- [x] 1.3 Wire the root script `desktop:sidecar` chaining 1.1–1.2

## 2. Tauri shell (`desktop/`)

- [x] 2.1 Scaffold the Tauri v2 crate at `desktop/` (window config, minimal `main.rs`, `tauri.conf.json`) with a runnable `desktop:dev`; window config sets `dragDropEnabled: false` and the app installs a default menu with standard Edit items (Cmd+C/V/A)
- [x] 2.2 Spawn the sidecar on a dedicated fixed port, falling back to `--port 0` on bind conflict; capture stdout, and parse the `dsh web: <url>` line within a 30 s startup window
- [x] 2.3 Navigate the window to the handshake URL; on timeout or early sidecar exit, show a named error state instead of a blank window
- [x] 2.4 Add the single-instance plugin: a second launch focuses the existing window and starts no host
- [x] 2.5 Implement teardown: SIGTERM the sidecar on quit, bounded wait, then SIGKILL
- [x] 2.6 Implement shell-side new-window/navigation delegation: external http(s) links open in the system default browser; non-http schemes stay in-window

## 3. Verification

- [x] 3.1 Keyless e2e: run the SEA sidecar directly, assert the stdout handshake line and an HTTP 200 + `/api` success against the announced port (no GUI, CI-able)
- [x] 3.2 Quit-path check: quit the app after a turn, assert the host process is gone within the bounded window
- [x] 3.3 Second-launch check: launch twice, assert one host process and focused existing window
- [x] 3.4 Full-chain manual interaction checklist on a clean checkout (`desktop:build` after `pnpm install && pnpm run build`): app opens and reaches the chat surface; drag a file into the input; paste a screenshot; copy button; Cmd+C/V/A in the input; dark mode; window title follows the session; restart preserves the input draft; open a search-citation link in the system browser

## 4. Documentation

- [x] 4.1 Write `desktop/README.md`: prerequisites (Rust toolchain, tauri-cli), build, run, known limits (macOS-only MVP, deferred distribution, client-side persisted state resets when the fixed port is unavailable, no page zoom, window title may not follow the session)
- [x] 4.2 Add the Agent Note recording the surface decision (reuse `--profile web`, stdout-line handshake, SEA sidecar) under `.agents/notes/implemented/`
- [x] 4.3 Update the surface inventory in `docs/architecture.md` if it enumerates bundles/surfaces
