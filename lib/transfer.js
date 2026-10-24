/**
 * The two directions of a sync, as pure planning over files.
 *
 * `ingestPush` takes what the phone uploaded and folds it into the desktop
 * store; `planPull` decides what the phone should receive and returns the exact
 * file list to archive. Neither one knows about HTTP, tokens or the panel — the
 * controller takes their result and ships it.
 *
 * The phone is deliberately a dumb mover: it has `curl`, `tar` and `sh`, but no
 * Node, no `jq` and no YAML. Everything the phone applies is therefore *derived
 * from the archive layout alone* — these files go to those directories — and the
 * only metadata it sends back is plain `key=value` / `name version` text:
 *
 *   push:  --<slug>--/<session>/session.v4.jsonl.zstd   session logs
 *          _meta/phone.env                             key=value facts about the phone
 *          _meta/plugins.txt                           "<name> <version>" per installed plugin
 *          _meta/skills.txt                            one installed skill name per line
 *          _meta/index.json                            the phone's workspace.json
 *          _meta/profile/package.json                  the phone profile's package.json
 *          _meta/patch/cordis.patch.yml                the phone's patch layer (models channel)
 *          _meta/patch/credentials.yaml                the phone's credentials (secrets opt-in)
 *
 *   pull:  sessions/<phone-slug>/<session>/session.v4.jsonl.zstd
 *          _meta/index.json                            index the phone installs verbatim
 *          _meta/profile/package.json                  profile package.json, already merged
 *          _meta/plugins/<name>/...                    one directory per plugin to install
 *          _meta/skills/<name>/... or <name>.md        one entry per skill to install
 *          _meta/patch/cordis.patch.yml                patch layer, already merged
 *          _meta/patch/credentials.yaml                credentials, already merged
 *          _meta/readme.txt                            what just happened, in plain text
 *
 * @module lib/transfer
 */
import fs from 'node:fs'
import path from 'node:path'

import { selected } from './channels.js'
import {
  SESSION_ID,
  addSessions,
  emptyIndex,
  isScratchWorkspace,
  mapDesktopWorkspace,
  mapWorkspace,
  normalizeIndex,
  readIndex,
  upsertWorkspace,
  writeIndex,
} from './index-sync.js'
import { mergeOne, rewriteCwd, scan, verifyLog } from './sessions.js'
import { baseName, slugOf } from './slug.js'
import { atLeast, isNewer } from './version.js'
import { readPlugin } from './plugins.js'
import { readSkill } from './skills.js'
import { buildMergedCredentials, buildMergedPatch, credentialRefs } from './models.js'
import { digestText } from './patch.js'

/** Everything the phone uploads as metadata lives below this prefix. */
const META = '_meta/'
/** One pull may carry at most this much plugin payload. */
const PLUGIN_BUDGET = 48 * 1024 * 1024
/** One pull may carry at most this much skill payload. */
const SKILL_BUDGET = 8 * 1024 * 1024

/* -------------------------------------------------------------- phone text */

/**
 * Parse the phone's `key=value` report.
 *
 * Values are taken verbatim (paths may contain `=`, so only the first one
 * splits); unknown keys are kept for forward compatibility, and a line without
 * `=` is ignored.
 *
 * @param text - the file's contents.
 * @returns a plain object of string values.
 */
export function parseEnv(text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.replace(/\r$/u, '')
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1)
    if (key.length > 0) out[key] = value
  }
  return out
}

/**
 * Parse `<name> <version>` lines into a map.
 * @param text - the phone's `_meta/plugins.txt`.
 */
export function parseVersions(text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.replace(/\r$/u, '').trim().split(/\s+/u)
    if (parts.length === 0 || parts[0].length === 0) continue
    out[parts[0]] = parts[1] ?? ''
  }
  return out
}

/**
 * Parse one-name-per-line text.
 * @param text - the phone's `_meta/skills.txt`.
 * @returns a list of names, duplicates dropped.
 */
export function parseNames(text) {
  const seen = new Set()
  for (const line of String(text ?? '').split('\n')) {
    const name = line.replace(/\r$/u, '').trim()
    if (name.length > 0) seen.add(name)
  }
  return [...seen]
}

