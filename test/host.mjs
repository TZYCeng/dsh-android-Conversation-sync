/**
 * End-to-end exercise of the host half without DSH: a temp home, a fake session
 * store seeded from a real desktop log, a real workspace index, and the plugin's
 * own HTTP listener.
 *
 * The sync semantics this checks are the ones a user actually feels: a pull
 * rewrites a session's `cwd` to the phone's directory and registers it in the
 * phone's index; a push folds the phone's copy back into a desktop workspace,
 * moving the log so its directory and header still agree; and repeating either
 * one changes nothing.
 *
 * Usage: node test/host.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { createController } from '../lib/controller.js'
import { pack, unpack } from '../lib/tar.js'
import { frameOffsets, scan, verifyLog } from '../lib/sessions.js'
import { readIndex } from '../lib/index-sync.js'
import { slugOf } from '../lib/slug.js'

const REAL_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

/** Fetch helper that never follows redirects and always returns bytes. */
async function request(url, init) {
  const response = await fetch(url, { redirect: 'error', ...init })
  const buffer = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, body: buffer, text: () => buffer.toString('utf8') }
}

/** Pick one real session log to move around.
 *
 * Delegated (subagent) transcripts are deliberately never synced, so the seed
 * has to be a session a user actually opened — otherwise this suite would be
 * asserting against a log the planner is right to skip.
 */
function seedRealLog() {
  const candidates = scan(REAL_ROOT).filter(entry => entry.origin !== 'subagent')
  if (candidates.length === 0) throw new Error('no real user session logs on this machine to test with')
  return candidates[0]
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-sync-test-'))
const home = path.join(work, 'home')
const sessions = path.join(home, 'sessions')
const agentsHome = path.join(work, 'agents')
fs.mkdirSync(sessions, { recursive: true })
fs.mkdirSync(agentsHome, { recursive: true })

// --- a desktop session, copied from a real one so the format is authentic
const seed = seedRealLog()
const desktopDir = path.join(sessions, seed.project, seed.dir)
fs.mkdirSync(desktopDir, { recursive: true })
fs.copyFileSync(path.join(REAL_ROOT, seed.project, seed.dir, seed.file), path.join(desktopDir, seed.file))
console.log(`seeded desktop session: ${seed.project}/${seed.dir} (${seed.bytes} bytes, title=${JSON.stringify(seed.title)})`)

// --- a desktop workspace index: without this a session is on disk but invisible
const desktopPath = path.join(work, 'demo-project')
const workspaceId = '11111111-1111-4111-8111-111111111111'
const indexFile = path.join(home, 'storages', 'workspace.json')
fs.mkdirSync(path.dirname(indexFile), { recursive: true })
fs.writeFileSync(
  indexFile,
  `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: workspaceId,
      workspaceIds: [workspaceId],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        [workspaceId]: {
          path: desktopPath,
          title: 'demo',
          sessionIds: [seed.id],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    },
  }, null, 2)}\n`,
)

const controller = createController({
  home,
  sessionsRoot: sessions,
  logger: console,
  deviceName: 'TEST-DESKTOP',
  agentsHome,
})
const live = await controller.start('127.0.0.1')
assert.equal(live.running, true, 'listener should be running')
const base = `http://127.0.0.1:${live.port}`
const token = controller.status().token
console.log(`listening on ${base}, token=${token.slice(0, 6)}…`)

// Keep every path this suite invents inside the temp work dir.
await controller.act({ action: 'set-root', which: 'desktop', value: path.join(work, 'desk') })
await controller.act({ action: 'set-root', which: 'phone', value: '/storage/emulated/0/DSH' })

// Workspace pairing is a per-workspace switch now (the「同步对话」box), so the
// suite has to tick its own project before anything is expected to travel.
const tickDemo = { action: 'set-workspace', id: workspaceId, on: true }
assert.equal((await controller.act(tickDemo)).status, 200)
assert.equal(controller.status().workspaces.desktop.find(item => item.id === workspaceId).selected, true)
console.log('ok  a workspace only syncs once its own switch is on')

// --- auth
const unauthorized = await request(`${base}/api/ping`)
assert.equal(unauthorized.status, 401)
console.log('ok  unauthenticated /api/ping rejected')

const gate = await request(`${base}/`)
assert.equal(gate.status, 200)
assert.match(gate.text(), /配对令牌/)
console.log('ok  page without token asks for one')

// --- the header token works too, and the query form still does
const viaHeader = await request(`${base}/api/ping`, { headers: { 'X-DSH-Sync-Token': token } })
assert.equal(viaHeader.status, 200)
console.log('ok  X-DSH-Sync-Token header authenticates')

// --- ping
const ping = await request(`${base}/api/ping?t=${token}&device=Pixel`)
assert.equal(ping.status, 200)
const pong = JSON.parse(ping.text())
assert.equal(pong.desktop, 'TEST-DESKTOP')
assert.equal(pong.sessions, 1)
console.log(`ok  ping -> ${JSON.stringify(pong)}`)

// --- manifest: the one document the phone parses, plain key=value
const manifest = await request(`${base}/api/manifest`, { headers: { 'X-DSH-Sync-Token': token } })
assert.equal(manifest.status, 200)
const wants = Object.fromEntries(
  manifest.text().trim().split('\n').map((line) => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)]
  }),
)
assert.equal(wants.sessions, '1')
assert.equal(wants.plugins, '1')
assert.equal(wants.skills, '1')
assert.equal(wants.models, '0', 'the models channel is off by default')
assert.equal(wants.secrets, '1', 'keys ride along with the model groups (master switch on by default)')
assert.equal(wants.profile, '0', 'this temp home has no profile, so plugins cannot register')
console.log(`ok  manifest -> ${JSON.stringify(wants)}`)

