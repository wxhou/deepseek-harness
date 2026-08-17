# Design: add-desktop-app

## Context

The harness already separates surfaces from the core: `dsh-base` under three bundles (`headless`, `web-app`), plus ACP and SDK transports. Facts this design leans on, all verified in this working tree:

- `apps/cli` builds to a single ESM file (`lib/bin.js`, tsdown bundles every reachable mode module).
- `WebServer` supports `config.port = 0` with an OS-assigned port, and the web profile prints `dsh web: http://127.0.0.1:<port>` on stdout once listening.
- The browser-trust fence (`isTrustedApiRequest`) admits loopback Hosts by construction; a Playwright WebKit probe passed load and API calls (36/36 `/api`, zero console errors). That clears the load-path risk only — interaction-surface gaps (new-window, drag-drop, menu key equivalents) are handled as explicit decisions below, from a frontend review that traced each to SPA code.
- Repo layout precedent: non-pnpm build areas live at top level (`python/`, `native/`, `website/`).

## Goals / Non-Goals

**Goals:**

- A macOS-runnable Tauri v2 shell whose MVP is exactly the spec's contract: spawn, handshake, window, single instance, teardown.
- Zero harness-side protocol or code changes; the shell consumes existing surfaces only.

**Non-Goals:**

- No tray, notifications, global hotkeys, native dialogs, deep links.
- No signing, notarization, auto-update, or Windows/Linux shells (platform matrix deferred).
- No new cordis bundle layer until a composition row actually diverges for desktop.

## Decisions

### D1 — Sidecar: Node SEA with an embedded CJS launcher over the ESM bundle

Build the sidecar as a Node Single Executable Application whose embedded CJS launcher `import()`s the CLI's ESM bundle in place (`apps/cli/lib/bin.js`). Node's SEA runs the embedded main as CommonJS on the supported engine range (`node ^22.19 || >=24`), so an ESM bundle cannot be embedded directly — verified empirically (the ESM loader cannot load the embedded script, which has no filesystem presence, and falls back to CJS). The bundle stays at its build location because its runtime plugin imports (the Loader's bare-specifier resolution) are anchored to its own directory's node_modules walk; the sidecar needs the repo checkout at runtime anyway.

- Alternatives: shipping a Node runtime next to `bin.js` (+~70 MB, the fallback if SEA blocked); requiring a system Node (smallest artifact, worst install story); a CJS build of the bundle (rejected: the repo's ESM-only source-launch contract and the bundle's dynamic-import shape make a second artifact format a worse trade than a 10-line launcher).
- macOS specifics, verified empirically: postject injection requires `--macho-segment-name NODE_SEA` (without it the binary segfaults), and the ad-hoc signature is load-bearing — an unsigned copy is killed at exec, so the build script asserts it.
- Constraint discovered: SEA does not support native addons in the embedded snapshot. `@deepseek-ai/node-addon-landlock-run` is Linux-only and absent from a macOS launch path, so the MVP is unaffected; the Linux port must ship addon files beside the executable or fall back to the bundled-runtime layout.

### D2 — Handshake: parse the existing stdout line

The shell scans sidecar stdout for `dsh web: <url>` and navigates. A bounded startup window (30 s) gates the error state. Alternatives (JSON event line, health polling) would add a protocol for no current need; the printed line is already load-bearing for humans.

### D3 — Shell lives in a top-level `desktop/` directory

A Tauri v2 crate at `desktop/`, sibling to `python/`, `native/`, `website/`, outside the pnpm workspace — the Rust toolchain is not an npm dependency. Workspace purity and `verify-cordis-config` are untouched; a root script (`desktop:build`) chains: build CLI → bake SEA → `cargo tauri build`.

### D4 — Composition: reuse `--profile web` verbatim

The shell runs the sidecar as `dsh web --port 0`. No desktop profile in the MVP (see Non-Goals). The client-HMR row mounted by web-app stays idle in a packaged app because no rebuild watcher runs.

### D5 — Lifecycle and port strategy

Single instance via tauri's single-instance plugin (second launch focuses the window). Teardown sends SIGTERM to the sidecar and waits a bounded window before SIGKILL; the host's existing SIGINT/SIGTERM drain covers active turns. SIGTERM to the shell is routed through the app's normal exit path (signal blocked on the main thread before tauri spawns its event-loop threads, delivered to a `sigwait` helper that calls `app.exit(0)`), so macOS logout/shutdown cannot orphan the sidecar. Startup does not attempt orphan detection.

Port strategy: the shell first tries a dedicated fixed port, falling back to `--port 0` on bind conflict. Reason: client state persisted in localStorage is keyed by origin (`dsh.conversation.chat` drafts, `dsh.sessions.current`, `dsh.workspace.view.v5`, `dsh.trajectory.duration`), so a random port every launch silently wipes drafts and view state. A fixed port keeps the origin stable in the ordinary case; the fallback loses that state only in the rare conflict case, which the spec marks as observable. The orphan-collision argument for port 0 survives as the fallback path.

### D6 — Webview interaction contract (shell-side, no frontend changes)

Three WKWebView/Tauri defaults silently break SPA interactions; the shell configures its way around each:

- `dragDropEnabled: false` in the window config — Tauri's native drag-drop handler otherwise swallows `dragover`/`drop`, killing file-into-input attachment (`InputBar.tsx` drag handlers) and workspace row reordering.
- New-window/navigation delegation to the system browser (`NSWorkspace` or equivalent) — the SPA's `target="_blank"` links (web-search citations in `WebBlock.tsx`, trajectory image links) are silent no-ops in WKWebView without a delegate; external http(s) opens in the default browser, non-http schemes stay in-window.
- A default application menu including standard Edit items — macOS distributes Cmd+C/V/A through the menu bar; without Edit items, copy/paste in the input can be dead in WKWebView.

## Risks / Trade-offs

- [SEA limitation with native addons surfaces on the Linux port] → ship addons beside the executable, or fall back to bundled-runtime layout (D1 fallback); macOS MVP unaffected.
- [Shell crash leaves an orphaned host] → no MVP mechanism; mitigations (PID file / death-of-parent signal) are an open question, not a blocker since the fallback port path cannot collide.
- [Fixed port held by an orphan makes client state reset look random] → the spec marks the fallback as observable; recorded in README known limits.
- [Two artifacts to keep in lockstep (shell + sidecar)] → both are produced by one `desktop:build` from the same checkout; version metadata embedded in both is a follow-up when distribution exists.
- [WKWebView divergence from Playwright WebKit on the interaction surface] → the D6 contract is pinned by the manual interaction checklist (task 3.4), since no-GUI e2e cannot see drag-drop, menus, or new-window behavior.
- [Window title may not mirror `document.title`; no Cmd+= zoom] → accepted for MVP, recorded as known limitations.

## Migration Plan

Purely additive: new `desktop/` tree and build scripts; no existing package, bundle, or default composition changes. Rollback is deleting the directory.

## Open Questions

- Orphaned-host cleanup after a shell crash (PID file vs parent-death signal) — answer when crash reports exist.
- macOS Universal (arm64 + x64) binary strategy — answer at packaging time, before distribution.
- Where the desktop build lands in CI (Linux runners have Rust; Windows uses the existing wine path) — answer with the platform matrix.
