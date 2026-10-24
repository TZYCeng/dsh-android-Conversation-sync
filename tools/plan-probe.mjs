/**
 * Dry-run the next pull, read-only, against the real `$DSH_HOME`.
 *
 * Answers "what would the phone actually receive, and how big is that" without a
 * phone: it runs the same planner the listener runs, archives the result in
 * memory (so the size is the real gzip size) and prints the plan. A second run
 * with `--peer` on the same machine shows the "nothing changed" case.
 *
 * Usage:
 *   node tools/plan-probe.mjs [DSH_HOME] [--peer]
 *
 * `--peer` pretends the phone already reported everything this desktop would
 * send (versions, skill digests, session sizes), which is what a second sync
 * looks like.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { activeProfile, createController } from '../lib/controller.js'
import { normalizeSync } from '../lib/channels.js'
import { planPull } from '../lib/transfer.js'
import { listPlugins } from '../lib/plugins.js'
import { listSkills } from '../lib/skills.js'
import { listModels } from '../lib/models.js'
import { pack } from '../lib/tar.js'

const args = process.argv.slice(2)
const home = args.find(arg => !arg.startsWith('--')) ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const pretendPeer = args.includes('--peer')

const profile = activeProfile(home)
const sessionsRoot = path.join(home, 'sessions')
const indexFile = path.join(home, 'storages', 'workspace.json')
const skillsRoot = path.join(home, 'skills')
const agentsRoot = process.env.DSH_AGENTS_HOME ?? path.join(os.homedir(), '.agents')

const controller = createController({
  home,
  sessionsRoot,
  logger: { info() {}, warn() {}, error() {} },
  deviceName: os.hostname(),
})
const status = controller.status()
const catalogs = {
  plugins: profile === null ? [] : listPlugins({ profileDir: profile, skip: ['dsh-mobile-sync'] }),
  skills: listSkills({ home, agentsHome: agentsRoot }),
  models: profile === null
    ? []
    : listModels({ patchFile: path.join(profile, 'cordis.patch.yml'), credentialsFile: path.join(home, '.credentials.yaml') }),
}

const sync = normalizeSync({ channels: status.channels, ...status.sync })

const base = {
  sessionsRoot,
  indexFile,
  sync,
  catalogs,
  credentialsFile: path.join(home, '.credentials.yaml'),
}
const first = planPull({ ...base, peer: {}, peerFiles: {}, sent: {} })

const archive = pack(first.files)
const byKind = (prefix) => first.files.filter(file => file.relative.startsWith(prefix)).length

console.log(`home:      ${home}`)
console.log(`profile:   ${profile ?? '(none)'}`)
console.log(`sessions:  ${first.summary.sessions} to send, ${first.summary.sessionsSame} already current, ` +
  `${first.summary.subagentSkipped} delegated kept home, ${first.summary.archivedSkipped} archived kept home, ` +
  `${first.summary.workspaces} workspaces`)
console.log(`plugins:   ${first.summary.plugins.send.length} to send, ${first.summary.plugins.same.length} same version, ` +
  `${first.summary.plugins.unsupported.length} unsupported, ${first.summary.plugins.off.length} switched off`)
console.log(`skills:    ${first.summary.skills.send.length} to send, ${first.summary.skills.same.length} same content, ` +
  `${first.summary.skills.off.length} switched off`)
console.log(`models:    ${first.summary.models.send} to send (${catalogs.models.length} rows available)`)
console.log(`files:     ${first.files.length} entries ` +
  `(${byKind('sessions/')} sessions, ${byKind('_meta/plugins/')} plugin files, ${byKind('_meta/skills/')} skill files)`)
console.log(`archive:   ${(archive.length / 1024 / 1024).toFixed(2)} MB gzipped`)
console.log('\nplan:')
for (const line of first.lines) console.log(`  ${line}`)

if (pretendPeer) {
  // Reconstruct what the phone would report right after applying that archive,
  // then plan again: this is the "same version / same content / same bytes"
  // path the user asked for.
  const bundles = catalogs.plugins
    .filter(item => item.installable === true && item.bundle === true)
    .map(item => item.name)
  const phoneProfile = `${JSON.stringify({
    name: 'phone-profile',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...bundles] } },
    dependencies: {},
  }, null, 2)}\n`
  const sent = first.files
    .filter(file => file.relative.startsWith('sessions/'))
    .map(file => `${file.relative.split('/')[2]} ${Buffer.byteLength(file.data)}`)
    .join('\n')
  const second = planPull({
    ...base,
    peer: {
      device: 'pretend-phone',
      // A phone that already applied the first archive: same plugin versions,
      // same skills, and byte-identical session copies.
      plugins: Object.fromEntries(bundles.map(name => [name, catalogs.plugins.find(item => item.name === name)?.version])),
      skills: catalogs.skills.map(item => item.name),
    },
    peerFiles: {
      index: first.files.find(file => file.relative === '_meta/index.json')?.data.toString('utf8') ?? null,
      profilePackage: phoneProfile,
      patch: null,
      credentials: null,
      sessions: sent.length > 0 ? `${sent}\n` : null,
    },
    sent: first.sent,
  })
  const secondArchive = pack(second.files)
  console.log('\n== second sync (phone already has it) ==')
  console.log(`sessions:  ${second.summary.sessions} to send, ${second.summary.sessionsSame} already current`)
  console.log(`plugins:   ${second.summary.plugins.send.length} to send, ${second.summary.plugins.same.length} same version`)
  console.log(`skills:    ${second.summary.skills.send.length} to send, ${second.summary.skills.same.length} same content`)
  console.log(`archive:   ${(secondArchive.length / 1024).toFixed(1)} KB gzipped`)
  for (const line of second.lines) console.log(`  ${line}`)
}
