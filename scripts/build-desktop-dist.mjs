/**
 * Produce the distributable dsh desktop artifact: run the desktop build chain
 * and package the re-signed .app into a versioned, arch-tagged zip.
 *
 * Chain: entry gates → `pnpm run build` → `pnpm run desktop:runtime` →
 * `pnpm run desktop:build` → ditto zip → expand-and-verify. Each package
 * script is spawned through pnpm so its env prefix stays with its owner
 * (`desktop:build` carries its own `npm_config_verify_deps_before_run=false`).
 *
 * The zip is cut from the re-signed .app with `ditto -c -k --keepParent`:
 * tauri's own bundling runs before the runtime injection and the re-sign, and
 * plain `zip -r` dereferences the pnpm symlink layout inside the runtime
 * tree. The contract is `openspec/changes/add-desktop-dist/` (spec
 * `desktop-dist`).
 *
 * Usage: `node scripts/build-desktop-dist.mjs [--skip-build]`; `--skip-build`
 * reuses existing lib/ artifacts without re-running `pnpm run build`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const tauriConfigPath = join(repoRoot, 'desktop/src-tauri/tauri.conf.json')
const cargoTomlPath = join(repoRoot, 'desktop/src-tauri/Cargo.toml')
const distDir = join(repoRoot, 'desktop/dist')
const appBundle = join(repoRoot, 'desktop/src-tauri/target/release/bundle/macos/dsh-desktop.app')
const runtimeEntryRel = 'Contents/Resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'
const cliLibEntry = join(repoRoot, 'apps/cli/lib/bin.js')

/** Fail the build with a named reason. */
function fail(message) {
  console.error(`build-desktop-dist: ${message}`)
  process.exit(1)
}

/**
 * Run one command inheriting stdio; non-zero exit fails the build.
 * @param {string} command - executable to run.
 * @param {string[]} args - command arguments.
 * @param {import('node:child_process').SpawnSyncOptions} options - spawn options.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) fail(`command failed (${command} ${args.join(' ')})`)
}

/**
 * Throw when a verification assertion fails; the caller cleans up before
 * exiting, which a direct fail() here would skip.
 * @param {boolean} ok - the asserted condition.
 * @param {string} message - the failure reason to report.
 */
function check(ok, message) {
  if (!ok) throw new Error(message)
}

/** The desktop version tauri.conf.json records; strict JSON, no defaulting. */
function tauriVersion() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(tauriConfigPath, 'utf8'))
  } catch (error) {
    fail(`cannot parse ${tauriConfigPath} as strict JSON (${error.message}); a commented (JSONC) edit needs tolerant parsing, not a fallback here`)
  }
  check(typeof parsed.version === 'string' && parsed.version !== '', `no string "version" in ${tauriConfigPath}`)
  return parsed.version
}

/** The desktop version Cargo.toml records, from its [package] block only. */
function cargoVersion() {
  let inPackage = false
  for (const line of readFileSync(cargoTomlPath, 'utf8').split('\n')) {
    if (line.startsWith('[')) {
      inPackage = line.trim() === '[package]'
    } else if (inPackage) {
      const match = /^version\s*=\s*"([^"]+)"/.exec(line)
      if (match) return match[1]
    }
  }
  fail(`no [package] version key in ${cargoTomlPath}`)
}

console.log('[1/6] entry gates')
const version = tauriVersion()
const cargo = cargoVersion()
if (version !== cargo) {
  fail(`desktop version mismatch: tauri.conf.json says "${version}", Cargo.toml says "${cargo}"`)
}
// x64 is the only validated target; an unvalidated zip with a legitimate
// name on a Release is the failure path this gate closes. A Rosetta host
// reports x64, which is self-consistent: the toolchain that runs builds.
if (process.arch !== 'x64') {
  fail(`host architecture ${process.arch} is not the validated x64 target; refusing to produce an unvalidated artifact`)
}
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

