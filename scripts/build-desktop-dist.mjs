/**
 * Produce the distributable dsh desktop artifact: run the desktop build chain
 * and package the re-signed .app into a versioned, arch-tagged DMG.
 *
 * Chain: entry gates → `pnpm run build` → `pnpm run desktop:runtime` →
 * `pnpm run desktop:build` → hdiutil DMG. Each package script is spawned
 * through pnpm so its env prefix stays with its owner (`desktop:build` carries
 * its own `npm_config_verify_deps_before_run=false`).
 *
 * The DMG is cut with `hdiutil create` from a staging folder that includes an
 * `/Applications` symlink for drag-and-drop installation. Tauri's own bundling
 * runs before the runtime injection and the re-sign, so the .app is taken
 * post-injection and post-re-sign. The contract is
 * `openspec/changes/add-desktop-dist/` (spec `desktop-dist`).
 *
 * Usage: `node scripts/build-desktop-dist.mjs [--skip-build]`; `--skip-build`
 * reuses existing lib/ artifacts without re-running `pnpm run build`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
// x64 is the only validated target; an unvalidated artifact with a legitimate
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

console.log('[5/6] verifying the .app')
const modules = join(appBundle, 'Contents/Resources/runtime/node_modules')
const pnpmDir = join(modules, '.pnpm')
check(existsSync(join(appBundle, runtimeEntryRel)), `runtime entry missing: ${runtimeEntryRel}`)
check(existsSync(pnpmDir), 'no .pnpm directory under runtime node_modules; the deploy is incomplete')
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
check(foundSymlink, 'no symbolic links found under runtime .pnpm; the deploy dereferenced the pnpm layout')
const signed = spawnSync('codesign', ['--verify', appBundle], { stdio: 'ignore' })
check(signed.status === 0, 'codesign --verify failed on the .app')

console.log('[6/6] creating the DMG')
// Stage the .app alongside an /Applications symlink for drag-to-install.
const dmgStaging = mkdtempSync(join(tmpdir(), 'dsh-desktop-dmg-'))
const dmgAppDir = join(dmgStaging, 'dsh-desktop.app')
const dmgAppsLink = join(dmgStaging, 'Applications')
try {
  run('ditto', [appBundle, dmgAppDir])
  symlinkSync('/Applications', dmgAppsLink)
  const dmgPath = join(distDir, `dsh-desktop_${version}_${process.arch}.dmg`)
  run('hdiutil', [
    'create', '-volname', 'dsh-desktop', '-srcfolder', dmgStaging,
    '-ov', '-format', 'UDZO', dmgPath,
  ])
} finally {
  rmSync(dmgStaging, { recursive: true, force: true })
}

const dmgPath = join(distDir, `dsh-desktop_${version}_${process.arch}.dmg`)
const sizeDmg = spawnSync('du', ['-sh', dmgPath], { encoding: 'utf8' })
const checksumDmg = spawnSync('shasum', ['-a', '256', dmgPath], { encoding: 'utf8' })
console.log(`build-desktop-dist: ok → ${dmgPath} (${sizeDmg.stdout.trim().split('\t')[0]})`)
console.log(`sha256: ${checksumDmg.stdout.trim().split(/\s+/)[0]}`)
console.log('unsigned build: receivers bypass Gatekeeper per desktop/README.md#distribution (right-click → Open, or xattr -cr com.apple.quarantine)')