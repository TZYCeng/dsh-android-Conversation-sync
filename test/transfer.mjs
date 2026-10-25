/**
 * The sync planner's own suite: plugin switches, version skipping, skill
 * switches, digest skipping, one-way plugin flow, and the profile merge.
 *
 * These are the promises the panel makes to the user, so they are checked
 * against real files in a throwaway home rather than mocks:
 *
 *   - every plugin, skill and model group has its own switch, and an undecided
 *     item falls back to its kind's default — **off** for all of them;
 *   - a switch survives a save/load round trip, so the next sync uses the
 *     switches the previous one was left with;
 *   - a plugin whose version the phone already reports is not sent;
 *   - a skill whose content digest the desktop already handed over is not sent;
 *   - plugins only ever travel desktop → phone (a push never touches the
 *     desktop profile), while sessions travel both ways;
 *   - a workspace pairing can point a desktop project at a differently named
 *     phone workspace, in both directions.
 *
 * Usage: node test/transfer.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { normalizeSync, defaultSync, desktopForPhone, itemSelected, selected, setPhoneWorkspaceMap, setSelected, setSelectedAll } from '../lib/channels.js'
import { ingestPush, planPull, registerBundles } from '../lib/transfer.js'
import { listPlugins } from '../lib/plugins.js'
import { listSkills } from '../lib/skills.js'
import { listModels } from '../lib/models.js'
import { readIndex, writeIndex } from '../lib/index-sync.js'
import { scan, verifyLog } from '../lib/sessions.js'
import { pack } from '../lib/tar.js'
import { slugOf } from '../lib/slug.js'
import { atLeast, compareVersions, isNewer } from '../lib/version.js'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-transfer-'))
const home = path.join(work, 'home')
const sessionsRoot = path.join(home, 'sessions')
const profile = path.join(home, 'profiles', 'desktop')
const indexFile = path.join(home, 'storages', 'workspace.json')
const credentialsFile = path.join(home, '.credentials.yaml')
const agentsHome = path.join(work, 'agents')

for (const dir of [sessionsRoot, path.join(profile, 'node_modules'), path.join(home, 'skills'), agentsHome]) {
  fs.mkdirSync(dir, { recursive: true })
}

/** Write one fake plugin package. */
function writePlugin(name, version, options = {}) {
  const dir = path.join(profile, 'node_modules', ...name.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  const manifest = {
    name,
    version,
    main: 'index.js',
    dsh: options.bundle === false ? {} : { bundle: { patch: 'cordis.patch.yml' } },
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
  }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, 'index.js'), `export const name = ${JSON.stringify(name)}\n`)
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n')
  if (options.native) fs.writeFileSync(path.join(dir, 'native.node'), Buffer.alloc(64))
  return dir
}

writePlugin('dsh-demo', '1.2.3')
writePlugin('dsh-other', '2.0.0')
writePlugin('dsh-heavy', '3.0.0', { dependencies: { openai: '^1.0.0' } })
writePlugin('dsh-native', '4.0.0', { native: true })

fs.writeFileSync(
  path.join(profile, 'package.json'),
  `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-demo'] } },
    dependencies: { 'dsh-demo': '1.2.3', 'dsh-other': '2.0.0', 'dsh-heavy': '3.0.0', 'dsh-native': '4.0.0' },
  }, null, 2)}\n`,
)