/**
 * Parse the phone's `<session-id> <bytes>` inventory.
 *
 * This is what makes a repeat pull cheap: a mirrored log is byte-for-byte what
 * the desktop sent, so an equal size means there is nothing to transfer. A
 * missing or unparsable line simply means "unknown", and that session is sent.
 *
 * @param text - the phone's `_meta/sessions.txt`.
 * @returns a map from session id to its byte size on the phone.
 */
export function parseSizes(text) {
  const out = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.replace(/\r$/u, '').trim().split(/\s+/u)
    if (parts.length !== 2) continue
    const size = Number.parseInt(parts[1], 10)
    if (!Number.isFinite(size) || size < 0) continue
    out.set(parts[0], size)
  }
  return out
}

/* ---------------------------------------------------------------- peer files */

/** Names of the cached peer files, under `<state>/peer/`. */
const PEER_FILES = {
  index: 'index.json',
  profilePackage: 'package.json',
  patch: 'cordis.patch.yml',
  credentials: 'credentials.yaml',
  sessions: 'sessions.txt',
}

/**
 * Persist what the phone reported, so a pull can run without a fresh push.
 *
 * These files are inputs, not bookkeeping: a pull merges the desktop's plugins
 * and model rows *into* them, which is what keeps the phone's own edits intact.
 *
 * @param dir - the plugin's `peer` cache directory.
 * @param parts - `{ index?, profilePackage?, patch?, credentials? }` as text.
 */
export function savePeerFiles(dir, parts) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [key, name] of Object.entries(PEER_FILES)) {
    const value = parts[key]
    const file = path.join(dir, name)
    if (typeof value === 'string') {
      fs.writeFileSync(file, value)
    } else if (fs.existsSync(file)) {
      // A channel that is now off must not leave a stale input behind: a pull
      // would otherwise merge into last week's copy.
      fs.rmSync(file, { force: true })
    }
  }
}

/**
 * Read the cached peer files back.
 * @param dir - the plugin's `peer` cache directory.
 * @returns `{ index, profilePackage, patch, credentials }` — null when absent.
 */
export function loadPeerFiles(dir) {
  const out = { index: null, profilePackage: null, patch: null, credentials: null, sessions: null }
  for (const [key, name] of Object.entries(PEER_FILES)) {
    try {
      out[key] = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch (_error) {
      out[key] = null
    }
  }
  return out
}

/**
 * Split unpacked archive entries into session logs and metadata.
 *
 * A session log is exactly `<project>/<session>/<file>`; everything else at the
 * top level of a push is either metadata (below `_meta/`) or noise.
 *
 * @param entries - `{ relative, data }` items from `unpack()`.
 * @returns `{ sessions, meta, skipped }`; `meta` is keyed by the path below `_meta/`.
 */
export function splitPush(entries) {
  const sessions = []
  const meta = new Map()
  const skipped = []
  for (const entry of entries) {
    const relative = String(entry.relative ?? '').replace(/^\/+/u, '')
    if (relative.startsWith(META)) {
      const key = relative.slice(META.length)
      if (key.length > 0) meta.set(key, entry.data)
      continue
    }
    const parts = relative.split('/')
    if (parts.length === 3 && parts.every(part => part.length > 0 && part !== '.' && part !== '..')) {
      sessions.push({ relative, data: entry.data })
    } else {
      skipped.push(relative)
    }
  }
  return { sessions, meta, skipped }
}

/* ------------------------------------------------------------- profile json */

/**
 * Register plugin bundles in a profile's `package.json`, preserving everything
 * else about it.
 *
 * The bundles list is what makes a bundle part of the composed tree, so this is
 * the only edit the phone profile ever needs from a sync. A package that is
 * still listed in `dependencies` is untouched: rewriting a dependency spec
 * would point the profile's package manager at a version the phone cannot
 * resolve.
 *
 * @param original - the phone's current `package.json` text.
 * @param names - bundle package names to ensure are listed.
 * @returns `{ text, added, present, error }` — `text` is null when unparseable.
 */
export function registerBundles(original, names) {
  let parsed
  try {
    parsed = JSON.parse(String(original ?? ''))
  } catch (error) {
    return { text: null, added: [], present: [], error: String(error?.message ?? error) }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { text: null, added: [], present: [], error: 'profile package.json is not an object' }
  }
  if (parsed.dsh === null || typeof parsed.dsh !== 'object') parsed.dsh = {}
  if (parsed.dsh.profile === null || typeof parsed.dsh.profile !== 'object') parsed.dsh.profile = {}
  if (!Array.isArray(parsed.dsh.profile.bundles)) parsed.dsh.profile.bundles = []

  const list = parsed.dsh.profile.bundles
  const added = []
  const present = []
  for (const name of names ?? []) {
    if (typeof name !== 'string' || name.length === 0) continue
    if (list.includes(name)) {
      present.push(name)
      continue
    }
    list.push(name)
    added.push(name)
  }
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, added, present, error: null }
}

