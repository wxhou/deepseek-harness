/**
 * Keyless sidecar e2e: run the SEA executable directly in web mode on an
 * OS-assigned port, assert the stdout handshake line, exercise the announced
 * surface over HTTP (index + one RPC), then SIGTERM and assert a clean exit.
 * No GUI involved, so this runs in CI. Usage: `node desktop/e2e/sidecar-handshake.mjs`.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const sidecar = fileURLToPath(new URL('../bin/dsh-desktop-host', import.meta.url))
const TERM_WAIT_MS = 10_000

/** Fail the run with a named reason. */
function fail(message) {
  console.error(`sidecar-handshake: FAIL: ${message}`)
  process.exit(1)
}

const child = spawn(sidecar, ['web', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] })
const announceLines = []
let url

const readline = createInterface({ input: child.stdout })
const announced = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no handshake line within 30s')), 30_000)
  readline.on('line', (line) => {
    if (!line.startsWith('dsh web: ')) return
    announceLines.push(line)
    if (url === undefined) {
      url = line.slice('dsh web: '.length).trim()
      clearTimeout(timer)
      resolve(url)
    }
  })
  child.on('exit', (code, signal) => reject(new Error(`sidecar exited early (${code ?? signal})`)))
})

try {
  url = await announced
  console.log(`handshake line: ${announceLines[0]}`)

  const index = await fetch(url)
  if (index.status !== 200 || !(await index.text()).includes('DeepSeek')) {
    fail(`index unexpected (HTTP ${index.status})`)
  }

  const rpc = await fetch(`${url}/api/llm.providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'e2e-1', method: 'llm.providers', payload: {} }),
  })
  const envelope = await rpc.json()
  if (rpc.status !== 200 || envelope?.type !== 'server-response' || envelope?.result?.ok !== true) {
    fail(`llm.providers RPC unexpected (HTTP ${rpc.status}): ${JSON.stringify(envelope).slice(0, 300)}`)
  }
  console.log('index + llm.providers: ok')
} catch (error) {
  fail(error.message)
}

child.kill('SIGTERM')
const exited = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), TERM_WAIT_MS)
  child.once('exit', () => { clearTimeout(timer); resolve('exited') })
})
if ((await exited) !== 'exited') {
  fail(`sidecar did not exit within ${TERM_WAIT_MS}ms of SIGTERM`)
}
if (announceLines.length !== 1) {
  fail(`expected exactly one handshake line, saw ${announceLines.length}`)
}
console.log('sidecar-handshake: ok')
