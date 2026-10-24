/**
 * Serves the plugin's LAN listener for the shell-script test.
 * Prints the base URL and token, then stays up until killed.
 *
 * Usage: node test/fixture.mjs <workdir> <port>
 *
 * The throwaway desktop home is deliberately *complete* rather than minimal:
 * a profile that composes bundles (so `activeProfile()` resolves it without an
 * explicit `profileDir`), one installable demo plugin, one bundle skill and one
 * flat skill, and one real session registered in a `workspace.json`. That is the
 * smallest home in which a pull exercises every channel the phone script has.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createController } from '../lib/controller.js'

const work = process.argv[2] ?? path.join(os.tmpdir(), 'dsh-mobile-sync-shell')
const port = Number(process.argv[3] ?? 8799)
const home = path.join(work, 'desktop-home')
const sessions = path.join(home, 'sessions')
fs.mkdirSync(sessions, { recursive: true })

/* ---------------------------------------------------------------- profile */

// `activeProfile()` looks for `<home>/profiles/<name>/package.json` and prefers
// the one whose `dsh.profile.bundles` is an array. The controller is created
// below *without* `profileDir`, so this file is what makes the plugin and patch
// channels reachable at all.
const profile = path.join(home, 'profiles', 'desktop')
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(
  path.join(profile, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-fixture',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-demo'] } },
      dependencies: {
        '@deepseek-ai/dsh-base': '^0.1.0',
        'dsh-demo': '1.2.3',
      },
    },
    null,
    2,
  )}\n`,
)

// One plugin the phone can actually install: no native artifacts, no runtime
// dependencies, and a `dsh.bundle` field so it is a bundle rather than an
// ordinary package.
const plugin = path.join(profile, 'node_modules', 'dsh-demo')
fs.mkdirSync(plugin, { recursive: true })
fs.writeFileSync(
  path.join(plugin, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-demo',
      version: '1.2.3',
      description: 'A fixture bundle the phone round trip installs.',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    },
    null,
    2,
  )}\n`,
)
fs.writeFileSync(path.join(plugin, 'index.js'), "export const name = 'dsh-demo'\nexport function apply() {}\n")

// A patch layer the models channel would merge into — present so the channel has
// something to read if a test turns it on.
fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n')

/* ----------------------------------------------------------------- skills */

const skillDir = path.join(home, 'skills', 'desk-skill')
fs.mkdirSync(skillDir, { recursive: true })
fs.writeFileSync(
  path.join(skillDir, 'SKILL.md'),
  '---\nname: desk-skill\ndescription: A bundle skill that only exists on the desktop fixture.\n---\n\n# desk-skill\n\nUse this when the fixture needs a bundle-shaped skill.\n',
)
fs.writeFileSync(
  path.join(home, 'skills', 'desk-flat.md'),
  '---\nname: desk-flat\ndescription: A flat skill that only exists on the desktop fixture.\n---\n\n# desk-flat\n\nOne Markdown file, installed as itself.\n',
)

// Keep the real `~/.agents/skills` out of this home: a machine with a busy
// agents root would otherwise decide how many skills a pull carries.
process.env.DSH_AGENTS_HOME = path.join(home, 'agents-home')

/* --------------------------------------------------------------- sessions */

// A real log, copied under its own id: the engine (and this plugin) only treats
// `<project>/session-<uuid>/` as a session, so the fixture has to use a genuine
// id shape or the pull would carry no session at all. `planPull` filters on that
// shape, and older stores still hold plain-uuid directories beside the new ones,
// hence the explicit check rather than "first entry that starts with session-".
const REAL_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
const REAL_PROJECT = path.join(REAL_ROOT, '--D-code-dsh-android-Conversation~0020sync--')
const SESSION_SHAPE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const id = fs.readdirSync(REAL_PROJECT).find((name) => SESSION_SHAPE.test(name))
if (id === undefined) throw new Error(`no session-<uuid> directory under ${REAL_PROJECT}`)
const realFile = fs.readdirSync(path.join(REAL_PROJECT, id)).find((name) => name.endsWith('.zstd'))
const project = '--D-code-fixture-project--'
const dir = path.join(sessions, project, id)
fs.mkdirSync(dir, { recursive: true })
fs.copyFileSync(path.join(REAL_PROJECT, id, realFile), path.join(dir, 'session.v4.jsonl.zstd'))

// Register it: a session that is on disk but in no workspace is invisible, and
// `planPull` walks the index rather than the sessions root.
const workspaceId = '0f1e2d3c-4b5a-4979-8877-665544332211'
const now = new Date().toISOString()
fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
fs.writeFileSync(
  path.join(home, 'storages', 'workspace.json'),
  `${JSON.stringify(
    {
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
            path: 'D:\\code\\fixture-project',
            title: 'fixture-project',
            sessionIds: [id],
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    },
    null,
    2,
  )}\n`,
)

/* ------------------------------------------------------------- controller */

// Pre-seed the state so the fake desktop never writes outside its own home:
// `desktopRoot` is where a push *creates* workspaces, and `mode: root` makes the
// phone's path mapping address `desktopRoot` rather than reusing whatever
// absolute path the fake index happens to name. (A workspace path inside the
// temp tree would also be filtered out as a scratch workspace by `planPull`,
// which is why the index below names a plausible project path instead.)
const FIXTURE_TOKEN = '0123456789abcdef0123456789abcdef'
const stateDir = path.join(home, 'dsh-mobile-sync')
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(
  path.join(stateDir, 'state.json'),
  `${JSON.stringify(
    {
      token: FIXTURE_TOKEN,
      port,
      preferred: null,
      log: [],
      imported: {},
      sync: {
        channels: { sessions: true, models: false, plugins: true, skills: true },
        // Per-item defaults are off in this build, so the round trip has to tick
        // the fixture's own plugin and both skills explicitly — which is exactly
        // what a user does on first run.
        plugins: { 'dsh-demo': true },
        skills: { 'desk-skill': true, 'desk-flat': true },
        models: {},
        mode: 'root',
        includeArchived: false,
        defaultsRev: 2,
        desktopRoot: path.join(home, 'DSH'),
      },
      peer: null,
    },
    null,
    2,
  )}\n`,
)

// No `profileDir`: resolving it through `activeProfile()` is part of what the
// fixture proves.
const controller = createController({ home, sessionsRoot: sessions, logger: console, deviceName: 'SHELL-TEST' })
const live = await controller.start('0.0.0.0')
const status = controller.status()
console.log(`READY ${status.urls[0]} ${status.token} ${live.port}`)

// Test-only: arm the panel's「开始同步」request after a delay, so the shell round
// trip can prove the phone waits for the button instead of syncing on download.
const armAfter = Number.parseInt(process.env.DSH_FIXTURE_ARM_MS ?? '', 10)
if (Number.isFinite(armAfter) && armAfter > 0) {
  setTimeout(() => {
    controller.act({ action: 'request-sync' }).catch(() => {})
  }, armAfter).unref()
}

process.on('SIGTERM', async () => {
  await controller.stop()
  process.exit(0)
})
