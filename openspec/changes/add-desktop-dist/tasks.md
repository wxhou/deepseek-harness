## 1. Dist orchestrator script

- [x] 1.1 Create `scripts/build-desktop-dist.mjs` with entry gates: parse `desktop/src-tauri/tauri.conf.json` (`JSON.parse`) and the `[package]` version from `desktop/src-tauri/Cargo.toml`, fail loud naming both values on disagreement and fail loud when either version is unreadable (no defaulting); reject hosts whose `process.arch` is not `x64` with a diagnostic naming the reported architecture; clear `desktop/dist/` at entry
- [x] 1.2 Chain the package scripts as subprocesses: `pnpm run build` → `pnpm run desktop:runtime` → `pnpm run desktop:build` (spawn via `pnpm run` so the `desktop:build` script's `npm_config_verify_deps_before_run=false` env prefix travels with its owner); support `--skip-build` to reuse an existing `lib/`, with usage text stating the precondition
- [x] 1.3 Add the packaging step: `ditto -c -k --keepParent` the re-signed `.app` into `desktop/dist/dsh-desktop_<version>_<process.arch>.zip`
- [x] 1.4 Add archive verification: expand with `ditto -x -k` into a temp dir under `desktop/dist/`, assert the expansion holds exactly one top-level `dsh-desktop.app` entry, the runtime entry file exists, the `.pnpm` directory exists inside the expanded runtime `node_modules`, at least one symlink inside `.pnpm/*/node_modules/` is still symbolic (pnpm's `deploy --prod --legacy` layout stores packages as directories at the top level; the self-referential links live inside `.pnpm`), and `codesign --verify` passes on the expanded app; remove the temp expansion on success and failure
- [x] 1.5 Print a final summary: artifact path, size, SHA-256 (`shasum -a 256`), and the unsigned-build notice for receivers

## 2. Wiring and documentation

- [x] 2.1 Add the `desktop:dist` script to root `package.json`
- [x] 2.2 Add a Distribution section to `desktop/README.md` and `desktop/README.zh.md`: prerequisites, the one command, attaching the artifact and its SHA-256 to a GitHub Release with `gh release create desktop-v<version>`, the receiver-side checksum verification command, and the Gatekeeper first-launch steps; rewrite the "No distribution" Known Limitations entry in both languages (unsigned zip distribution exists; signing/notarization/auto-update still missing)
- [x] 2.3 Write the Agent Note recording the three packaging traps (tauri bundles before runtime injection; `zip -r` dereferences the pnpm symlink layout; pnpm 11.7 `deploy --prod --legacy` runs a workspace-wide production install that destroys root state) and the strict-JSON parse boundary of `tauri.conf.json` (a future JSONC edit must move to tolerant parsing, not silent misparse)

## 3. Verification

- [x] 3.1 Run `pnpm run desktop:dist` from the current clean state on this machine; confirm the `.app` and versioned zip exist and the summary's SHA-256 matches an independent `shasum -a 256`
- [x] 3.2 Temporarily change one of the two version records, rerun, confirm the build fails with both values named; restore the version
- [x] 3.3 Rerun `desktop:dist` after a successful build; confirm it succeeds, replaces the artifacts, and `desktop/dist/` holds no file from the earlier run
- [x] 3.4 Expand the produced zip to a scratch directory; with the repo checkout unreachable from the shell's resolution order (per the README's repo-first rule), confirm the expanded `.app` launches standalone — runtime entry exists, `.pnpm` links are still symbolic, `codesign --verify` passes
- [x] 3.5 Negative-test the architecture gate with a non-x64 value; confirm it fails with the diagnostic naming the architecture and that no build step ran
- [x] 3.6 Run the pre-push checks selected by [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md) for this diff and report the commands run
