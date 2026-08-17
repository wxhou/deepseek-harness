/**
 * Build the dsh desktop sidecar: a Node Single Executable Application whose
 * embedded CJS launcher imports the CLI's ESM bundle in place
 * (`apps/cli/lib/bin.js`).
 *
 * Why a launcher: Node's SEA runs the embedded main as CommonJS on the
 * supported engine range, so an ESM bundle cannot be embedded directly; a
 * CJS launcher that `import()`s the bundle keeps it untouched. The bundle
 * stays at its build location because its bare-specifier resolution (the
 * Loader's runtime plugin imports) is anchored to its own directory's
 * node_modules walk — the sidecar needs the repo checkout at runtime anyway.
 *
 * Chain: repo `build:lib` → copy Node binary → SEA config → postject
 * injection → ad-hoc codesign → smoke-verify `--help` with no `node` on PATH.
 * macOS only in the MVP; the Linux port additionally ships native addons
 * beside the executable (see design D1).
 *
 * Usage: `node scripts/build-desktop-sidecar.mjs [--no-build]`; `--no-build`
 * reuses the existing `apps/cli/lib/bin.js` without re-running `build:lib`.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inject as postjectInject } from 'postject'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliEntry = join(repoRoot, 'apps/cli/lib/bin.js')
const buildDir = join(repoRoot, 'desktop/build')
const launcherPath = join(buildDir, 'launcher.cjs')
const seaConfigPath = join(buildDir, 'sea-config.json')
const blobPath = join(buildDir, 'sea-prep.blob')
const sidecarPath = join(repoRoot, 'desktop/bin/dsh-desktop-host')

/** Fail the build with a named reason. */
function fail(message) {
  console.error(`build-desktop-sidecar: ${message}`)
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

if (process.platform !== 'darwin') fail('desktop sidecar MVP targets darwin only')

if (!process.argv.includes('--no-build')) {
  console.log('[1/5] building workspace libraries (build:lib)')
  run('pnpm', ['run', 'build:lib'], { cwd: repoRoot })
} else {
  console.log('[1/5] --no-build: skipping build:lib')
}
if (!existsSync(cliEntry)) fail(`missing ${cliEntry} after build; run \`pnpm run build:lib\` first`)

console.log('[2/5] writing SEA config (CJS launcher importing the ESM bundle)')
mkdirSync(buildDir, { recursive: true })
rmSync(blobPath, { force: true })
writeFileSync(launcherPath, `const { join } = require('node:path')
// The shell passes the resolved bundle path (dev or bundled) as
// DSH_DESKTOP_BUNDLE; the repo layout is the fallback for direct runs.
const bundle = process.env.DSH_DESKTOP_BUNDLE ?? join(__dirname, '../../apps/cli/lib/bin.js')
import(bundle).catch((error) => {
  console.error('dsh-desktop-host: failed to load the CLI bundle:', error)
  process.exit(1)
})
`)
writeFileSync(seaConfigPath, `${JSON.stringify({
  main: launcherPath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2)}\n`)
run(process.execPath, ['--experimental-sea-config', seaConfigPath], { cwd: repoRoot })

console.log('[3/5] copying Node binary')
mkdirSync(join(repoRoot, 'desktop/bin'), { recursive: true })
rmSync(sidecarPath, { force: true })
copyFileSync(process.execPath, sidecarPath)

console.log('[4/5] injecting SEA blob (macOS segment NODE_SEA) + ad-hoc codesign')
// A previously-signed copy fails postject; an unsigned one fails codesign's
// remove — both are expected pre-states, so the remove's exit code is noise.
spawnSync('codesign', ['--remove-signature', sidecarPath], { stdio: 'ignore' })
await postjectInject(sidecarPath, 'NODE_SEA_BLOB', readFileSync(blobPath), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: 'NODE_SEA',
})
run('codesign', ['-s', '-', sidecarPath])
// The ad-hoc signature is load-bearing on macOS: an unsigned copy is killed
// at exec, so a missing signature fails the build here, not at launch.
const signed = spawnSync('codesign', ['-v', sidecarPath], { stdio: 'ignore' })
if (signed.status !== 0) fail('sidecar is not signed after codesign')

console.log('[5/5] verifying the executable answers --help without node on PATH')
const smoke = spawnSync(sidecarPath, ['--help'], {
  env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
  encoding: 'utf8',
})
// `Usage: dsh` distinguishes the embedded CLI from a bare node copy, whose
// own --help also contains the word "Usage".
if (smoke.status !== 0 || !smoke.stdout.includes('Usage: dsh')) {
  fail(`sidecar smoke check failed (exit ${smoke.status}); stdout: ${smoke.stdout?.slice(0, 400)}`)
}
console.log(`build-desktop-sidecar: ok → ${sidecarPath}`)