// --- control page + qr
const page = await request(`${base}/j?t=${token}`)
assert.equal(page.status, 200)
assert.match(page.text(), /<svg/, 'page should carry an inline QR')
assert.match(page.text(), /join\.sh\?t=/, 'page should carry the pairing command')
console.log('ok  control page renders with an inline QR')

// --- join.sh
const join = await request(`${base}/join.sh?t=${token}&device=Pixel`)
assert.equal(join.status, 200)
const script = join.text()
const lanBase = controller.status().urls[0]
assert.match(script, /^#!\/bin\/sh/)
assert.ok(script.includes(`'${lanBase}'`), 'script should carry the LAN base url')
assert.ok(script.includes(`'${token}'`), 'script should carry the token')
assert.ok(!script.includes('__TOKEN__'), 'placeholders must be substituted')
fs.writeFileSync(path.join(work, 'join.sh'), script)
console.log(`ok  join.sh rendered (${script.length} bytes)`)

// --- pull
const pull = await request(`${base}/api/pull?t=${token}`, { method: 'POST' })
assert.equal(pull.status, 200)
assert.equal(pull.headers.get('content-type'), 'application/gzip')
const pulled = unpack(pull.body)
const pulledSessions = pulled.entries.filter((entry) => entry.relative.startsWith('sessions/'))
const pulledIndex = pulled.entries.find((entry) => entry.relative === '_meta/index.json')
assert.equal(pulledSessions.length, 1, 'one indexed session travels')
assert.ok(pulledIndex !== undefined, 'the phone index travels with it')

// The mirror has to claim the phone's directory, or resuming it there breaks.
const phonePath = '/storage/emulated/0/DSH/demo'
const phoneSlug = slugOf(phonePath)
assert.equal(pulledSessions[0].relative, `sessions/${phoneSlug}/${seed.id}/${seed.file}`)
const mirrored = verifyLog(pulledSessions[0].data)
assert.equal(mirrored.cwd, phonePath, 'the header now points at the phone directory')

const phoneIndex = JSON.parse(pulledIndex.data.toString('utf8'))
const phoneWorkspace = Object.values(phoneIndex.tables.workspaces).find((item) => item.path === phonePath)
assert.ok(phoneWorkspace !== undefined, 'the phone index gains the mapped workspace')
assert.deepEqual(phoneWorkspace.sessionIds, [seed.id], 'and lists the session it just received')
assert.equal(phoneIndex.global.defaultWorkspaceId, Object.keys(phoneIndex.tables.workspaces)[0], 'a default workspace is set')
console.log(`ok  pull -> ${pulledSessions.length} session under ${phoneSlug}, index registers it`)

// The phone now reports its workspace index; caching it is what lets the panel
// and the planner see the phone's folders. The report names the desktop
// workspace it mirrors, which is what its row shows as "incoming" — and the
// phone side of the project title is what the panel matches.
const mirroredPhoneIndex = JSON.parse(JSON.stringify(phoneIndex))
for (const [phoneWorkspaceId, workspace] of Object.entries(mirroredPhoneIndex.tables.workspaces)) {
  if (workspace.path === phonePath) {
    // The phone's own copy of a mirrored project carries the project title.
    mirroredPhoneIndex.tables.workspaces[phoneWorkspaceId] = { ...workspace, title: 'demo' }
  }
}
const mirroredPhoneWorkspaceId = Object.keys(mirroredPhoneIndex.tables.workspaces)
  .find(id => mirroredPhoneIndex.tables.workspaces[id].path === phonePath)
await request(`${base}/api/push?t=${token}&device=Pixel%209`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/gzip' },
  body: pack([
    { relative: '_meta/phone.env', data: Buffer.from([
      'device=Pixel 9',
      'home=/data/user/0/com.dsharnessmobile.shell/files/home/.dsh',
      'sessions=/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/sessions',
      'profile=/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/profiles/desktop',
      'profileName=desktop',
      '',
    ].join('\n')), mtime: Date.now() },
    { relative: '_meta/index.json', data: Buffer.from(JSON.stringify(mirroredPhoneIndex)), mtime: Date.now() },
  ]),
})
const mirroredStatus = controller.status()
assert.equal(mirroredStatus.workspaces.phoneKnown, true, 'the reported index is cached')
const demoRow = mirroredStatus.workspaces.desktop.find(item => item.id === workspaceId)
assert.ok(demoRow !== undefined && demoRow.selected === true, 'the ticked workspace is listed')
// The desktop row's pairing is what tells the phone row which project feeds it.
const pairDemo = await controller.act({ action: 'set-workspace-map', desktop: workspaceId, phone: mirroredPhoneWorkspaceId })
assert.equal(pairDemo.status, 200)
assert.equal(
  pairDemo.body.workspaces.phone.some(item => item.title === 'demo' && item.incoming.includes('demo')),
  true,
  `the phone folder reports which desktop workspace feeds it: ${JSON.stringify(pairDemo.body.workspaces.phone)}`,
)
const demoPhoneRow = pairDemo.body.workspaces.phone.find(item => item.title === 'demo')
assert.equal(demoPhoneRow?.mapped ?? '', '', 'an implicit desktop→phone pairing is shown only on the desktop row')
assert.deepEqual(
  mirroredStatus.workspaces.phone.map(item => item.id).includes(mirroredPhoneWorkspaceId),
  true,
  'every reported phone workspace is listed',
)
assert.equal(mirroredStatus.workspaces.on, 1, 'and the card counts one ticked workspace')
console.log('ok  the workspace card joins both machines on the ticked project')

