# Agent Note: Desktop distribution is a post-re-sign ditto zip, not a tauri bundle

Status: implemented

English | [中文](2026-08-18-desktop-dist-packaging.zh.md)

## Problem

`desktop:build` assembles a self-contained `.app`, but the two obvious packaging moves both ship broken artifacts silently. Tauri's own bundling (a `dmg` entry in `bundle.targets`) runs inside `tauri build`, before `build-desktop-app.mjs` injects `Contents/Resources/runtime` and re-signs — a tauri-produced dmg contains a runtime-less app. Plain `zip -r` follows symlinks by default (only `-y` preserves them), dereferencing the pnpm layout whose `.pnpm` self-referential links are deliberately kept symbolic; the archive balloons and the store layout breaks. A third trap: `pnpm deploy --prod --legacy` runs a workspace-wide production install that prunes devDependencies from root `node_modules/` and then runs lifecycle scripts — the root postinstall hard-imports `lefthook/package.json` (a devDependency) and crashes. The fix is three-pronged: `--config.ignore-scripts=true` on the deploy to suppress lifecycle execution, `CI=true pnpm install` after to restore the full workspace, and a dynamic-import guard in `install-lefthook.mjs` that catches `ERR_MODULE_NOT_FOUND` and skips (no devDeps → no lefthook → no hooks to configure). On top of that, the desktop version lives independently in `tauri.conf.json` and `src-tauri/Cargo.toml`, and an arm64 host would happily produce a legitimate-looking `_arm64.zip` that nobody validated.

## Decision

**`scripts/build-desktop-dist.mjs` (`pnpm run desktop:dist`) gates, chains, zips, and verifies.** Entry gates run before anything else: version agreement — `tauri.conf.json` via strict `JSON.parse`, `Cargo.toml`'s `[package]` `version` by a narrow scan, both failing loud with both values, no defaulting — and host architecture (`process.arch` must be `x64`, the only validated target; a Rosetta host reports `x64`, which is self-consistent, since the toolchain that runs is the toolchain that builds). The chain spawns the existing package scripts through `pnpm run` (`build` → `desktop:runtime` → `desktop:build`) so each script's env prefix stays with its owner — `desktop:build` carries its own `npm_config_verify_deps_before_run=false`. The zip is cut from the re-signed `.app` with `ditto -c -k --keepParent` into `desktop/dist/dsh-desktop_<version>_<arch>.zip`, then verified by expanding with `ditto -x -k` and asserting: exactly one top-level `dsh-desktop.app`, the runtime entry present, at least one symlink inside the expanded `.pnpm` store is still symbolic (pnpm's `deploy --prod --legacy` layout stores packages directly under `@scope/name` as directories, not symlinks; the self-referential links live inside `.pnpm/<hash>/node_modules/`, so the assertion walks into `.pnpm` subdirectories), and `codesign --verify` passing — the archive-level twin of `injectRuntime`'s materialization assertion. The summary prints the SHA-256 that the release notes carry; release tags use the `desktop-v` prefix to stay out of the npm tag space.

**Strict JSON on `tauri.conf.json` is deliberate.** The file is comment-free today; Tauri 2 permits JSONC in general. A future commented edit surfaces here as a parse failure, which is the correct failure — switch to tolerant parsing then, never a silent default.

## Alternatives

- **tauri `dmg` target** — produced before the runtime injection and the re-sign; content-incomplete and signature-broken.
- **`zip -r`** — dereferences the pnpm symlink layout by default.
- **`hdiutil` dmg** — works post-re-sign, but a zip is what receivers expect for an unsigned build and what the maintainer chose.
- **Single-source version generation** — the agreement gate is smaller and fails loud; generation can come if the duplication ever drifts in practice.
- **npm-script chaining** — the gates, zip, and verification are logic, and the `desktop:build` env prefix would have to be reproduced in every caller.

## Consequences

Distribution remains unsigned: receivers bypass Gatekeeper manually (the Finder confirm dialog or `xattr -dr com.apple.quarantine`), and the SHA-256 in the release notes is the only integrity anchor. Releases depend on one Intel host; a CI follow-up is blocked on Intel-runner availability, not on this pipeline. `desktop/dist/` is cleared at entry, so each run replaces the previous outputs — multi-version archiving lives in the GitHub Release, not the build directory.

## Testing

The script verifies its own output on every run (expansion, top-level layout, runtime entry, symlink survival, codesign); the change's task 3 (`openspec/changes/add-desktop-dist/tasks.md`) covers the end-to-end lanes: clean-state build, version-mismatch failure, rerun idempotence, no-repo launch, and the architecture-gate negative test.