/* ------------------------------------------------------------------- push */

/**
 * The workspace a phone session belongs to, as the phone's index reports it.
 *
 * Falls back to the log's own header when the phone sent no index (an old
 * script, or a session the phone's index does not list yet) — the header's
 * `cwd` is the one fact every log carries.
 *
 * @param phoneIndex - the phone's index, or null.
 * @param id - session id.
 * @param header - the verified header of the incoming log.
 * @returns `{ id, path, title }` — `id`/`path` may be null when nothing is known.
 */
function phoneWorkspaceOf(phoneIndex, id, header) {
  if (phoneIndex !== null) {
    for (const [workspaceId, workspace] of Object.entries(phoneIndex.tables.workspaces)) {
      if (!workspace.sessionIds.includes(id)) continue
      if (typeof workspace.path === 'string' && workspace.path.length > 0) {
        return { id: workspaceId, path: workspace.path, title: workspace.title || baseName(workspace.path) }
      }
    }
  }
  if (typeof header?.cwd === 'string' && header.cwd.length > 0) {
    return { id: null, path: header.cwd, title: baseName(header.cwd) }
  }
  return { id: null, path: null, title: null }
}

/**
 * Fold one phone upload into the desktop store.
 *
 * Every incoming session is relocated into a desktop workspace: an existing
 * workspace with the same title wins ("同名工作区互传"), otherwise one is
 * created under the configured desktop root. The log's header `cwd` is
 * rewritten to that directory so the session resumes where it now lives, and
 * the desktop's workspace index is updated — without that the session would be
 * on disk but invisible in the sidebar.
 *
 * The desktop index is only written when something actually changed, and never
 * when the existing file could not be parsed: replacing a damaged index would
 * hide every session the user has.
 *
 * @param options - `{ sessionsRoot, indexFile, backupDir, sync, entries, device }`.
 * @returns `{ counts, lines, peer, skipped, indexChanged }`.
 */