const skipBuild = process.argv.includes('--skip-build')
if (skipBuild && !existsSync(cliLibEntry)) {
  fail(`--skip-build requires built lib/ artifacts; ${cliLibEntry} is missing — run without the flag`)
}

console.log('[2/6] building workspace libraries')
// CI keeps every nested pnpm non-interactive (a purge confirmation aborts
// without a TTY), and the disabled deps-status pre-check stops pnpm from
// "fixing" the modules state a previous deploy deliberately rewrote — the
// same quirk the desktop:build script carries for its own children.
const pnpmEnv = {
  ...process.env,
  CI: 'true',
  npm_config_verify_deps_before_run: 'false',
}
if (skipBuild) console.log('skipping pnpm run build (--skip-build)')
else run('pnpm', ['run', 'build'], { cwd: repoRoot, env: pnpmEnv })

console.log('[3/6] deploying the runtime')
run('pnpm', ['run', 'desktop:runtime'], { cwd: repoRoot, env: pnpmEnv })

console.log('[4/6] assembling the .app')
run('pnpm', ['run', 'desktop:build'], { cwd: repoRoot, env: pnpmEnv })

console.log('[5/6] zipping the re-signed .app')
const zipPath = join(distDir, `dsh-desktop_${version}_${process.arch}.zip`)
run('ditto', ['-c', '-k', '--keepParent', appBundle, zipPath])

console.log('[6/6] verifying the archive')
const expandDir = join(distDir, 'verify-expand')
let verifyError
try {
  const expand = spawnSync('ditto', ['-x', '-k', zipPath, expandDir])
  check(expand.status === 0, `archive expansion failed (ditto -x exited ${expand.status})`)
  const expanded = readdirSync(expandDir, { withFileTypes: true })
  check(
    expanded.length === 1 && expanded[0].name === 'dsh-desktop.app' && expanded[0].isDirectory(),
    `archive holds unexpected top-level entries: ${expanded.map(entry => entry.name).join(', ')}`,
  )
  const expandedApp = join(expandDir, 'dsh-desktop.app')
  check(existsSync(join(expandedApp, runtimeEntryRel)), `runtime entry missing in the expanded archive: ${runtimeEntryRel}`)
  const modules = join(expandedApp, 'Contents/Resources/runtime/node_modules')
  const pnpmDir = join(modules, '.pnpm')
  // pnpm's deploy --prod --legacy layout stores packages directly under
  // @scope/name (directories, not symlinks) and keeps self-referential links
  // inside .pnpm/<hash>/node_modules/. Top-level isSymbolicLink would miss
  // them; check inside .pnpm instead.
  check(existsSync(pnpmDir), 'no .pnpm directory under the expanded runtime node_modules; the archive is missing the pnpm store')
  let foundSymlink = false
  for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const innerModules = join(pnpmDir, entry.name, 'node_modules')
    if (!existsSync(innerModules)) continue
    for (const inner of readdirSync(innerModules, { withFileTypes: true })) {
      if (inner.isSymbolicLink()) { foundSymlink = true; break }
    }
    if (foundSymlink) break
  }
  check(foundSymlink, 'no symbolic links found under the expanded runtime .pnpm; the archive dereferenced the pnpm layout')
  const signed = spawnSync('codesign', ['--verify', expandedApp], { stdio: 'ignore' })
  check(signed.status === 0, 'codesign --verify failed on the expanded app')
} catch (error) {
  verifyError = error
} finally {
  rmSync(expandDir, { recursive: true, force: true })
}
if (verifyError !== undefined) fail(verifyError.message)

const size = spawnSync('du', ['-sh', zipPath], { encoding: 'utf8' })
const checksum = spawnSync('shasum', ['-a', '256', zipPath], { encoding: 'utf8' })
console.log(`build-desktop-dist: ok → ${zipPath} (${size.stdout.trim().split('\t')[0]})`)
console.log(`sha256: ${checksum.stdout.trim().split(/\s+/)[0]}`)
console.log('unsigned build: receivers bypass Gatekeeper per desktop/README.md#distribution (right-click → Open, or xattr -dr com.apple.quarantine)')