// The phone-workspace list is actionable too: a landing choice stored for one
// phone project shows up on that phone row, on its own key.
const otherPhoneId = '0f0f0f0f-1111-4111-8111-0f0f0f0f0f0f'
const otherPhonePath = '/storage/emulated/0/DSH/other'
const otherPhoneIndex = JSON.parse(JSON.stringify(phoneIndex))
otherPhoneIndex.tables.workspaces[otherPhoneId] = {
  path: otherPhonePath,
  title: 'other',
  sessionIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
otherPhoneIndex.global.workspaceIds.push(otherPhoneId)
await request(`${base}/api/push?t=${token}&device=Pixel%209`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/gzip' },
  body: pack([
    { relative: '_meta/index.json', data: Buffer.from(JSON.stringify(otherPhoneIndex)), mtime: Date.now() },
  ]),
})
const landingAction = await controller.act({ action: 'set-phone-workspace-map', phone: otherPhoneId, desktop: workspaceId })
assert.equal(landingAction.status, 200)
const landingRow = landingAction.body.workspaces.phone.find(item => item.id === otherPhoneId)
assert.equal(landingRow.mapped, workspaceId, 'the phone row carries the desktop workspace chosen for it')
assert.equal(
  landingAction.body.sync.workspaceMap[`phone:${otherPhoneId}`],
  workspaceId,
  'and it is persisted under its own key',
)
const badLanding = await controller.act({ action: 'set-phone-workspace-map', phone: otherPhoneId, desktop: 'missing-workspace' })
assert.equal(badLanding.status, 400, 'an unknown desktop workspace is refused')
console.log('ok  a phone workspace can be pointed at a desktop workspace from the panel API')

