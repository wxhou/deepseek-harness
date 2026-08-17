/**
 * Assemble the dsh desktop .app: run the sidecar build, run `tauri build`
 * with a clean environment (a pnpm-run parent pollutes nested `pnpm exec`
 * through npm_lifecycle_event), then inject the deployed runtime into the
 * bundle with ditto — which preserves the pnpm symlink layout tauri's
 * resource copier may not — and verify the result.
 *
 * Prerequisite: `pnpm run desktop:runtime` has produced `desktop/runtime-dist`.
 * Usage: `node scripts/build-desktop-app.mjs`.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const srcTauri = join(repoRoot, 'desktop/src-tauri')
const runtimeDist = join(repoRoot, 'desktop/runtime-dist')
const appBundle = join(
  repoRoot,
  'desktop/src-tauri/target/release/bundle/macos/dsh-desktop.app',
)
const runtimeDest = join(appBundle, 'Contents/Resources/runtime')
const runtimeEntry = join(runtimeDest, 'node_modules/@deepseek-ai/dsh/lib/bin.js')

/** Fail the build with a named reason. */
function fail(message) {
  console.error(`build-desktop-app: ${message}`)
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

if (!existsSync(runtimeDist)) {
  fail('desktop/runtime-dist is missing; run `pnpm run desktop:runtime` first')
}

console.log('[1/4] building the sidecar')
run(process.execPath, [join(repoRoot, 'scripts/build-desktop-sidecar.mjs'), '--no-build'], {
  cwd: repoRoot,
})

console.log('[2/4] tauri build')
// npm_* lifecycle variables from a `pnpm run` parent break nested tooling;
// keep PATH/HOME and drop the rest.
const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME }
run(join(repoRoot, 'node_modules/.bin/tauri'), ['build'], {
  cwd: srcTauri,
  env: cleanEnv,
})

/**
 * Copy the deployed runtime into the bundle and materialize every symlink
 * whose target escapes the runtime tree (pnpm links workspace members and
 * `link:` overrides back to the repo source, which dangles on another
 * machine). Self-referential `.pnpm` links stay symbolic, preserving the
 * store's deduplication. Each escaping link is replaced by a dereferenced
 * copy that excludes the target's own node_modules, the same cycle break
 * `build-exe-for-python-sdk.ts` uses.
 * @param {string} source - the deployed runtime directory.
 * @param {string} destination - the bundle resource directory to create.
 */
function injectRuntime(source, destination) {
  rmSync(destination, { recursive: true, force: true })
  // verbatimSymlinks keeps relative targets as written; without it node
  // resolves every link to an absolute path inside the deploy tree, which
  // dangles on any other machine.
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true })
  const queue = [destination]
  let materialized = 0
  while (queue.length > 0) {
    const dir = queue.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(path)
        continue
      }
      if (!entry.isSymbolicLink()) continue
      // Resolve the same link under the source tree, where nothing dangles;
      // the copy's identical relative target resolves to the same place.
      const sourcePath = join(source, relative(destination, path))
      const resolved = realpathSync(sourcePath)
      const rel = relative(source, resolved)
      const insideSource = rel !== '' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      if (insideSource) continue
      rmSync(path, { force: true })
      const nestedNodeModules = join(resolved, 'node_modules')
      cpSync(resolved, path, {
        recursive: true,
        dereference: true,
        filter: (candidate) => candidate !== nestedNodeModules
          && !candidate.startsWith(nestedNodeModules + sep),
      })
      materialized += 1
    }
  }
  if (materialized === 0) {
    fail('no escaping symlinks were materialized — the deploy layout changed; re-inspect')
  }
  console.log(`injected runtime (${materialized} workspace links materialized)`)
}

console.log('[3/4] injecting the runtime (materializing escaping links)')
injectRuntime(runtimeDist, runtimeDest)

console.log('[4/5] re-signing the bundle (injection invalidated tauri\'s signature)')
run('codesign', ['--force', '--deep', '--sign', '-', appBundle])

console.log('[5/5] verifying')
if (!existsSync(runtimeEntry)) {
  fail(`runtime entry missing after injection: ${runtimeEntry}`)
}
const signed = spawnSync('codesign', ['--verify', appBundle], { stdio: 'ignore' })
if (signed.status !== 0) {
  fail('bundle signature invalid after re-signing')
}
const size = spawnSync('du', ['-sh', appBundle], { encoding: 'utf8' })
console.log(`build-desktop-app: ok → ${appBundle} (${size.stdout.trim().split('\t')[0]})`)