/** Write one skill bundle. */
function writeSkill(root, name, description) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody\n`,
  )
  return dir
}

writeSkill(path.join(home, 'skills'), 'alpha', 'first skill')
writeSkill(path.join(home, 'skills'), 'beta', 'second skill')

fs.writeFileSync(
  path.join(profile, 'cordis.patch.yml'),
  [
    '# a comment that must survive',
    '- id: model-demo',
    '  name: "@deepseek-ai/dsh-llm-demo"',
    '  config:',
    '    baseURL: https://api.example.com/v1',
    '    apiKeyRef: DEMO_KEY',
    '    models:',
    '      - id: demo-large',
    '      - id: demo-small',
    '- id: plugin-provided',
    '  name: some-plugin-provider',
    '  config:',
    '    freeOnly: true',
    '',
  ].join('\n'),
)
fs.writeFileSync(
  credentialsFile,
  ['version: 1', 'records:', '  keep/me:', '    kind: grant', 'refs:', '  DEMO_KEY: sk-demo', ''].join('\n'),
)

const sync = normalizeSync({})
sync.desktopRoot = path.join(work, 'desk')
// Every project this suite makes up is ticked through the helper below; real
// planPull calls spread it because `workspaces` is a per-item switch map and
// assigning a new one would replace choices other sections made.
const TICKED = { workspaceWanted: true }
const plugins = listPlugins({ profileDir: profile })
const skills = listSkills({ home, agentsHome })
const models = listModels({ patchFile: path.join(profile, 'cordis.patch.yml'), credentialsFile })
const catalogs = { plugins, skills, models }

assert.equal(plugins.length, 4, 'four plugins are offered')
assert.equal(plugins.find(item => item.name === 'dsh-heavy').installable, false, 'a plugin with runtime deps is not installable')
assert.equal(plugins.find(item => item.name === 'dsh-native').installable, false, 'a plugin with a native artifact is not installable')
assert.equal(models.length, 1, 'only the row with its own endpoint is a model row')
assert.equal(models[0].keys[0], 'DEMO_KEY')
console.log(`ok  catalogs -> ${plugins.length} plugins, ${skills.length} skills, ${models.length} model row`)

/* ---------------------------------------------------------------- versions */

assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
assert.equal(compareVersions('2.0.0', '2.0.0-rc.2'), 1, 'a release is newer than its pre-release')
assert.equal(compareVersions('2.0.0-rc.2', '2.0.0-rc.10'), -1, 'pre-release numbers compare numerically')
assert.equal(compareVersions('nonsense', '1.0.0'), null, 'unparsable versions are not comparable')
assert.equal(atLeast('1.2.3', '1.2.3'), true)
assert.equal(atLeast('9.9.9', '1.2.3'), true)
assert.equal(atLeast(undefined, '1.2.3'), false, 'an unknown phone version means "send"')
assert.equal(isNewer('2.0.0', '1.2.3'), true)
assert.equal(isNewer('1.2.3', '1.2.3'), false)
console.log('ok  version comparison ranks releases, pre-releases and unknowns')

/* ------------------------------------------------------------- the switches */

// Undecided items fall back to their kind's default.
assert.equal(selected(sync.plugins, 'dsh-demo', true), true)
assert.equal(selected(sync.plugins, 'dsh-demo', false), false)
assert.equal(selected(sync.skills, 'alpha', true), true)
assert.equal(itemSelected(sync, 'plugins', 'dsh-demo'), false, 'plugins are off until ticked')
assert.equal(itemSelected(sync, 'skills', 'alpha'), false, 'skills are off until ticked')
assert.equal(itemSelected(sync, 'models', 'some/group'), false, 'model groups are off until ticked')
assert.equal(sync.channels.sessions, true, 'sessions are on by default')
assert.equal(sync.channels.models, false, 'models are off by default')
assert.equal(sync.includeArchived, false, 'archived sessions stay home by default')
assert.equal(sync.plugins.dsh, undefined, 'nothing is decided before the user acts')

// A state file from before rev 2 is re-seeded once: its old implicit "on"
// choices were defaults, not decisions, and archived sessions are turned off.
const legacy = normalizeSync({ plugins: { old: true }, skills: { old: true }, includeArchived: true })
assert.deepEqual(legacy.plugins, {})
assert.deepEqual(legacy.skills, {})
assert.equal(legacy.includeArchived, false)
assert.equal(legacy.defaultsRev, 3)
const modern = normalizeSync({ defaultsRev: 3, plugins: { old: true }, includeArchived: true })
assert.deepEqual(modern.plugins, { old: true }, 'a rev-3 decision is never overwritten')
assert.equal(modern.includeArchived, true)

// A decision persists exactly as written, including "off" for a plugin whose
// default would be on.
setSelected(sync, 'plugins', 'dsh-other', false)
setSelected(sync, 'skills', 'beta', false)
const reloaded = normalizeSync(JSON.parse(JSON.stringify(sync)))
assert.equal(reloaded.plugins['dsh-other'], false, 'a plugin switch survives a save/load round trip')
assert.equal(reloaded.skills.beta, false, 'a skill switch survives a save/load round trip')
assert.equal(selected(reloaded.plugins, 'dsh-demo', true), true, 'an untouched plugin still follows its default')
setSelectedAll(sync, 'plugins', ['dsh-demo', 'dsh-other'], true)
assert.equal(sync.plugins['dsh-other'], true, 'set-all flips every named item')
assert.equal(normalizeSync({ channels: { plugins: 'off' } }).channels.plugins, false, 'string switches are understood')
assert.equal(defaultSync().phoneRoot, '/storage/emulated/0/DSH')
assert.equal(
  defaultSync(undefined, path.join(work, 'h')).desktopRoot,
  path.join(work, 'h', 'sessions'),
  'a new install roots the desktop side at the DSH conversation store',
)
assert.equal(itemSelected(sync, 'workspaces', 'ws-1'), false, 'a workspace syncs nothing until ticked')
// Rev 3 moved the desktop root onto the conversation store. An install still on
// the old invented default is moved; a rev-2 install keeps its stored root
// (migrating is a one-time step, not something every load re-applies) — and the
// old by-title pairing map is dropped either way, because pairing is a
// per-workspace decision now.
const migrated = normalizeSync(
  { desktopRoot: path.join(work, 'h', 'DSH'), workspaceMap: { a: 'b' } },
  undefined,
  path.join(work, 'h'),
)
assert.equal(migrated.desktopRoot, path.join(work, 'h', 'sessions'), 'a pre-rev-3 install moves onto the store root')
assert.deepEqual(migrated.workspaceMap, {}, 'the old implicit pairing map is dropped')
assert.deepEqual(migrated.workspaces, {}, 'and no workspace is ticked on its behalf')
const rev2 = normalizeSync({ defaultsRev: 2, desktopRoot: path.join(work, 'h', 'DSH') }, undefined, path.join(work, 'h'))
assert.equal(rev2.defaultsRev, 3, 'a rev-2 file is stamped rev 3 once')
assert.equal(rev2.desktopRoot, path.join(work, 'h', 'sessions'), 'and a rev-2 install still on the old root moves too')
assert.deepEqual(rev2.plugins, {}, 'and its rev-2 implicit choices are re-seeded')
assert.deepEqual(rev2.workspaces, {}, 'per-workspace switches start off')
const typedRoot = normalizeSync({ defaultsRev: 3, desktopRoot: path.join(work, 'mine') }, undefined, path.join(work, 'h'))
assert.equal(typedRoot.desktopRoot, path.join(work, 'mine'), 'a root the user typed is never overruled')
const freshRoot = normalizeSync({ defaultsRev: 3 }, undefined, path.join(work, 'h'))
assert.equal(freshRoot.desktopRoot, path.join(work, 'h', 'sessions'), 'an install that already migrated keeps the store root')
setSelected(sync, 'workspaces', 'ws-1', true)
assert.equal(normalizeSync(JSON.parse(JSON.stringify(sync))).workspaces['ws-1'], true, 'a workspace switch survives a round trip')
console.log('ok  channel defaults and per-item switches survive persistence')

/* ---------------------------------------------------------- plugin planning */

const peer = { device: 'Pixel 9', plugins: {}, skills: [] }
const peerFiles = {
  profilePackage: fs.readFileSync(path.join(profile, 'package.json'), 'utf8').replace('dsh-demo', 'dsh-demo'),
  patch: null,
  credentials: null,
  index: null,
}
// The phone's profile only has the host bundle to begin with.
peerFiles.profilePackage = `${JSON.stringify({
  name: 'phone-profile',
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  dependencies: {},
}, null, 2)}\n`

sync.plugins = { 'dsh-demo': true, 'dsh-other': false }
const first = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer,
  peerFiles,
  catalogs,
  sent: {},
  credentialsFile,
  now: 1000,
  ...TICKED,
})
const pluginFiles = first.files.filter(file => file.relative.startsWith('_meta/plugins/')).map(file => file.relative)
assert.ok(pluginFiles.some(name => name.startsWith('_meta/plugins/dsh-demo/')), 'a ticked plugin is packed')
assert.ok(!pluginFiles.some(name => name.startsWith('_meta/plugins/dsh-other/')), 'an unticked plugin is not packed')
assert.ok(!pluginFiles.some(name => name.startsWith('_meta/plugins/dsh-heavy/')), 'an unticked plugin is not packed, warned or not')
assert.ok(!pluginFiles.some(name => name.startsWith('_meta/plugins/dsh-native/')), 'and neither is an unticked native one')
assert.deepEqual(first.summary.plugins.off.sort(), ['dsh-heavy', 'dsh-native', 'dsh-other'])
assert.deepEqual(first.summary.plugins.unsupported, [])
assert.deepEqual(first.sent.plugins['dsh-demo'], { version: '1.2.3', at: 1000 })

const profileFile = first.files.find(file => file.relative === '_meta/profile/package.json')
assert.ok(profileFile !== undefined, 'the phone profile is rewritten to register the bundle')
const registered = JSON.parse(String(profileFile.data))
assert.deepEqual(registered.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-demo'], 'only the sent plugin is registered')
assert.deepEqual(registered.dependencies, {}, 'the phone dependencies are left alone')
console.log(`ok  per-plugin switches -> ${first.summary.plugins.send.length} packed, ${first.summary.plugins.off.length} off`)

// A warned plugin is still shipped when ticked: the user may want it on the phone
// and repair it there. The warning travels in the summary and the log instead of
// blocking the transfer.
sync.plugins = { 'dsh-heavy': true, 'dsh-native': true }
const warned = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer,
  peerFiles,
  catalogs,
  sent: {},
  credentialsFile,
  ...TICKED,
})
const warnedFiles = warned.files.filter(file => file.relative.startsWith('_meta/plugins/')).map(file => file.relative)
assert.ok(warnedFiles.some(name => name.startsWith('_meta/plugins/dsh-heavy/')), 'a plugin with external deps still travels')
assert.ok(warnedFiles.some(name => name.startsWith('_meta/plugins/dsh-native/')), 'and so does one with a native artifact')
assert.deepEqual(warned.summary.plugins.unsupported.map(item => item.name).sort(), ['dsh-heavy', 'dsh-native'])
assert.ok(warned.summary.plugins.unsupported.every(item => typeof item.reason === 'string' && item.reason.length > 0))
assert.ok(warned.lines.some(line => /标记为不支持/.test(line)), 'the log explains the warning')
assert.deepEqual(
  JSON.parse(String(warned.files.find(file => file.relative === '_meta/profile/package.json').data)).dsh.profile.bundles,
  ['@deepseek-ai/dsh-base', 'dsh-heavy', 'dsh-native'],
  'and both are registered in the phone profile',
)
sync.plugins = {}
console.log('ok  a warned plugin is shipped when ticked, with a note')

/* ------------------------------------------------------------ version skip */

sync.plugins = { 'dsh-demo': true, 'dsh-other': false }
const sameVersion = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer: { ...peer, plugins: { 'dsh-demo': '1.2.3' } },
  peerFiles,
  catalogs,
  sent: first.sent,
  credentialsFile,
  ...TICKED,
})
assert.equal(
  sameVersion.files.filter(file => file.relative.startsWith('_meta/plugins/')).length,
  0,
  'a plugin already at the same version on the phone is not sent again',
)
assert.deepEqual(sameVersion.summary.plugins.same, ['dsh-demo'])
assert.equal(
  sameVersion.files.filter(file => file.relative === '_meta/profile/package.json').length,
  0,
  'and nothing needs registering',
)
console.log('ok  a version already on the phone is skipped')

// A newer desktop version goes out again, without a forced resend.
writePlugin('dsh-demo', '1.3.0')
const bumped = catalogs.plugins.map(item => (item.name === 'dsh-demo' ? { ...item, version: '1.3.0' } : item))
const newer = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer: { ...peer, plugins: { 'dsh-demo': '1.2.3' } },
  peerFiles,
  catalogs: { ...catalogs, plugins: bumped },
  sent: first.sent,
  credentialsFile,
  ...TICKED,
})
assert.equal(newer.summary.plugins.send.length, 1, 'a newer version is sent')
assert.equal(newer.summary.plugins.send[0].version, '1.3.0')
assert.equal(newer.sent.plugins['dsh-demo'].version, '1.3.0', 'what was sent is recorded')

// The force switch overrides the shortcut for the next pull only.
sync.force = true
const forced = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer: { ...peer, plugins: { 'dsh-demo': '1.3.0' } },
  peerFiles,
  catalogs: { ...catalogs, plugins: bumped },
  sent: {},
  credentialsFile,
  ...TICKED,
})
assert.equal(forced.summary.plugins.send.length, 1, 'a forced resend ignores the same-version shortcut')
sync.force = false
console.log('ok  newer versions are sent and the force switch overrides the shortcut')

// A phone that is *ahead* is never rolled back, and the panel says so.
const ahead = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer: { ...peer, plugins: { 'dsh-demo': '2.5.0' } },
  peerFiles,
  catalogs: { ...catalogs, plugins: bumped },
  sent: {},
  credentialsFile,
  ...TICKED,
})
assert.equal(ahead.summary.plugins.send.length, 0, 'a newer phone version is not downgraded')
assert.deepEqual(ahead.summary.plugins.newer, ['dsh-demo'])
assert.ok(ahead.lines.some(line => /未降级/.test(line)), 'the log explains the skipped downgrade')
console.log('ok  a newer copy on the phone is never downgraded')

/* ---------------------------------------------------------- skill planning */

sync.skills = { alpha: true, beta: false }
const skillPull = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer,
  peerFiles,
  catalogs,
  sent: {},
  credentialsFile,
  ...TICKED,
})
const skillArchive = skillPull.files.map(file => file.relative).filter(name => name.startsWith('_meta/skills/'))
assert.deepEqual(skillArchive, ['_meta/skills/alpha/SKILL.md'], 'only the ticked skill travels, with its bundle layout')
assert.deepEqual(skillPull.summary.skills.off, ['beta'])
assert.equal(skillPull.summary.skills.send[0].name, 'alpha')
const alphaDigest = skillPull.sent.skills.alpha.digest
assert.match(alphaDigest, /^[0-9a-f]{64}$/)

// Same content, already on the phone: nothing to do.
const skillAgain = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer: { ...peer, skills: ['alpha'] },
  peerFiles,
  catalogs,
  sent: skillPull.sent,
  credentialsFile,
  ...TICKED,
})
assert.deepEqual(skillAgain.summary.skills.send, [], 'identical skill content is skipped')
assert.deepEqual(skillAgain.summary.skills.same, ['alpha'])

// The phone lost the skill: it goes out even though the digest matches.
const skillMissing = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer: { ...peer, skills: [] },
  peerFiles,
  catalogs,
  sent: skillPull.sent,
  credentialsFile,
  ...TICKED,
})
assert.equal(skillMissing.summary.skills.send.length, 1, 'a skill the phone does not have is sent again')

// Editing the skill changes the digest, so the next pull ships it.
const alphaFile = path.join(home, 'skills', 'alpha', 'SKILL.md')
fs.appendFileSync(alphaFile, '\nmore instructions\n')
const edited = listSkills({ home, agentsHome })
const changed = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer: { ...peer, skills: ['alpha'] },
  peerFiles,
  catalogs: { plugins, skills: edited, models },
  sent: skillPull.sent,
  credentialsFile,
  ...TICKED,
})
assert.equal(changed.summary.skills.send.length, 1, 'edited content is sent again')
assert.notEqual(changed.sent.skills.alpha.digest, alphaDigest, 'the digest moved with the content')
console.log('ok  per-skill switches, digest skipping and re-send on change')

/* ------------------------------------------------------------------ models */

sync.channels.models = true
sync.models = { 'model-demo': true }
const modelPull = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer,
  peerFiles: { ...peerFiles, patch: '# phone patch\n- id: phone-only\n  name: phone-plugin\n' },
  catalogs,
  sent: {},
  credentialsFile,
  ...TICKED,
})
const patchFile = modelPull.files.find(file => file.relative === '_meta/patch/cordis.patch.yml')
assert.ok(patchFile !== undefined, 'the merged patch travels when the models channel is on')
assert.match(String(patchFile.data), /phone-only/, 'the phone keeps its own entries')
assert.match(String(patchFile.data), /api\.example\.com/, 'and receives the model row')
assert.match(String(patchFile.data), /^# phone patch/, "only the phone's own header stays: the desktop's comments describe the desktop")

// Keys travel with their group: a model whose `apiKeyRef` never arrives is a
// model the phone cannot call (llm-pi-ai throws MISSING_CREDENTIAL).
const keyFile = modelPull.files.find(file => file.relative === '_meta/patch/credentials.yaml')
assert.ok(keyFile !== undefined, 'the key the model group names travels with it')
assert.match(String(keyFile.data), /DEMO_KEY: sk-demo/)
assert.match(String(keyFile.data), /^version: 1/m, 'a phone that never uploaded credentials gets a complete document')
assert.deepEqual(modelPull.summary.secrets.refs, ['DEMO_KEY'])
assert.deepEqual(modelPull.summary.secrets.missing, [])
assert.ok(modelPull.lines.some(line => /密钥：下发 1 个引用/.test(line)), 'the log says the key travelled')

// The per-group key switch can hold a key back, but then the log says so.
sync.modelKeys = { 'model-demo': false }
const noKey = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer,
  peerFiles: { ...peerFiles, patch: '# phone patch\n' },
  catalogs,
  sent: {},
  credentialsFile,
  ...TICKED,
})
assert.equal(
  noKey.files.filter(file => file.relative === '_meta/patch/credentials.yaml').length,
  0,
  "a group's key switch off keeps the key home",
)
assert.ok(noKey.lines.some(line => /未下发（该组的密钥开关关着/.test(line)), 'the log says the key was held back')
sync.modelKeys = {}

// A master switch off holds every key back, including a complete phone document.
sync.secrets = false
const heldBack = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer,
  peerFiles: { ...peerFiles, patch: '# phone patch\n', credentials: 'version: 1\nrefs:\n  OTHER: x\n' },
  catalogs,
  sent: {},
  credentialsFile,
  ...TICKED,
})
assert.equal(
  heldBack.files.filter(file => file.relative === '_meta/patch/credentials.yaml').length,
  0,
  'the master switch off keeps every key home',
)
assert.ok(heldBack.lines.some(line => /密钥：未同步/.test(line)), 'and the log explains why')

// A phone's own refs/records survive the merge.
sync.secrets = true
const secretPull = planPull({
  sessionsRoot,
  indexFile,
  sync,
  peer,
  peerFiles: { ...peerFiles, patch: '# phone patch\n', credentials: 'version: 1\nrecords:\n  keep/me:\n    kind: grant\nrefs:\n  OTHER: x\n' },
  catalogs,
  sent: {},
  credentialsFile,
  ...TICKED,
})
const secretFile = secretPull.files.find(file => file.relative === '_meta/patch/credentials.yaml')
assert.ok(secretFile !== undefined, 'with the secrets switch on, the ref travels')
assert.match(String(secretFile.data), /DEMO_KEY: sk-demo/)
assert.match(String(secretFile.data), /keep\/me/, 'records are preserved')
assert.match(String(secretFile.data), /OTHER: x/, 'the phone keeps its own refs')
assert.ok(!secretPull.lines.some(line => /电脑上缺/.test(line)), 'a ref the desktop holds is not reported missing')
sync.secrets = false
sync.channels.models = false
console.log('ok  model groups carry their keys, and the switches can hold them back')

/* ------------------------------------------------------ sessions both ways */

// A desktop session, registered in a workspace, so a pull has something to send.
const REAL_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
// A real *user* session: delegated transcripts are never synced, so they would
// be the wrong seed for a test about sessions moving.
const seedCandidate = scan(REAL_ROOT).find(entry => entry.origin !== 'subagent')
const seedResource = path.join(REAL_ROOT, seedCandidate.project, seedCandidate.dir, seedCandidate.file)
fs.mkdirSync(path.join(sessionsRoot, seedCandidate.project, seedCandidate.dir), { recursive: true })
fs.copyFileSync(seedResource, path.join(sessionsRoot, seedCandidate.project, seedCandidate.dir, seedCandidate.file))

const workspaceId = '22222222-2222-4222-8222-222222222222'
const desktopPath = path.join(work, 'demo-project')
fs.mkdirSync(path.dirname(indexFile), { recursive: true })
fs.writeFileSync(indexFile, `${JSON.stringify({
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
        sessionIds: [seedCandidate.id],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  },
}, null, 2)}\n`)

function planWith(switches = {}, extra = {}) {
  return planPull({
    sessionsRoot,
    indexFile,
    sync,
    peer,
    peerFiles: { ...peerFiles, index: null },
    catalogs,
    sent: {},
    credentialsFile,
    ...TICKED,
    workspaces: { ...(sync.workspaces ?? {}), ...switches },
    ...extra,
  })
}

// The workspace index above registers a project this store does not have on
// disk (only the seed session is copied), so the panel-style fixture also lists
// a project that does hold the seed.
const seededWorkspaceId = '44444444-4444-4444-8444-444444444444'
const indexDoc = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
indexDoc.tables.workspaces[seededWorkspaceId] = {
  path: path.join(work, 'seeded-project'),
  title: 'seeded',
  sessionIds: [seedCandidate.id],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
indexDoc.global.workspaceIds.push(seededWorkspaceId)
fs.writeFileSync(indexFile, `${JSON.stringify(indexDoc, null, 2)}\n`)

// Nothing comes out of a project until its own「同步对话」box is ticked.
const untickedPull = planWith({})
assert.equal(untickedPull.summary.sessions, 0, 'a workspace nobody ticked sends nothing')
assert.equal(untickedPull.summary.workspacesOff, 2, 'and the log counts the unticked projects as held back')
assert.ok(untickedPull.lines.some(line => /未勾选/.test(line)), 'and says why')
console.log('ok  an unticked workspace stays home')

const sessionPull = planWith({ [workspaceId]: true, [seededWorkspaceId]: false })
const sessionFiles = sessionPull.files.filter(file => file.relative.startsWith('sessions/'))
assert.equal(sessionFiles.length, 1)
assert.equal(
  sessionFiles[0].relative,
  `sessions/${slugOf('/storage/emulated/0/DSH/demo')}/${seedCandidate.id}/${seedCandidate.file}`,
)
assert.equal(verifyLog(sessionFiles[0].data).cwd, '/storage/emulated/0/DSH/demo', 'the mirror claims the phone directory')
// Archived sessions stay home unless asked for.
const archivedIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
archivedIndex.global.archivedSessionIds = [seedCandidate.id]
fs.writeFileSync(indexFile, `${JSON.stringify(archivedIndex, null, 2)}\n`)
const archivedPull = planWith({ [workspaceId]: true, [seededWorkspaceId]: false })
assert.equal(archivedPull.summary.sessions, 0, 'an archived session is not synced by default')
assert.equal(archivedPull.summary.archivedSkipped, 1)
sync.includeArchived = true
const includedPull = planWith({ [workspaceId]: true, [seededWorkspaceId]: false })
assert.equal(includedPull.summary.sessions, 1, 'the switch brings it back')
sync.includeArchived = false
fs.writeFileSync(indexFile, `${JSON.stringify({
  ...archivedIndex,
  global: { ...archivedIndex.global, archivedSessionIds: [] },
}, null, 2)}\n`)
console.log('ok  sessions carry the mapped cwd and honour the archived switch')

// A phone that reports exactly the bytes it holds gets nothing back: the size
// inventory is what keeps a repeat sync cheap.
const mirroredSize = Buffer.byteLength(sessionFiles[0].data)
const settled = planWith(
  { [workspaceId]: true, [seededWorkspaceId]: false },
  { peerFiles: { ...peerFiles, index: null, sessions: `${seedCandidate.id} ${mirroredSize}\n` } },
)
assert.equal(settled.summary.sessions, 0, 'a session the phone already holds is not transferred again')
assert.equal(settled.summary.sessionsSame, 1, 'and it is counted as already current')
assert.equal(settled.files.filter(file => file.relative.startsWith('sessions/')).length, 0)

// An older phone copy (a smaller size) is still refreshed.
const stale = planWith(
  { [workspaceId]: true, [seededWorkspaceId]: false },
  { peerFiles: { ...peerFiles, index: null, sessions: `${seedCandidate.id} ${mirroredSize - 10}\n` } },
)
assert.equal(stale.summary.sessions, 1, 'a phone copy of a different size is refreshed')

// And the force switch ignores the size shortcut too.
sync.force = true
const forcedSessions = planWith(
  { [workspaceId]: true, [seededWorkspaceId]: false },
  { peerFiles: { ...peerFiles, index: null, sessions: `${seedCandidate.id} ${mirroredSize}\n` } },
)
assert.equal(forcedSessions.summary.sessions, 1, 'force resends even when the sizes match')
sync.force = false
console.log('ok  the phone size inventory skips unchanged sessions, force overrides it')

/* ------------------------------------------------- delegated (subagent) logs */

// A delegated transcript is a real file in the store, but the engine never gives
// it a sidebar row on either machine; syncing it would only add rows nobody can
// place. It is recognised by `origin` in the header, not by the id's shape.
const subId = '44444444-4444-4444-8444-444444444444'
const subHeader = {
  type: 'session',
  version: 4,
  id: subId,
  createdAt: Date.now(),
  cwd: desktopPath,
  parentSession: seedCandidate.id,
  isSeeded: false,
  origin: 'subagent',
  delegationDepth: 1,
}
const subLog = Buffer.concat([
  zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(subHeader)}\n`)),
  zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({
    type: 'agent/inbox/spliced',
    data: { inserted: [{ role: 'user', content: [{ type: 'text', text: 'delegated work' }] }] },
  })}\n`)),
])
const subDir = path.join(sessionsRoot, slugOf(desktopPath), subId)
fs.mkdirSync(subDir, { recursive: true })
fs.writeFileSync(path.join(subDir, 'session.v4.jsonl.zstd'), subLog)
assert.equal(scan(sessionsRoot).find(entry => entry.id === subId)?.origin, 'subagent', 'the header marks it as delegated')

const withSubagent = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
withSubagent.tables.workspaces[workspaceId].sessionIds.push(subId)
fs.writeFileSync(indexFile, `${JSON.stringify(withSubagent, null, 2)}\n`)
const subPlan = planWith({ [workspaceId]: true, [seededWorkspaceId]: false })
assert.equal(subPlan.summary.subagentSkipped, 1, 'a delegated transcript is not mirrored')
assert.equal(subPlan.summary.sessions, 1, 'the user session beside it still travels')
assert.equal(
  subPlan.files.filter(file => file.relative.includes(subId)).length,
  0,
  'and none of its bytes are packed',
)

// Drop it from the index again, then let the phone offer it: it must not be
// imported, and it must not be registered either.
fs.writeFileSync(indexFile, `${JSON.stringify({
  ...withSubagent,
  tables: {
    workspaces: {
      ...withSubagent.tables.workspaces,
      [workspaceId]: { ...withSubagent.tables.workspaces[workspaceId], sessionIds: [seedCandidate.id] },
    },
  },
}, null, 2)}\n`)
const subPush = ingestPush({
  sessionsRoot,
  indexFile,
  backupDir: path.join(work, 'backup'),
  sync,
  device: 'Pixel 9',
  entries: [
    { relative: `${slugOf(desktopPath)}/${subId}/session.v4.jsonl.zstd`, data: subLog },
  ],
})
assert.equal(subPush.counts.subagent, 1, 'an incoming delegated transcript is skipped')
assert.equal(subPush.counts.imported, 0)
const afterSubPush = readIndex(indexFile).index
const subWorkspace = Object.values(afterSubPush.tables.workspaces).find(item => item.path === desktopPath)
assert.equal(subWorkspace.sessionIds.includes(subId), false, 'and it is not registered in any workspace')
console.log('ok  delegated (subagent) transcripts stay on the machine that made them')

// A push never touches the desktop profile: plugins are one-way.
const profileBefore = fs.readFileSync(path.join(profile, 'package.json'), 'utf8')
const phoneSlug = `--storage-emulated-0-DSH-demo--`
const phoneIndex = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    defaultWorkspaceId: '33333333-3333-4333-8333-333333333333',
    workspaceIds: ['33333333-3333-4333-8333-333333333333'],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  },
  tables: {
    workspaces: {
      '33333333-3333-4333-8333-333333333333': {
        path: '/storage/emulated/0/DSH/demo',
        title: 'demo',
        sessionIds: [seedCandidate.id],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  },
}
const pushed = ingestPush({
  sessionsRoot,
  indexFile,
  backupDir: path.join(work, 'backup'),
  sync,
  device: 'Pixel 9',
  entries: [
    { relative: `${phoneSlug}/${seedCandidate.id}/${seedCandidate.file}`, data: sessionFiles[0].data },
    { relative: '_meta/index.json', data: Buffer.from(JSON.stringify(phoneIndex)) },
    { relative: '_meta/phone.env', data: Buffer.from('device=Pixel 9\nhome=/data/.dsh\nsessions=/data/.dsh/sessions\n') },
    { relative: '_meta/plugins.txt', data: Buffer.from('dsh-demo 9.9.9\n') },
    { relative: '_meta/skills.txt', data: Buffer.from('alpha\n') },
  ],
})
assert.equal(pushed.counts.identical, 1, 'the mirrored session is recognised as the same conversation')
assert.equal(pushed.peer.plugins['dsh-demo'], '9.9.9', 'the phone inventory is recorded')
assert.deepEqual(pushed.peer.skills, ['alpha'])
assert.equal(
  fs.readFileSync(path.join(profile, 'package.json'), 'utf8'),
  profileBefore,
  'a push never edits the desktop profile: plugins are desktop → phone only',
)
const desktopAfter = readIndex(indexFile).index
const demoAfter = Object.values(desktopAfter.tables.workspaces).find(item => item.path === desktopPath)
assert.ok(demoAfter.sessionIds.includes(seedCandidate.id), 'the session stays registered in its workspace')
console.log('ok  push records the phone inventory and leaves the desktop profile alone')

/* ------------------------------------------------------- workspace pairing */

// The panel lets the user point a desktop workspace at a *differently named*
// phone workspace, in both directions. Without a pairing, a new phone project
// gets its own directory under the root — titles are never silently aligned.
const phoneOtherId = '55555555-5555-4555-8555-555555555555'
const phoneOtherPath = '/storage/emulated/0/DSH/Phone Project'
const nowIso = new Date().toISOString()
const phoneOtherIndex = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    defaultWorkspaceId: phoneOtherId,
    workspaceIds: [phoneOtherId],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  },
  tables: {
    workspaces: {
      [phoneOtherId]: {
        path: phoneOtherPath,
        title: 'Phone Project',
        sessionIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  },
}

sync.workspaceMap = { [workspaceId]: phoneOtherId }
const pairedPull = planWith(
  { [workspaceId]: true, [seededWorkspaceId]: false },
  { peerFiles: { ...peerFiles, index: JSON.stringify(phoneOtherIndex) } },
)
const pairedSession = pairedPull.files.find(file => file.relative.startsWith('sessions/'))
assert.equal(
  pairedSession.relative,
  `sessions/${slugOf(phoneOtherPath)}/${seedCandidate.id}/${seedCandidate.file}`,
  'the explicit pairing wins over a same-title phone workspace',
)
assert.equal(verifyLog(pairedSession.data).cwd, phoneOtherPath, 'and the log claims the paired directory')
const pairedIndexOut = JSON.parse(pairedPull.files.find(file => file.relative === '_meta/index.json').data)
assert.ok(
  pairedIndexOut.tables.workspaces[phoneOtherId].sessionIds.includes(seedCandidate.id),
  'the session is registered under the paired phone workspace',
)
console.log('ok  desktop → phone pairing targets the chosen phone workspace, not the same-name one')

// The reverse direction: a phone session in that workspace lands in the paired
// desktop workspace even though no title matches.
const pairedId = '77777777-7777-4777-8777-777777777777'
const pairedLog = Buffer.concat([
  zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({
    type: 'session',
    version: 4,
    id: pairedId,
    createdAt: Date.now(),
    cwd: phoneOtherPath,
    isSeeded: false,
  })}\n`)),
  zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({
    type: 'agent/inbox/spliced',
    data: { inserted: [{ role: 'user', content: [{ type: 'text', text: 'from the paired workspace' }] }] },
  })}\n`)),
])
const pairedPush = ingestPush({
  sessionsRoot,
  indexFile,
  backupDir: path.join(work, 'backup'),
  sync: { ...sync, workspaces: { [workspaceId]: true } },
  device: 'Pixel 9',
  entries: [
    { relative: `${slugOf(phoneOtherPath)}/${pairedId}/session.v4.jsonl.zstd`, data: pairedLog },
    {
      relative: '_meta/index.json',
      data: Buffer.from(JSON.stringify({
        ...phoneOtherIndex,
        tables: {
          workspaces: {
            [phoneOtherId]: { ...phoneOtherIndex.tables.workspaces[phoneOtherId], sessionIds: [pairedId] },
          },
        },
      })),
    },
  ],
})
assert.equal(pairedPush.counts.imported, 1)
const landed = Object.values(readIndex(indexFile).index.tables.workspaces)
  .find(workspace => workspace.sessionIds.includes(pairedId))
assert.ok(landed !== undefined, 'the incoming session was registered')
assert.equal(landed.path, desktopPath, 'phone → desktop pairing lands in the chosen desktop workspace')
console.log('ok  phone → desktop pairing lands the session in the paired workspace')

// With the pairing cleared, the same phone project falls back to a directory
// under the desktop root, named after its title — and an unticked workspace
// keeps the phone's brand-new project out entirely.
async function unpairedPush(id, phoneWorkspace, syncState) {
  const log = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({
      type: 'session', version: 4, id, createdAt: Date.now(), cwd: phoneOtherPath, isSeeded: false,
    })}\n`)),
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({
      type: 'agent/inbox/spliced',
      data: { inserted: [{ role: 'user', content: [{ type: 'text', text: 'unpaired' }] }] },
    })}\n`)),
  ])
  return ingestPush({
    sessionsRoot,
    indexFile,
    backupDir: path.join(work, 'backup'),
    sync: syncState,
    device: 'Pixel 9',
    entries: [
      { relative: `${slugOf(phoneOtherPath)}/${id}/session.v4.jsonl.zstd`, data: log },
      { relative: '_meta/index.json', data: Buffer.from(JSON.stringify({
        ...phoneWorkspace,
        tables: {
          workspaces: {
            ...phoneWorkspace.tables.workspaces,
            [Object.keys(phoneWorkspace.tables.workspaces)[0]]: {
              ...phoneWorkspace.tables.workspaces[Object.keys(phoneWorkspace.tables.workspaces)[0]],
              sessionIds: [id],
            },
          },
        },
      })) },
    ],
  })
}

sync.workspaceMap = {}
const unpairedId = '88888888-8888-4888-8888-888888888888'
unpairedPush(unpairedId, phoneOtherIndex, sync)
const unpairedLanded = Object.values(readIndex(indexFile).index.tables.workspaces)
  .find(workspace => workspace.sessionIds.includes(unpairedId))
assert.equal(
  unpairedLanded.path,
  path.join(work, 'desk', 'Phone Project'),
  'without a pairing a brand-new phone project gets its own directory under the desktop root',
)
console.log('ok  clearing the pairing sends a new phone project to the desktop root')

// A phone project the panel *has* shown (it is the target of a pairing) but
// whose workspace is unticked keeps its new conversations on the phone.
const blockedId = '99999999-9999-4999-8999-999999999999'
const blockedWorkspace = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    defaultWorkspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  },
  tables: {
    workspaces: {
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': {
        path: '/storage/emulated/0/DSH/blocked',
        title: 'blocked',
        sessionIds: [blockedId],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  },
}
sync.workspaceMap = { [workspaceId]: true }
// A phone project the panel has already shown (its phone id is the target of a
// pairing) but whose workspace is unticked keeps its new conversations on the phone.
const blockedSync = { ...sync, workspaceMap: { [workspaceId]: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, workspaces: { [workspaceId]: false } }
const blockedPush = await unpairedPush(blockedId, blockedWorkspace, blockedSync)
assert.equal(blockedPush.counts.unpaired, 1, 'an unticked workspace keeps new phone conversations out')
assert.ok(blockedPush.lines.some(line => /未勾选工作区/.test(line)))
assert.equal(
  Object.values(readIndex(indexFile).index.tables.workspaces).some(workspace => workspace.sessionIds.includes(blockedId)),
  false,
  'and nothing is registered for it',
)
const allowedPush = await unpairedPush(blockedId, blockedWorkspace, { ...blockedSync, workspaces: { [workspaceId]: true } })
assert.equal(allowedPush.counts.imported, 1, 'ticking the workspace lets them in')
console.log('ok  the workspace switch holds new phone conversations back')

// A conversation this machine already holds is a mirror coming home: it rejoins
// its project even while the switch is off (it is not a new project at all).
const returningPush = await unpairedPush(seedCandidate.id, phoneOtherIndex, { ...sync, workspaces: {} })
assert.equal(returningPush.counts.imported + returningPush.counts.identical + returningPush.counts['kept-local'] + returningPush.counts.diverged, 1)
assert.equal(
  Object.values(readIndex(indexFile).index.tables.workspaces).some(
    workspace => workspace.title === 'Phone Project',
  ),
  true,
  'and no duplicate "Phone Project" folder is invented for it',
)
console.log('ok  a mirrored conversation rejoins its home project instead of duplicating')

/* ------------------------------------------- phone → desktop landing map */

// The panel lists the phone's own workspaces and lets the user choose which
// desktop workspace each one lands in. That pairing is stored as
// `phone:<phone id> → <desktop id>` and wins over the default
// `<desktopRoot>/<title>`.
sync.workspaceMap = { [workspaceId]: true }
const landingId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const landingPath = path.join(work, 'landing-project')
const landingIndex = readIndex(indexFile).index
landingIndex.tables.workspaces[landingId] = {
  path: landingPath,
  title: 'landing project',
  sessionIds: [],
  createdAt: nowIso,
  updatedAt: nowIso,
}
landingIndex.global.workspaceIds.push(landingId)
writeIndex(indexFile, landingIndex, { backup: false })
sync.workspaces = { [workspaceId]: true, [landingId]: true }
sync.workspaceMap = { [landingId]: phoneOtherId, [`phone:${phoneOtherId}`]: landingId }
const landedByChoice = 'cccccccc-1111-4111-8111-cccccccccccc'
await unpairedPush(landedByChoice, phoneOtherIndex, sync)
const landedWorkspace = Object.values(readIndex(indexFile).index.tables.workspaces)
  .find(workspace => workspace.sessionIds.includes(landedByChoice))
assert.equal(landedWorkspace.path, landingPath, 'the phone workspace lands in the desktop workspace chosen for it')
console.log('ok  a phone workspace lands in the desktop workspace picked for it')

// The same conversation stays put when the chosen workspace is unticked, and
// the pairing is kept (unticking is not "forget where it belongs").
const blockedLanding = await unpairedPush(
  'dddddddd-1111-4111-8111-dddddddddddd',
  { ...phoneOtherIndex, tables: { workspaces: { [phoneOtherId]: { ...phoneOtherIndex.tables.workspaces[phoneOtherId], sessionIds: ['dddddddd-1111-4111-8111-dddddddddddd'] } } } },
  { ...sync, workspaces: { [landingId]: false } },
)
assert.equal(blockedLanding.counts.unpaired, 1, 'an unticked landing workspace keeps the conversation on the phone')
assert.equal(sync.workspaceMap[`phone:${phoneOtherId}`], landingId, 'the landing choice is not dropped by an import')

// The reverse helper keeps the two directions in separate keys.
setPhoneWorkspaceMap(sync, phoneOtherId, landingId)
assert.equal(desktopForPhone(sync, phoneOtherId), landingId)
assert.equal(sync.workspaceMap[phoneOtherId], undefined, 'the phone key never collides with a desktop key')
assert.equal(setPhoneWorkspaceMap(sync, phoneOtherId, ''), '')
assert.equal(desktopForPhone(sync, phoneOtherId), null, 'clearing falls back to the default folder')
console.log('ok  the phone → desktop landing map round-trips on its own key')

/* ------------------------------------------------------- profile merge unit */

const before = `${JSON.stringify({
  name: 'p',
  dsh: { profile: { bundles: ['a'] } },
  dependencies: { b: '1.0.0' },
}, null, 2)}\n`
const merged = registerBundles(before, ['b', 'c', 'a'])
assert.deepEqual(merged.added, ['b', 'c'], 'only the missing bundles are added; the existing one is not duplicated')
assert.deepEqual(merged.present, ['a'], 'a bundle already listed is reported as present')
assert.deepEqual(JSON.parse(merged.text).dsh.profile.bundles, ['a', 'b', 'c'], 'every requested bundle ends up listed')
assert.deepEqual(JSON.parse(merged.text).dependencies, { b: '1.0.0' }, 'dependencies are never rewritten')
assert.match(merged.text, /\n$/, 'the file keeps a trailing newline')
assert.deepEqual(registerBundles(merged.text, ['b', 'c']).added, [], 'a second merge is a no-op')
assert.equal(registerBundles('not json', ['a']).error !== null, true, 'garbage is reported, not thrown')
console.log('ok  profile registration is additive and idempotent')

fs.rmSync(work, { recursive: true, force: true })
console.log('\nALL TRANSFER CHECKS PASSED')
