# Agent Note: The desktop shell is a Tauri window over the existing web surface, with the host as a SEA sidecar

Status: implemented

English | [中文](2026-08-16-desktop-shell-tauri-window-over-web-surface.zh.md)

## Problem

The harness ships three operator surfaces — the headless CLI, the browser web-app, and the ACP server for editors — but no standalone desktop application. A Codex-style experience (click an icon, get a persistent native window) requires keeping a browser tab pointed at `dsh web`. The web-app bundle already delivers the entire in-window experience over a loopback HTTP server, so the gap is a thin native shell, not a new UI.

## Decision

**A Tauri v2 shell at top-level `desktop/` owns the lifecycle of the existing web host, spawned as a sidecar.** The shell runs `dsh-desktop-host web --port 3199` (a dedicated fixed port, falling back to an OS-assigned port on bind conflict), parses the host's existing `dsh web: <url>` stdout line within a 30 s window, and opens one window against that loopback URL. The browser-trust fence, the SPA, and the client plugin roster are consumed unchanged; no new cordis bundle layer exists until a composition row actually diverges for desktop.

**The sidecar is a Node Single Executable Application whose embedded CJS launcher imports the CLI's ESM bundle in place.** Node's SEA runs the embedded main as CommonJS on the supported engine range (`node ^22.19 || >=24`), so an ESM bundle cannot be embedded directly — the launcher `import()`s `apps/cli/lib/bin.js` from its build location, because the bundle's runtime plugin imports (the Loader's bare-specifier resolution) are anchored to its own directory's node_modules walk. The sidecar therefore needs the repo checkout at runtime; the "single executable" claim is about the Node runtime, not the whole application.

**The shell-side webview interaction contract fixes three WKWebView/Tauri defaults that silently break SPA interactions** (each traced to SPA code by a frontend review): `dragDropEnabled: false` (Tauri's native drag-drop otherwise swallows `dragover`/`drop`, killing file-into-input attachment and workspace row reordering), new-window/navigation delegation that opens external http(s) in the system browser (`target="_blank"` links are silent no-ops in WKWebView without a delegate), and a default application menu with standard Edit items (macOS distributes Cmd+C/V/A through the menu bar).

**The fixed port is a data-behavior decision, not a convenience.** Client state persisted in localStorage is keyed by origin (`dsh.conversation.chat` drafts, `dsh.sessions.current`, `dsh.workspace.view.v5`, `dsh.trajectory.duration`), so an OS-assigned port every launch silently wipes drafts and view state. The fixed port keeps the origin stable in the ordinary case; the fallback loses that state only in the rare conflict case, which the spec marks as observable rather than silent.

## Alternatives

- **Electron** — one runtime (Node is already the host), but a ~150 MB+ artifact and a heavier distribution story; the shell is thin enough that Rust adds no real cost, and the repo already hosts non-pnpm build areas (`python/`, `native/`, `website/`).
- **PWA / "Add to Dock"** — zero code, but no tray, notifications, or native dialogs, and the window is still a browser tab in disguise.
- **Bundled Node runtime next to `bin.js`** — the design's D1 fallback; SEA + CJS launcher was chosen because it works on the supported engine range and keeps the runtime embedded.
- **A `desktop-app` bundle layer in the MVP** — no composition row diverges yet; the shell consumes the `web` profile verbatim. The layer appears when a row actually needs a desktop value.
- **Port 0 always** — the orphan-collision argument, rejected because it silently wipes localStorage state every launch; the fallback path keeps the collision benefit.

## Consequences

macOS-only MVP: Windows/Linux shells, signing, notarization, and auto-update are deferred. The Linux port must ship native addons beside the executable (SEA cannot embed them). The sidecar needs the repo checkout at runtime, which bounds the distribution story until the Loader's plugin resolution is bundled. A shell crash can orphan the sidecar; a new launch cannot collide with it because the fallback port is OS-assigned. `target="_blank"` links that WKWebView swallows before navigation are a known gap pending upstream wry support.

## Testing

`desktop/e2e/sidecar-handshake.mjs` is the keyless CI-able lane: it runs the SEA executable directly in web mode, asserts exactly one stdout handshake line, exercises the announced surface over HTTP (index + one RPC), SIGTERMs, and asserts a clean exit. The build script (`scripts/build-desktop-sidecar.mjs`) smoke-verifies `--help` with no `node` on PATH and asserts the ad-hoc signature, which is load-bearing on macOS (an unsigned copy is killed at exec). The interaction contract (drag-drop, paste, Cmd+C/V/A, dark mode, title, draft persistence, external links) is a manual checklist in the change's task 3.4, because no-GUI e2e cannot see it.
