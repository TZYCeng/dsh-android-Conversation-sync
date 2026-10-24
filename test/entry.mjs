/**
 * Load the plugin entry the way the DSH kernel does: import `index.js`, hand it
 * a context with `effect` / `inject` / `logger`, then exercise the two routes it
 * registers on `connection.fetch`.
 *
 * Usage: node test/test-entry.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-sync-entry-'))
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
process.env.DSH_HOME = home
// Let the kernel pick a free port so this never collides with a live listener.
fs.mkdirSync(path.join(home, 'dsh-mobile-sync'), { recursive: true })
fs.writeFileSync(
  path.join(home, 'dsh-mobile-sync', 'state.json'),
  JSON.stringify({ token: 'f'.repeat(32), port: 18733, preferred: null, log: [], imported: {} }),
)

const plugin = await import('../index.js')
assert.equal(plugin.name, 'dsh-mobile-sync')
assert.equal(typeof plugin.apply, 'function')
console.log('ok  entry exports name/apply')

/* ---------------------------------------------------------------- fake ctx */

const disposers = []
const routes = []
const warnings = []

const ctx = {
  logger: {
    info: () => {},
    warn: message => warnings.push(String(message)),
    error: message => warnings.push(String(message)),
  },
  effect(fn, label) {
    const off = fn()
    disposers.push({ label, off })
  },
  inject(names, callback) {
    assert.deepEqual([...names], ['connection'])
    const scope = {
      connection: {
        fetch: {
          register(options) {
            routes.push(options)
            return () => {}
          },
        },
      },
      effect(fn, label) {
        const off = fn()
        disposers.push({ label, off })
      },
    }
    callback(scope)
  },
}

plugin.apply(ctx)
assert.deepEqual(
  routes.map(route => route.path),
  ['/api/dsh-mobile-sync/status', '/api/dsh-mobile-sync/action'],
)
assert.equal(routes[0].methods[0], 'GET')
assert.equal(routes[1].methods[0], 'POST')
assert.equal(routes[0].requestBody, 'buffered')
console.log('ok  registers the status and action routes')

/* ------------------------------------------------------------ let it bind */

const statusRoute = routes.find(route => route.path.endsWith('/status'))
const actionRoute = routes.find(route => route.path.endsWith('/action'))

// The listener starts asynchronously; wait for it to report itself running.
let status
for (let attempt = 0; attempt < 100; attempt += 1) {
  status = await (await statusRoute.fetch(new Request('http://x/api/dsh-mobile-sync/status'))).json()
  if (status.running) break
  await new Promise(resolve => setTimeout(resolve, 50))
}
assert.equal(status.running, true, 'the LAN listener should start')
assert.equal(status.port, 18733)
assert.equal(status.token, 'f'.repeat(32))
assert.match(status.command, /^curl -fsSL 'http:\/\/[^']+\/join\.sh\?t=f{32}' \| sh -s pair$/)
assert.match(status.qr, /^<svg /)
assert.equal(status.total, 0)
assert.equal(status.request, null, 'no sync request before the button is pressed')
assert.ok(Array.isArray(status.workspaces?.desktop), 'the panel gets both workspace lists')
console.log(`ok  status answers over the connection channel (port ${status.port})`)

/* --------------------------------------------------------------- actions */

const act = async body => {
  const response = await actionRoute.fetch(
    new Request('http://x/api/dsh-mobile-sync/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}

const unknown = await act({ action: 'nope' })
assert.equal(unknown.status, 400)
assert.match(unknown.body.error, /unknown action/)

const noAction = await act({})
assert.equal(noAction.status, 400)

const rescanned = await act({ action: 'rescan' })
assert.equal(rescanned.status, 200)
assert.equal(rescanned.body.running, true)

const cleared = await act({ action: 'clear-log' })
assert.equal(cleared.status, 200)
assert.deepEqual(cleared.body.log, [])

const reset = await act({ action: 'reset-token' })
assert.equal(reset.status, 200)
assert.match(reset.body.token, /^[a-f0-9]{32}$/)
assert.notEqual(reset.body.token, 'f'.repeat(32))
assert.match(reset.body.command, new RegExp(reset.body.token))
console.log('ok  action route rejects nonsense and handles rescan/clear-log/reset-token')

// The manual sync button: arm a request, the phone takes it, then reports done.
const armed = await act({ action: 'request-sync' })
assert.equal(armed.status, 200)
assert.match(armed.body.request.id, /^[a-f0-9]{8}$/)
assert.equal(armed.body.request.status, 'pending')

const workspaceId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const mapped = await act({ action: 'set-workspace-map', desktop: workspaceId, phone: 'phone-ws-1' })
assert.equal(mapped.status, 200)
assert.deepEqual(mapped.body.sync.workspaceMap, { [workspaceId]: 'phone-ws-1' }, 'the pairing is persisted')
const unmapped = await act({ action: 'set-workspace-map', desktop: workspaceId, phone: '' })
assert.deepEqual(unmapped.body.sync.workspaceMap, {}, 'an empty phone id restores match-by-title')
await act({ action: 'set-workspace-map', desktop: workspaceId, phone: 'phone-ws-2' })
const clearedMap = await act({ action: 'reset-workspace-map' })
assert.deepEqual(clearedMap.body.sync.workspaceMap, {}, 'reset clears every pairing')
await act({ action: 'set-workspace-map', desktop: workspaceId, phone: 'phone-ws-3' })

const cancelled = await act({ action: 'cancel-sync' })
assert.equal(cancelled.body.request, null, 'the cancel button drops an untaken request')
console.log('ok  the sync request and the workspace pairing round-trip through the action route')

// Per-group key switches: the panel can hold one group's key back without
// touching that group's model switch.
const keyOff = await act({ action: 'set-key', name: 'llm-pi-ai/grok', on: false })
assert.equal(keyOff.status, 200)
assert.equal(keyOff.body.sync.modelKeys['llm-pi-ai/grok'], false, 'set-key persists per group')
const modelStillOn = await act({ action: 'set-model', name: 'llm-pi-ai/grok', on: true })
assert.equal(modelStillOn.body.sync.modelKeys['llm-pi-ai/grok'], false, 'the model switch does not touch the key switch')
const keysOff = await act({ action: 'set-keys-all', on: false })
assert.equal(keysOff.status, 200)
const keysOn = await act({ action: 'set-keys-all', on: true })
assert.equal(keysOn.status, 200)
console.log('ok  set-key and set-keys-all are persisted')

const restarted = await act({ action: 'restart', port: 18744 })
assert.equal(restarted.status, 200)
assert.equal(restarted.body.port, 18744)
assert.equal(restarted.body.running, true)
console.log('ok  restart moves the listener')

/* -------------------------------------------------------------- teardown */

for (const item of disposers) {
  if (typeof item.off === 'function') item.off()
}
await new Promise(resolve => setTimeout(resolve, 150))
const after = await (await statusRoute.fetch(new Request('http://x/api/dsh-mobile-sync/status'))).json()
assert.equal(after.running, false, 'disposing the plugin must stop the listener')
console.log('ok  teardown stops the listener')

assert.deepEqual(warnings, [], 'no warnings on the happy path')

fs.rmSync(home, { recursive: true, force: true })
console.log('\nALL ENTRY CHECKS PASSED')