// --- push: the phone hands back what it received, plus its own metadata
/** Rewrite the header id of a session log, recompressing only its first frame. */
function withId(buffer, id) {
  const offsets = frameOffsets(buffer)
  const firstFrame = zlib.zstdDecompressSync(buffer.subarray(offsets[0], offsets[1])).toString('utf8')
  const swapped = firstFrame.replace(/"id":"[^"]*"/, `"id":"${id}"`)
  assert.notEqual(swapped, firstFrame, 'header id rewrite must change the payload')
  return Buffer.concat([zlib.zstdCompressSync(Buffer.from(swapped)), buffer.subarray(offsets[1])])
}

const phoneEnv = [
  'device=Pixel 9',
  'home=/data/user/0/com.dsharnessmobile.shell/files/home/.dsh',
  'sessions=/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/sessions',
  'profile=/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/profiles/desktop',
  'profileName=desktop',
  '',
].join('\n')

const bundle = pack([
  { relative: `${phoneSlug}/${seed.id}/${seed.file}`, data: pulledSessions[0].data, mtime: Date.now() },
  { relative: '_meta/phone.env', data: Buffer.from(phoneEnv), mtime: Date.now() },
  { relative: '_meta/index.json', data: Buffer.from(JSON.stringify(phoneIndex)), mtime: Date.now() },
  { relative: '_meta/plugins.txt', data: Buffer.from('dsh-demo 1.2.3\n'), mtime: Date.now() },
  { relative: '_meta/skills.txt', data: Buffer.from('desk-skill\n'), mtime: Date.now() },
  { relative: '_meta/profile/package.json', data: Buffer.from('{"name":"phone","dsh":{"profile":{"bundles":[]}}}'), mtime: Date.now() },
  { relative: '--broken--/x.txt', data: Buffer.from('ignore me'), mtime: Date.now() },
])
const push = await request(`${base}/api/push?t=${token}&device=Pixel%209`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/gzip' },
  body: bundle,
})
assert.equal(push.status, 200)
console.log('--- push summary ---')
console.log(push.text().trim())
assert.match(push.text(), /相同 1/, 'the mirrored copy is the same session, not a new one')
assert.equal(scan(sessions).length, 1, 'no duplicate session appears')

const peerStatus = controller.status()
assert.equal(peerStatus.peer.device, 'Pixel 9')
assert.equal(peerStatus.peer.plugins, 1, 'the phone reported one installed plugin')
assert.equal(peerStatus.peer.skills, 1, 'and one installed skill')
const peerFiles = path.join(home, 'dsh-mobile-sync', 'peer')
assert.ok(fs.existsSync(path.join(peerFiles, 'index.json')), 'the phone index is cached for the next pull')
assert.ok(fs.existsSync(path.join(peerFiles, 'package.json')), 'and so is its profile package.json')
console.log('ok  push recorded the phone and cached its inputs')

// The mirrored log still claims the desktop project, so it must end up there —
// a log whose directory and header disagree is not found by the engine.
const after = scan(sessions)
assert.equal(after[0].cwd, desktopPath, 'pushing back realigns the header to the desktop workspace')
assert.equal(after[0].project, slugOf(desktopPath), 'and the log moves to that project directory')
assert.equal(fs.existsSync(path.join(sessions, phoneSlug)), false, 'the phone-shaped directory is cleaned up')
const afterIndex = readIndex(indexFile).index
const demoWorkspace = Object.values(afterIndex.tables.workspaces).find((item) => item.path === desktopPath)
assert.ok(demoWorkspace.sessionIds.includes(seed.id), 'the desktop index still lists it')
console.log('ok  push relocated the log into its desktop workspace')

// --- push again: identical content must not churn
const again = await request(`${base}/api/push?t=${token}&device=Pixel%209`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/gzip' },
  body: bundle,
})
assert.match(again.text(), /相同 1/, 'identical pushes collapse')
console.log('ok  repeated push is a no-op')