export function ingestPush(options) {
  const { sessionsRoot, indexFile, backupDir, sync, device } = options
  const { sessions, meta, skipped } = splitPush(options.entries ?? [])

  const peer = {
    device: device ?? '手机',
    info: meta.has('phone.env') ? parseEnv(meta.get('phone.env').toString('utf8')) : {},
    plugins: meta.has('plugins.txt') ? parseVersions(meta.get('plugins.txt').toString('utf8')) : {},
    skills: meta.has('skills.txt') ? parseNames(meta.get('skills.txt').toString('utf8')) : [],
    index: null,
    hasIndex: meta.has('index.json'),
    hasProfile: meta.has('profile/package.json'),
    hasPatch: meta.has('patch/cordis.patch.yml'),
    hasCredentials: meta.has('patch/credentials.yaml'),
    hasSessions: meta.has('sessions.txt'),
  }
  if (peer.hasIndex) {
    try {
      peer.index = normalizeIndex(JSON.parse(meta.get('index.json').toString('utf8')))
    } catch (_error) {
      peer.index = null
    }
  }

  const loaded = readIndex(indexFile)
  const index = loaded.index
  const counts = { imported: 0, 'kept-local': 0, identical: 0, diverged: 0, rejected: 0, ignored: skipped.length, subagent: 0 }
  const lines = []
  let indexChanged = false
  const registered = []

  for (const entry of sessions) {
    const parts = entry.relative.split('/')
    const id = parts[1]
    const header = verifyLog(entry.data)
    // A delegated transcript is the engine's own working note. The desktop does
    // not put those in its sidebar, so importing one would create a row nobody
    // can place — leave it on the phone.
    if (header?.origin === 'subagent') {
      counts.subagent += 1
      continue
    }
    const owner = phoneWorkspaceOf(peer.index, id, header)

    // Where this session should live on the desktop. An explicit workspace
    // pairing from the panel wins; otherwise a workspace the desktop already has
    // wins by title; otherwise the phone's own title is recreated under the
    // desktop root.
    const title = owner.title ?? '手机会话'
    const mapped = mapDesktopWorkspace({
      mode: sync.mode,
      root: sync.desktopRoot,
      phoneWorkspace: { id: owner.id ?? undefined, path: owner.path ?? '', title },
      desktopIndex: index,
      map: sync.workspaceMap ?? {},
    })
    const target = mapped.desktopPath
    const project = slugOf(target)

    let result
    try {
      fs.mkdirSync(target, { recursive: true })
      result = mergeOne(sessionsRoot, { relative: entry.relative, data: entry.data }, backupDir, {
        cwd: target,
        project,
      })
    } catch (error) {
      result = { status: 'rejected', relative: entry.relative, id, reason: String(error?.message ?? error) }
    }
    counts[result.status] = (counts[result.status] ?? 0) + 1

    if (result.status === 'imported' && result.id !== undefined && SESSION_ID.test(result.id)) {
      const workspace = upsertWorkspace(index, { path: target, title })
      const added = addSessions(index, workspace.id, [result.id])
      if (workspace.created || added.length > 0) {
        indexChanged = true
        registered.push({ id: result.id, title, created: workspace.created })
      }
    }

    if (result.status === 'imported') {
      lines.push(`导入 ${title} · ${result.id}${result.replaced !== undefined ? '（覆盖更长版本）' : ''}`)
    } else if (result.status === 'kept-local') {
      lines.push(`保留本机更长版本 ${result.id}`)
    } else if (result.status === 'diverged') {
      lines.push(`内容分叉，保留本机 ${result.id}`)
    } else if (result.status === 'rejected') {
      lines.push(`跳过 ${parts[0]}/${id}（${result.reason ?? '无法识别'}）`)
    }
  }

  if (indexChanged && loaded.error === null) {
    try {
      writeIndex(indexFile, index)
    } catch (error) {
      lines.push(`桌面索引写入失败：${String(error?.message ?? error)}`)
      indexChanged = false
    }
  } else if (indexChanged && loaded.error !== null) {
    lines.push('桌面索引无法解析，本次未写入（请先修复 workspace.json）')
    indexChanged = false
  }

  return { counts, lines, peer, skipped, indexChanged, registered }
}

/* ------------------------------------------------------------------- pull */

