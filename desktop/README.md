# dsh desktop

English | [中文](README.zh.md)

The DeepSeek Harness desktop shell: a Tauri v2 window around the existing web
surface, owning the lifecycle of a private host process. The shell spawns the
web host as a sidecar, handshakes on its stdout URL line, and opens one window
against that loopback URL — the browser-trust fence, the SPA, and the client
plugin roster are consumed unchanged.

The contract this implements lives in
`openspec/changes/add-desktop-app/` (spec `desktop-app`).

## Layout

```
desktop/
  bin/            build output: dsh-desktop-host (SEA executable)
  build/          SEA staging (sea-config, blob, launcher)
  e2e/            keyless sidecar handshake test
  runtime/        the runtime dependency manifest (deploy root, like python/sdk-runtime)
  runtime-dist/   `pnpm run desktop:runtime` output: the production node_modules the .app bundles
  src-tauri/      the Tauri v2 crate (Rust shell)
  ui/             stub frontendDist required by tauri bundling
```

## Prerequisites

- Node ^22.19 || >=24 and pnpm (repo standard)
- Rust toolchain (cargo/rustc; Homebrew `brew install rust` works)
- `@tauri-apps/cli` and `postject` are root devDependencies (installed by
  `pnpm install`)

## Build and run

```sh
pnpm run desktop:runtime   # deploy the production node_modules → desktop/runtime-dist/
pnpm run desktop:sidecar   # build:lib + bake the SEA sidecar into desktop/bin/
pnpm run desktop:dev       # sidecar + cargo run (debug shell)
pnpm run desktop:build     # sidecar + tauri build + ditto-inject the runtime → self-contained .app
pnpm run desktop:dist      # the full chain + zip → desktop/dist/dsh-desktop_<version>_<arch>.zip
```

Iterating on the shell only: `node scripts/build-desktop-sidecar.mjs --no-build`
reuses the existing `apps/cli/lib/bin.js`.

## How it works

1. The shell spawns `desktop/bin/dsh-desktop-host web --port 3199` (a dedicated
   fixed port; falls back to an OS-assigned port on bind conflict).
2. The host prints `dsh web: http://127.0.0.1:<port>` on stdout; the shell
   parses that line within a 30 s window and navigates the window there.
3. Quitting SIGTERMs the sidecar (the host drains telemetry on SIGTERM), waits
   up to 5 s, then SIGKILLs.

The sidecar is a Node Single Executable Application whose embedded CJS launcher
imports the CLI's ESM bundle (`apps/cli/lib/bin.js`): Node's SEA runs embedded
mains as CommonJS, so the ESM bundle cannot be embedded directly. The shell
resolves both the sidecar binary and the bundle (repo checkout first, bundled
resources second) and passes the bundle path to the launcher via
`DSH_DESKTOP_BUNDLE`.

**The bundled .app is self-contained.** `desktop/runtime/` is a pure dependency
manifest (the `python/sdk-runtime` pattern) whose deployed closure — every
runtime plugin and its production deps — is injected into
`Contents/Resources/runtime` with ditto. The sidecar's launcher imports
`runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` through the
`DSH_DESKTOP_BUNDLE` env var; because the bundle lives inside that
node_modules tree, its bare-specifier resolution and the Loader's runtime
plugin imports resolve entirely within the bundle. The .app therefore runs on
a machine without the repo checkout (it still needs a model: a DeepSeek API
key or a local Ollama, configured in `~/.dsh/settings.yaml`).

## Distribution

`pnpm run desktop:dist` runs the whole chain — workspace build, runtime deploy, app assembly — and packages the re-signed `.app` into `desktop/dist/dsh-desktop_<version>_<arch>.zip` with `ditto -c -k --keepParent`, which preserves the runtime's pnpm symlink layout (tauri's own bundling runs before the runtime injection). It refuses to run unless the versions in `tauri.conf.json` and `src-tauri/Cargo.toml` agree and the host is x64; `--skip-build` reuses existing `lib/` artifacts.

The build is unsigned. Publish it on a real Intel Mac:

```sh
shasum -a 256 desktop/dist/dsh-desktop_*.zip   # dist prints this; paste it into the release notes
gh release create desktop-v<version> desktop/dist/dsh-desktop_<version>_x64.zip
```

Release tags carry the `desktop-v` prefix, keeping the desktop series separate from the npm release tags. A receiver verifies the download and passes the unsigned-build Gatekeeper block:

```sh
shasum -a 256 dsh-desktop_<version>_x64.zip    # compare against the release notes
xattr -dr com.apple.quarantine /Applications/dsh-desktop.app   # or right-click → Open in Finder
```

## Known Limitations and Deferred Work

- **macOS only** in the MVP; Windows/Linux shells and the platform matrix are
  deferred. The Linux port must ship native addons beside the executable (SEA
  cannot embed them).
- **Unsigned zip distribution**: `desktop:dist` packages the ad-hoc-signed
  `.app` (see the Distribution section); code signing, notarization, and
  auto-update remain missing, so receivers bypass Gatekeeper manually.
- **Client-side persisted state resets when the fixed port is unavailable**:
  localStorage is keyed by origin, so a launch that falls back to an
  OS-assigned port starts with empty drafts and view state (the spec marks
  this as observable).
- **No page zoom** (Cmd+=/-) and the window title may not mirror
  `document.title`; both are accepted for the MVP.
- **`target="_blank"` links**: external http(s) links are delegated to the
  system browser via the shell's navigation handler; any new-window path
  WKWebView swallows before navigation is a known gap pending upstream wry
  support.
- **Orphaned sidecar after a shell crash**: no cleanup mechanism yet; a new
  launch cannot collide with an orphan because the fallback port is
  OS-assigned.