// --- unticking the workspace stops the outbound direction without deleting
// anything. (A conversation this machine already holds still comes home: the
// phone mirror of a desktop session reports "相同", not an import, so the
// switch has nothing to hold back there.)
await controller.act({ action: 'set-workspace', id: workspaceId, on: false })
const untickedPull = unpack((await request(`${base}/api/pull?t=${token}`, { method: 'POST' })).body)
assert.equal(
  untickedPull.entries.filter((entry) => entry.relative.startsWith('sessions/')).length,
  0,
  'an unticked workspace sends nothing',
)
const untickedStatus = controller.status()
assert.equal(untickedStatus.workspaces.desktop.find(item => item.id === workspaceId).selected, false)
assert.equal(untickedStatus.workspaces.on, 0, 'the card counts no ticked workspace')
await controller.act({ action: 'set-workspace', id: workspaceId, on: true })
assert.equal(controller.status().workspaces.on, 1)
console.log('ok  the workspace switch holds back the outbound side')

// --- a longer local log wins over the stored shorter one, with a backup kept
const desktopLog = fs.readFileSync(path.join(sessions, slugOf(desktopPath), seed.dir, seed.file))
const grown = Buffer.concat([desktopLog, zlib.zstdCompressSync(Buffer.from('{"type":"extra"}\n'))])
const growPush = await request(`${base}/api/push?t=${token}&device=Pixel%209`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/gzip' },
  body: pack([
    { relative: `${slugOf(desktopPath)}/${seed.dir}/${seed.file}`, data: grown, mtime: Date.now() },
    { relative: '_meta/index.json', data: Buffer.from(JSON.stringify(phoneIndex)), mtime: Date.now() },
  ]),
})
assert.match(growPush.text(), /导入 1/)
assert.equal(
  fs.statSync(path.join(sessions, slugOf(desktopPath), seed.dir, seed.file)).size,
  grown.length,
  'the longer copy replaces the stored one',
)
assert.equal(fs.existsSync(path.join(home, 'dsh-mobile-sync', 'backup')), true, 'the replaced log is backed up')
console.log('ok  longer copy replaces the local one and the old one is backed up')

// --- restart on another port
const moved = await controller.restart(live.port + 100)
assert.equal(moved.running, true)
assert.notEqual(moved.port, live.port)
const movedPing = await request(`http://127.0.0.1:${moved.port}/api/ping?t=${token}`)
assert.equal(movedPing.status, 200)
console.log(`ok  restart moved the listener to ${moved.port}`)

// --- reset token invalidates the old one
const fresh = controller.resetToken()
assert.notEqual(fresh, token)
const stale = await request(`http://127.0.0.1:${moved.port}/api/ping?t=${token}`)
assert.equal(stale.status, 401)
console.log('ok  token reset invalidates the old token')

await controller.stop()
assert.equal(controller.status().running, false)
console.log(`ok  stop() closed the listener\n\nwork dir: ${work}`)

// --- tar round trip of a long path (ustar prefix splitting)
const longPath = `${'-'.repeat(60)}${'x'.repeat(60)}/session-y/session.v4.jsonl.zstd`
const roundTripped = unpack(pack([{ relative: longPath, data: Buffer.from('hello'), mtime: 0 }]))
assert.equal(roundTripped.entries[0].relative, longPath)
assert.equal(roundTripped.entries[0].data.toString(), 'hello')
console.log('ok  tar handles a path longer than 100 bytes')

// --- the project key rule, checked against the real directories on this machine
assert.equal(slugOf('D:\\code\\Odds and ends'), '--D-code-Odds~0020and~0020ends--')
assert.equal(slugOf('/storage/emulated/0/DSH'), '--storage-emulated-0-DSH--')
assert.equal(slugOf('/data/data/com.dsharnessmobile.shell/files/home/.dsh'),
  '--data-data-com.dsharnessmobile.shell-files-home-.dsh--')
const realDirs = fs.readdirSync(REAL_ROOT).filter((name) => name.startsWith('--'))
const realProjects = scan(REAL_ROOT)
for (const entry of realProjects.slice(0, 50)) {
  if (typeof entry.cwd !== 'string' || entry.cwd.length === 0) continue
  assert.equal(slugOf(entry.cwd), entry.project, `slug must match the real directory of ${entry.cwd}`)
}
console.log(`ok  ${realDirs.length} real project keys reproduce exactly`)
assert.equal(slugOf('C:\\项目\\测试'), '--C-~9879~76EE-~6D4B~8BD5--')
assert.equal(slugOf('//server/share//x'), '--server-share-x--', 'a separator run collapses to one dash')
console.log('ok  non-ASCII paths escape with four upper-case hex digits')

console.log('\nALL HOST CHECKS PASSED')