/** Human byte size, kept local so this module stays free of view concerns. */
function kb(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Decide what one pull carries.
 *
 * Sessions are packed per phone workspace: the desktop workspace's title picks
 * the phone directory (`auto` reuses a phone workspace with that title, `root`
 * always uses `<root>/<title>`), the log's `cwd` is rewritten to match, and the
 * resulting placement is registered in the phone's index so it is visible there
 * the moment the archive is unpacked.
 *
 * Plugins and skills are one-way (desktop → phone) and only when their channel
 * is on and that item's own switch is on; an item whose version/digest already
 * matches what the phone reported is skipped, which is what makes a second sync
 * cheap. Models ride along as a merged patch file.
 *
 * @param options - `{ sessionsRoot, indexFile, sync, peer, peerFiles, catalogs, now }`.
 * @returns `{ files, summary, lines, sent }`.
 */
export function planPull(options) {
  const { sessionsRoot, indexFile, sync, catalogs } = options
  const peer = options.peer ?? {}
  // A direct caller may pass `undefined` instead of a null entry; treat anything
  // that is not text as "the phone told us nothing", which is the safe reading.
  const asText = value => (typeof value === 'string' && value.length > 0 ? value : null)
  const peerFiles = {
    index: asText(options.peerFiles?.index),
    profilePackage: asText(options.peerFiles?.profilePackage),
    patch: asText(options.peerFiles?.patch),
    credentials: asText(options.peerFiles?.credentials),
    sessions: asText(options.peerFiles?.sessions),
  }
  const now = options.now ?? Date.now()
  const files = []
  const lines = []
  const sent = { plugins: {}, skills: {}, patch: null, credentials: null }

  const desktop = readIndex(indexFile).index
  const phone = peerFiles.index !== null
    ? (() => {
        try {
          return normalizeIndex(JSON.parse(peerFiles.index))
        } catch (_error) {
          return emptyIndex()
        }
      })()
    : emptyIndex()
  // What the phone already holds, by session id and size: the cheap oracle that
  // turns a repeat pull into a near-empty archive.
  const phoneSizes = peerFiles.sessions === null ? new Map() : parseSizes(peerFiles.sessions)

  /* --------------------------------------------------------------- sessions */

  const summary = {
    sessions: 0,
    sessionsSame: 0,
    workspaces: 0,
    archivedSkipped: 0,
    missingSkipped: 0,
    subagentSkipped: 0,
    plugins: { send: [], same: [], newer: [], off: [], unsupported: [], tooBig: [], noProfile: [] },
    skills: { send: [], same: [], off: [], tooBig: [] },
    models: { send: 0, same: 0, total: catalogs?.models?.length ?? 0, channel: sync.channels.models === true, groups: [] },
    secrets: { count: 0, refs: [], missing: [] },
    // Legacy boolean kept for callers that only ask "is the master switch on";
    // the object above reports what actually travels.
    secretsOn: sync.secrets === true,
    bytes: 0,
  }

  if (sync.channels.sessions === true) {
    // One walk of the store, keyed by session id: the planner needs each log's
    // file, size and origin, and asking `findSession` per candidate would
    // re-list every project directory once per session.
    const onDisk = new Map()
    for (const entry of scan(sessionsRoot)) {
      if (!onDisk.has(entry.id)) onDisk.set(entry.id, entry)
    }
    const archived = new Set(desktop.global.archivedSessionIds)
    let firstWorkspaceId = null
    for (const [workspaceId, workspace] of Object.entries(desktop.tables.workspaces)) {
      if (isScratchWorkspace(workspace.path)) continue
      const wanted = workspace.sessionIds.filter((id) => {
        if (!SESSION_ID.test(id)) return false
        if (archived.has(id) && sync.includeArchived !== true) {
          summary.archivedSkipped += 1
          return false
        }
        return true
      })
      if (wanted.length === 0 && workspace.sessionIds.length > 0) continue

      const mapped = mapWorkspace({
        mode: sync.mode,
        root: sync.phoneRoot,
        workspace: { ...workspace, id: workspaceId },
        phoneIndex: phone,
        map: sync.workspaceMap ?? {},
      })
      const phonePath = mapped.phonePath
      const project = slugOf(phonePath)
      const packed = []
      for (const id of wanted) {
        const found = onDisk.get(id)
        if (found === undefined) {
          summary.missingSkipped += 1
          continue
        }
        // A delegated transcript is the engine's own scratch: it never had a
        // sidebar row on this machine, so mirroring it would only clutter the
        // phone with rows nobody can place.
        if (found.origin === 'subagent') {
          summary.subagentSkipped += 1
          continue
        }
        let data
        try {
          data = fs.readFileSync(path.join(sessionsRoot, ...found.relative.split('/')))
        } catch (_error) {
          summary.missingSkipped += 1
          continue
        }
        // The mirror must claim the phone's directory, or resuming it there
        // would start in a directory that does not exist.
        const rewritten = rewriteCwd(data, phonePath)
        const outgoing = rewritten ?? data
        // A mirrored log is byte-for-byte what this desktop sent last time, so an
        // equal size on the phone means the transfer can be skipped. The size is
        // of the *rewritten* bytes, which is exactly what the phone stored.
        if (sync.force !== true && phoneSizes.get(id) === outgoing.length) {
          summary.sessionsSame += 1
          packed.push(id)
          continue
        }
        files.push({
          relative: `sessions/${project}/${id}/${found.relative.split('/').pop()}`,
          data: outgoing,
          mtime: found.mtime,
        })
        packed.push(id)
        summary.sessions += 1
        summary.bytes += outgoing.length
      }
      if (packed.length === 0) continue
      const target = upsertWorkspace(phone, { path: phonePath, title: mapped.title })
      addSessions(phone, target.id, packed)
      if (firstWorkspaceId === null) firstWorkspaceId = target.id
      summary.workspaces += 1
    }

    // A phone whose index has no default workspace cannot start a new session
    // in a sensible place, so pick the first one we just registered.
    if (phone.global.defaultWorkspaceId === undefined && firstWorkspaceId !== null) {
      phone.global.defaultWorkspaceId = firstWorkspaceId
    }
    // The index is only worth shipping when it says something new. Sending a
    // skeleton over a phone index we never received would hide every session the
    // phone already had, so that case is skipped outright.
    const indexWorthSending = summary.sessions > 0 || peerFiles.index !== null
    if (indexWorthSending) {
      phone.unit = { ...phone.unit, name: 'workspace', version: phone.unit?.version ?? 2 }
      files.push({
        relative: '_meta/index.json',
        data: `${JSON.stringify(phone, null, 2)}\n`,
      })
    }
    lines.push(
      `会话：下发 ${summary.sessions} 个 / ${summary.workspaces} 个工作区` +
        (summary.sessionsSame > 0 ? `，手机已是最新 ${summary.sessionsSame} 个` : '') +
        (summary.subagentSkipped > 0 ? `，跳过子代理 ${summary.subagentSkipped} 个` : '') +
        (summary.archivedSkipped > 0 ? `，跳过已归档 ${summary.archivedSkipped} 个` : '') +
        (summary.missingSkipped > 0 ? `，文件缺失 ${summary.missingSkipped} 个` : ''),
    )
  } else {
    lines.push('会话：通道已关闭')
  }

  /* ---------------------------------------------------------------- plugins */

  if (sync.channels.plugins === true) {
    const plugins = catalogs?.plugins ?? []
    const phoneVersions = peer.plugins ?? {}
    const profileText = peerFiles.profilePackage
    let budget = PLUGIN_BUDGET
    const bundles = []
    for (const plugin of plugins) {
      // Capability comes before choice: an item that cannot be loaded on a phone
      // is reported as unsupported even when nobody has ticked it, because a
      // switch the user cannot meaningfully flip should not look like "off".
      if (plugin.installable !== true) {
        summary.plugins.unsupported.push(plugin.name)
        continue
      }
      if (plugin.bundle !== true) {
        summary.plugins.unsupported.push(plugin.name)
        plugin.reason = '不是 bundle，无法在手机上自动注册'
        continue
      }
      const on = selected(sync.plugins, plugin.name, false)
      if (!on) {
        summary.plugins.off.push(plugin.name)
        continue
      }
      if (profileText === null) {
        summary.plugins.noProfile.push(plugin.name)
        continue
      }
      // Never downgrade: a phone that already carries the same version needs
      // nothing, and one that carries a newer build must not be rolled back.
      if (sync.force !== true && atLeast(phoneVersions[plugin.name], plugin.version)) {
        if (isNewer(phoneVersions[plugin.name], plugin.version)) {
          summary.plugins.newer.push(plugin.name)
        } else {
          summary.plugins.same.push(plugin.name)
        }
        continue
      }
      if (plugin.bytes > budget) {
        summary.plugins.tooBig.push(plugin.name)
        continue
      }
      const read = readPlugin(plugin.dir, { maxBytes: budget })
      if (read.truncated) {
        summary.plugins.tooBig.push(plugin.name)
        continue
      }
      budget -= read.bytes
      for (const file of read.files) {
        files.push({ relative: `_meta/plugins/${plugin.name}/${file.relative}`, data: file.data })
      }
      bundles.push(plugin.name)
      summary.plugins.send.push({ name: plugin.name, version: plugin.version, bytes: read.bytes })
      summary.bytes += read.bytes
      sent.plugins[plugin.name] = { version: plugin.version, at: now }
      lines.push(`插件下发 ${plugin.name}@${plugin.version ?? '?'}（${kb(read.bytes)}）`)
    }

    if (summary.plugins.noProfile.length > 0) {
      lines.push('插件：手机还没有上报 profile，先在手机上跑一次推送')
    }

    // The bundle list has to include everything already registered plus what we
    // are sending, or the phone would drop an earlier sync's plugin.
    if (profileText !== null) {
      const merged = registerBundles(profileText, bundles)
      if (merged.error !== null) {
        lines.push(`手机 profile 无法解析，插件未注册：${merged.error}`)
      } else if (merged.added.length > 0) {
        files.push({ relative: '_meta/profile/package.json', data: merged.text })
        lines.push(`手机 profile 注册 ${merged.added.length} 个 bundle`)
      }
    }
    if (summary.plugins.same.length > 0) {
      lines.push(`插件：版本相同跳过 ${summary.plugins.same.length} 个`)
    }
    if (summary.plugins.newer.length > 0) {
      lines.push(`插件：手机上的版本更新，未降级 ${summary.plugins.newer.length} 个`)
    }
    if (summary.plugins.unsupported.length > 0) {
      lines.push(`插件：不支持 ${summary.plugins.unsupported.length} 个（原生依赖或缺少注册信息）`)
    }
    if (summary.plugins.tooBig.length > 0) {
      lines.push(`插件：超出体积预算跳过 ${summary.plugins.tooBig.length} 个`)
    }
  } else {
    lines.push('插件：通道已关闭')
  }

  /* ----------------------------------------------------------------- skills */

  if (sync.channels.skills === true) {
    const skills = catalogs?.skills ?? []
    const phoneNames = new Set(peer.skills ?? [])
    let budget = SKILL_BUDGET
    for (const skill of skills) {
      const on = selected(sync.skills, skill.name, false)
      if (!on) {
        summary.skills.off.push(skill.name)
        continue
      }
      // Content-addressed skip: same bytes already sent and still present on the
      // phone means there is nothing to prove by sending it again.
      const last = options.sent?.skills?.[skill.name]
      if (sync.force !== true && phoneNames.has(skill.name) && last?.digest === skill.digest) {
        summary.skills.same.push(skill.name)
        continue
      }
      if (skill.bytes > budget) {
        summary.skills.tooBig.push(skill.name)
        continue
      }
      const read = readSkill(skill, { maxBytes: budget })
      if (read.truncated) {
        summary.skills.tooBig.push(skill.name)
        continue
      }
      budget -= read.bytes
      for (const file of read.files) {
        files.push({ relative: `_meta/skills/${file.relative}`, data: file.data })
      }
      summary.skills.send.push({ name: skill.name, bytes: read.bytes, kind: skill.kind })
      summary.bytes += read.bytes
      sent.skills[skill.name] = { digest: skill.digest, at: now }
      lines.push(`技能下发 ${skill.name}（${kb(read.bytes)}）`)
    }
    if (summary.skills.same.length > 0) {
      lines.push(`技能：内容相同跳过 ${summary.skills.same.length} 个`)
    }
    if (summary.skills.tooBig.length > 0) {
      lines.push(`技能：超出体积预算跳过 ${summary.skills.tooBig.length} 个`)
    }
  } else {
    lines.push('技能：通道已关闭')
  }

  /* ----------------------------------------------------------------- models */

  if (sync.channels.models === true) {
    // One switch per model group (a whole endpoint row, or one provider inside
    // `config.providers`). Nothing is ticked by default, like plugins and skills.
    const groups = (catalogs?.models ?? []).filter(group => selected(sync.models, group.key ?? group.id, false))
    summary.models.total = catalogs?.models?.length ?? 0
    if (groups.length === 0) {
      lines.push('模型：没有勾选任何模型组，未下发')
    } else if (peerFiles.patch === null) {
      lines.push('模型：手机还没有上报 patch 文件，先推送一次')
    } else {
      const merged = buildMergedPatch(peerFiles.patch, groups)
      if (typeof merged.text !== 'string') {
        lines.push(`模型：patch 合并失败（${merged.error ?? '未知原因'}）`)
      } else if (digestText(peerFiles.patch) !== merged.digest) {
        files.push({ relative: '_meta/patch/cordis.patch.yml', data: merged.text })
        summary.models.send = groups.length
        summary.models.groups = groups.map(group => group.key ?? group.id)
        sent.patch = { digest: merged.digest, at: now }
        const pluginBacked = groups.filter(group => group.source === 'plugin').length
        lines.push(
          `模型：下发 ${groups.length} 个模型组` +
            (pluginBacked > 0 ? `（其中 ${pluginBacked} 个由插件提供，手机需装对应插件）` : ''),
        )
      } else {
        summary.models.same = groups.length
        lines.push('模型：与手机一致，跳过')
      }

      // Keys travel with their group. `llm-pi-ai` only reads a key from the
      // credentials store or the launch snapshot and throws MISSING_CREDENTIAL
      // otherwise, so shipping a provider without its ref leaves the phone with
      // a model it cannot call.
      const keyRoots = groups.filter(group => keyWanted(sync, group))
      const refs = refsNeeded(keyRoots)
      const heldBack = groups.filter(group => !keyWanted(sync, group)).flatMap(group => group.keys ?? [])
      if (heldBack.length > 0) {
        lines.push(`密钥：${[...new Set(heldBack)].join('、')} 未下发（该组的密钥开关关着，手机需自行填写）`)
      }
      if (refs.length === 0) {
        // Keyless endpoints (a local gateway) need no credential work at all.
      } else if (sync.secrets !== true) {
        lines.push('密钥：未同步（「同步 API 密钥」总开关关着；密钥需在手机上自行填写）')
      } else {
        // A phone that never uploaded its credentials still needs a *complete*
        // document: `refs:` alone is rejected by the store. Start from a
        // skeleton instead of skipping the file.
        const phoneText = peerFiles.credentials ?? 'version: 1\n'
        const secret = buildMergedCredentials(phoneText, refs, options.credentialsFile)
        if (typeof secret.text !== 'string') {
          lines.push(`密钥：合并失败（${secret.error ?? '未知原因'}）`)
        } else if (peerFiles.credentials === null || digestText(peerFiles.credentials) !== secret.digest) {
          files.push({ relative: '_meta/patch/credentials.yaml', data: secret.text })
          sent.credentials = { digest: secret.digest, at: now }
          summary.secrets.count = refs.length
          summary.secrets.refs = refs
          summary.secrets.missing = missingRefs(refs, options.credentialsFile)
          lines.push(`密钥：下发 ${refs.length} 个引用（明文 LAN 传输）`)
          if (summary.secrets.missing.length > 0) {
            lines.push(`密钥：电脑上缺 ${summary.secrets.missing.join('、')}，手机可能仍报「没有 key」`)
          }
        } else {
          lines.push('密钥：与手机一致，跳过')
        }
      }
    }
  } else {
    lines.push('模型：通道已关闭')
  }

  /* ---------------------------------------------------------------- readme */

  files.push({
    relative: '_meta/readme.txt',
    data: readmeText(lines, summary),
  })
  summary.bytes += files.reduce((total, file) => total + Buffer.byteLength(file.data), 0)

  return { files, summary, lines, sent }
}

/** Credential ref names any of the model rows depend on. */
function refsNeeded(models) {
  return [...new Set(models.flatMap(model => model.keys ?? []))]
}

/**
 * Does this model group take its keys along?
 *
 * `modelKeys[key]` is the per-group switch on the panel; an undecided group
 * follows its own switch (a ticked group carries its keys) — a model without a
 * key cannot be called on the phone.
 * @param sync - normalized sync section.
 * @param group - a model group from `listModels`.
 */
function keyWanted(sync, group) {
  const declared = sync?.modelKeys?.[group.key]
  if (typeof declared === 'boolean') return declared
  return true
}

/** Refs the desktop's own credentials file does not hold, so the panel can warn. */
function missingRefs(refs, credentialsFile) {
  const known = credentialRefs(credentialsFile)
  return refs.filter(ref => !known.has(ref))
}

/**
 * The short plain-text note the phone prints after applying an archive.
 * @param lines - the planner's log lines.
 * @param summary - the planner's summary.
 */
function readmeText(lines, summary) {
  const body = [
    'DSH 手机同步 — 本次收到的内容',
    '',
    ...lines.map(line => `  ${line}`),
    '',
  ]
  if (summary.sessions > 0) {
    body.push('会话已写入，并登记进 workspace.json。')
    body.push('如果侧栏没有立刻出现，请重载界面（下拉刷新或重进应用）。')
    body.push('')
  }
  if (summary.plugins.send.length > 0) {
    body.push('插件文件已写入 profile，需要重启 DSH 才会加载。')
    body.push('')
  }
  if (summary.skills.send.length > 0) {
    body.push('技能已写入 skills/，通常无需重启即可出现在技能列表里。')
    body.push('')
  }
  return `${body.join('\n')}\n`
}

/**
 * Sessions the desktop holds that are not in any workspace.
 *
 * The planner only ships *indexed* sessions — an unindexed log is invisible on
 * this machine too, so mirroring it would grow the phone with files that show up
 * nowhere. The panel uses this number to say so.
 *
 * @param sessionsRoot - the desktop sessions root.
 * @param indexFile - the desktop workspace index.
 */
export function unindexedCount(sessionsRoot, indexFile) {
  const index = readIndex(indexFile).index
  const known = new Set()
  for (const workspace of Object.values(index.tables.workspaces)) {
    for (const id of workspace.sessionIds) known.add(id)
  }
  return scan(sessionsRoot).filter(entry => !known.has(entry.id)).length
}
