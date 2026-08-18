# Design: add-desktop-dist

## Context

`desktop:build` (`scripts/build-desktop-app.mjs`) assembles a self-contained, ad-hoc-signed `.app`: SEA sidecar → `tauri build` → runtime injection into `Contents/Resources/runtime` → re-sign → verify. Reaching a distributable artifact today requires three manually ordered commands and ends without an archive; the Tauri config and the Rust manifest each carry the version independently. The build host is a genuine Intel Mac (`rustc` host `x86_64-apple-darwin`, Node x64), and every architecture-sensitive step follows the host. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**

- One command from unbuilt checkout to a distributable, versioned, arch-tagged zip.
- Packaging that is provably content-complete (post-re-sign) and layout-preserving (symlinks stay links).
- A documented maintainer flow (GitHub Release attachment with checksum) and receiver flow (integrity verification, Gatekeeper first launch).

**Non-Goals:**

- Signing/notarization, arm64/universal output, CI-built artifacts, auto-update — all deferred with the pre-release stance.
- Single-source version injection (generating one version file from the other); we gate on agreement instead.

## Decisions

### D1: A new orchestrator script spawning the package scripts through pnpm

`scripts/build-desktop-dist.mjs` spawns `pnpm run build` → `pnpm run desktop:runtime` → `pnpm run desktop:build`, then gates, zips, and verifies; `package.json` gains only `desktop:dist`.

- Why not a pure npm script chain: the version/architecture gates, zip, and archive verification are logic, not commands.
- Why spawning through `pnpm run` rather than calling `node scripts/build-desktop-app.mjs` directly: the `desktop:build` script definition carries its own `npm_config_verify_deps_before_run=false` env prefix, and spawning it via pnpm keeps that quirk with its owner instead of duplicating it into every caller.
- Why not a `--dist` flag on `build-desktop-app.mjs`: the app script's contract is "assemble the .app from an existing runtime deploy"; distribution is a different release cadence with different prerequisites. Spawning existing scripts (the pattern `build-desktop-app.mjs` already uses for the sidecar) keeps each script single-purpose.
- `--skip-build` skips the workspace build step when `lib/` outputs already exist, mirroring `build-exe-for-python-sdk.ts`; usage text states the precondition.
- Idempotence comes from the existing steps (`desktop:runtime` starts with `rm -rf desktop/runtime-dist`, `injectRuntime` removes its destination before copying) plus a `desktop/dist/` clean at entry, which also gives each run replace semantics over the previous run's outputs.

### D2: Zip with `ditto -c -k --keepParent`, not tauri dmg and not `zip -r`

The archive is made from the re-signed `.app` after injection. `tauri build` would produce its bundles before `injectRuntime` writes `Contents/Resources/runtime` and before the re-sign — a tauri-produced dmg ships a runtime-less app, and one taken at any point before re-sign ships a broken signature. `ditto` is used rather than `zip -r` because `zip` follows symlinks by default (only `-y` preserves them), and the runtime tree keeps `.pnpm` self-referential links symbolic on purpose (the same layout constraint `injectRuntime` documents); dereferencing them would balloon the archive and break the store layout. `ditto` preserves symlinks, xattrs, and resource forks and is already part of the build chain's toolset.

### D3: Entry gates for version and architecture, arch tag from `process.arch`

The dist script parses `tauri.conf.json` (`JSON.parse` — the file is comment-free today; a future JSONC edit surfaces as a parse failure, not a silent misparse, and the Agent Note records this boundary) and the `[package]` `version` key from `src-tauri/Cargo.toml` before anything runs, failing with both values on disagreement; the Cargo read uses a narrow scan of the first `version = "…"` under `[package]` and fails loud when absent — no defaulting. It also rejects hosts whose `process.arch` is not `x64`: x64 is the only validated target, and an unvalidated arm64 zip with a legitimate-looking name reaching a Release is an open failure path. A Rosetta host reports `x64`, which is self-consistent — the toolchain that runs is the toolchain that builds. The archive is named `dsh-desktop_<version>_<arch>.zip` with `arch` taken verbatim from `process.arch` (`x64`, Node's naming; Tauri's own bundle naming uses the `x86_64` triple, which we deliberately do not follow).

### D4: Output, cleaning, and verification

The zip lands in `desktop/dist/` (already gitignored, reserved by the app change), which the script clears at entry so a run's outputs replace the previous ones. After zipping, the script verifies the archive by expanding it with `ditto -x -k` into a temp directory under `desktop/dist/` and asserting: the expansion holds exactly one top-level `dsh-desktop.app` entry, the runtime entry file exists, at least one `.pnpm` link inside the expanded runtime is still a symbolic link (the archive-level twin of `injectRuntime`'s materialization assertion), and `codesign --verify` passes on the expanded app, closing the ditto round-trip. The temp expansion is removed on both paths. The final summary prints the artifact path, size, and SHA-256 (`shasum -a 256`) — the anchor the maintainer pastes into the release notes.

### D5: pnpm 11.7 `deploy --prod --legacy` runs a workspace-wide production install

`pnpm deploy --prod --legacy` mutates the root `node_modules/`: it prunes devDependencies and then runs lifecycle scripts (including the root postinstall, which imports `lefthook/package.json` — a devDependency — and crashes). The `desktop:runtime` script passes `--config.ignore-scripts=true` on the deploy to suppress lifecycle execution, then runs `CI=true pnpm install` to restore the full workspace. `install-lefthook.mjs` guards its dynamic import of the lefthook package with an `ERR_MODULE_NOT_FOUND` catch: in a production tree with no devDependencies, lefthook is absent by design, and there are no hooks to configure, so `main()` returns early. The dist script also sets `CI=true` and `npm_config_verify_deps_before_run=false` on every spawned pnpm command to keep pnpm non-interactive and stop it from "fixing" the modules state that the deploy deliberately rewrote.

## Risks / Trade-offs

- [Unsigned artifact is Gatekeeper-blocked on receivers] → documented first-launch steps (Finder confirm dialog, `xattr -dr com.apple.quarantine`); signing deferred until an Apple Developer ID exists.
- [Unsigned artifact can be swapped in transit] → dist prints the SHA-256 and the documented release flow attaches it beside the zip; receivers verify per the README.
- [All releases depend on one Intel host] → the one-command entry point plus version-tagged names keep the process re-runnable and traceable; a CI follow-up is blocked on Intel-runner availability, not on this design.
- [Cargo manifest parsing is textual] → the parser only reads the `[package]` block's `version` and fails loud when the expected key is missing; a workspace-section reorganization of that file surfaces as a build failure, not a silent wrong version.

## Migration Plan

Additive: new script, one `package.json` entry, README sections. Nothing existing changes behavior; "rollback" is not running `desktop:dist`.

## Open Questions

None. Release tags use the `desktop-v<version>` prefix (e.g. `desktop-v0.1.0`), keeping the desktop tag space separate from the npm release series; the README example pins this.
