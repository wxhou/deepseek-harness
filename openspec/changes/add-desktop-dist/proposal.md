## Why

The desktop shell exists only as a locally built `.app` behind a four-step manual sequence (`install → build → desktop:runtime → desktop:build`). There is no single reproducible entry point, no distributable artifact, and no documented release path, so the build cannot be handed to another machine. We need to distribute the Intel (x64) build to other users and to repeat that reliably.

## What Changes

- Add `pnpm run desktop:dist`: one idempotent command that chains the existing build chain (`pnpm run build` → `desktop:runtime` → `desktop:build`) and packages the resulting `.app` into a versioned, arch-tagged zip (`dsh-desktop_<version>_x64.zip`). A `--skip-build` flag reuses an existing `lib/` for shell-only iteration.
- Package the zip with `ditto -c -k --keepParent` from the runtime-injected, re-signed `.app`: tauri's own bundle step runs before runtime injection (its dmg would be content-incomplete), and plain `zip -r` dereferences the pnpm symlink layout inside the runtime tree.
- Gate the dist build at entry: fail loud when `desktop/src-tauri/tauri.conf.json` `version` and `desktop/src-tauri/Cargo.toml` `version` disagree, or when the host's build architecture is not x64 (the only validated target), instead of shipping mismatched metadata or an unvalidated artifact. Each run clears `desktop/dist/` first, so a run's outputs replace the previous ones.
- Release flow: `desktop:dist` prints the artifact's SHA-256; the maintainer attaches the zip and the checksum to a GitHub Release tagged `desktop-v<version>`, keeping the desktop tag space separate from the npm release series.
- Document distribution in `desktop/README.md` and `desktop/README.zh.md`, including rewriting the now-stale "No distribution" limitation entry.

Out of scope: code signing and notarization (no Apple Developer ID), arm64/universal builds, CI-built artifacts (Intel-hosted runners are not a dependable base; builds happen on a real Intel Mac), Windows/Linux shells, and auto-update.

## Capabilities

### New Capabilities

- `desktop-dist`: reproducible one-command production of a self-contained, distributable macOS desktop artifact (x64 zip) and the release contract around it — naming, version and architecture gates, checksum anchoring, and the unsigned-build distribution steps.

### Modified Capabilities

None — `desktop-app` requirements are unchanged; this change adds a distribution capability beside them.

## Impact

- New orchestrator script `scripts/build-desktop-dist.mjs` and a `desktop:dist` entry in the root `package.json`.
- `desktop/README.md` and `desktop/README.zh.md` gain a distribution section.
- No harness runtime or plugin code changes; `tauri.conf.json` bundle targets stay `["app"]`.
