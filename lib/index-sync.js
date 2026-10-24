/**
 * The workspace index: what makes a session *visible*.
 *
 * DSH never lists sessions by walking `sessions/`. The sidebar is driven by
 * `<DSH_HOME>/storages/workspace.json`:
 *
 *   {
 *     "unit":  { "name": "workspace", "version": 2 },
 *     "global": { "initialized", "defaultWorkspaceId", "workspaceIds",
 *                 "archivedSessionIds", "pinnedSessionIds" },
 *     "tables": { "workspaces": { "<uuid>": { path, title, sessionIds,
 *                                             createdAt, updatedAt } } }
 *   }
 *
 * Copying session files alone therefore produces an invisible archive — that is
 * exactly why a phone full of pulled sessions showed an empty list. This module
 * owns reading, merging and writing that document, plus the workspace↔workspace
 * mapping a sync needs.
 *
 * Merging is deliberately additive: `archivedSessionIds` and
 * `pinnedSessionIds` are local opinions and are never propagated, and a session
 * is never removed from an index by a sync.
 *
 * @module lib/index-sync
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { baseName, normalizePath } from './slug.js'

/** Index documents this module understands. */
export const INDEX_VERSION = 2

/**
 * What a session id looks like.
 *
 * The engine writes `session-<uuid>` for a session a user started, but a
 * delegated (subagent) session gets a bare `<uuid>` — both live in the store and
 * both can be registered in a workspace index, so both are accepted here. Which
 * of them a sync actually moves is decided by `origin` in the log header, not by
 * the shape of the name.
 */
export const SESSION_ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * A fresh, empty index document.
 * @returns the skeleton a missing `workspace.json` should have.
 */
export function emptyIndex() {
  return {
    unit: { name: 'workspace', version: INDEX_VERSION },
    global: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: { workspaces: {} },
  }
}

/**
 * Read an index, tolerating a missing or damaged file.
 *
 * A damaged index is *not* repaired here: the caller decides, because silently
 * replacing a user's workspace list would hide every session they have.
 *
 * @param file - absolute path to `workspace.json`.
 * @returns `{ index, exists, error }`; `index` is a skeleton when unreadable.
 */
export function readIndex(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { index: emptyIndex(), exists: false, error: null }
    return { index: emptyIndex(), exists: false, error }
  }
  try {
    const parsed = JSON.parse(raw)
    return { index: normalizeIndex(parsed), exists: true, error: null }
  } catch (error) {
    return { index: emptyIndex(), exists: true, error }
  }
}

/**
 * Coerce a parsed document into the shape the rest of this module assumes,
 * without discarding anything it already holds.
 * @param parsed - whatever was on disk.
 */
export function normalizeIndex(parsed) {
  const index = emptyIndex()
  if (!parsed || typeof parsed !== 'object') return index

  if (parsed.unit && typeof parsed.unit === 'object') {
    index.unit = { ...index.unit, ...parsed.unit }
  }
  const global = parsed.global && typeof parsed.global === 'object' ? parsed.global : {}
  for (const key of ['initialized', 'defaultWorkspaceId']) {
    if (global[key] !== undefined) index.global[key] = global[key]
  }
  for (const key of ['workspaceIds', 'archivedSessionIds', 'pinnedSessionIds']) {
    if (Array.isArray(global[key])) index.global[key] = [...global[key]]
  }

  const workspaces = parsed.tables?.workspaces
  if (workspaces && typeof workspaces === 'object') {
    for (const [id, value] of Object.entries(workspaces)) {
      if (!value || typeof value !== 'object') continue
      index.tables.workspaces[id] = {
        path: typeof value.path === 'string' ? value.path : '',
        title: typeof value.title === 'string' ? value.title : '',
        sessionIds: Array.isArray(value.sessionIds) ? [...value.sessionIds] : [],
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
      }
    }
  }
  // `workspaceIds` is the sidebar order; a workspace that exists but is not
  // listed would still be hidden, so fold the missing ones in.
  for (const id of Object.keys(index.tables.workspaces)) {
    if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
  }
  return index
}

/**
 * Write an index atomically, keeping the previous copy.
 * @param file - absolute path to `workspace.json`.
 * @param index - the document to persist.
 * @param options - `{ backup: true }` writes `<file>.bak-<stamp>` first.
 */
export function writeIndex(file, index, options = {}) {
  const { backup = true } = options
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (backup && fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '')
    fs.copyFileSync(file, `${file}.bak-${stamp}`)
  }
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`)
  fs.renameSync(temp, file)
}

/**
 * Find a workspace by path, comparing the way the platform does.
 * @param index - index document.
 * @param target - absolute path to look for.
 * @param foldCase - compare case-insensitively (Windows, macOS).
 * @returns the workspace id, or null.
 */
export function findWorkspaceByPath(index, target, foldCase) {
  const want = normalizePath(target, foldCase)
  for (const [id, workspace] of Object.entries(index.tables.workspaces)) {
    if (normalizePath(workspace.path, foldCase) === want) return id
  }
  return null
}

/**
 * Find a workspace by title, ignoring case and surrounding space.
 * @param index - index document.
 * @param title - title to look for.
 * @returns the workspace id, or null.
 */
export function findWorkspaceByTitle(index, title) {
  const want = String(title).trim().toLowerCase()
  for (const [id, workspace] of Object.entries(index.tables.workspaces)) {
    if (String(workspace.title).trim().toLowerCase() === want) return id
  }
  return null
}

/**
 * Add a workspace if no workspace already claims that path.
 * @param index - index document, mutated in place.
 * @param spec - `{ path, title, id }`; `id` lets a caller keep a known uuid.
 * @returns `{ id, created }`.
 */
export function upsertWorkspace(index, spec) {
  const foldCase = /^[A-Za-z]:|^\\\\/u.test(spec.path)
  const existing = findWorkspaceByPath(index, spec.path, foldCase)
  if (existing) {
    const workspace = index.tables.workspaces[existing]
    if (!workspace.title && spec.title) workspace.title = spec.title
    return { id: existing, created: false }
  }
  const id = spec.id ?? randomUUID()
  const now = new Date().toISOString()
  index.tables.workspaces[id] = {
    path: spec.path,
    title: spec.title || baseName(spec.path),
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  }
  if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
  return { id, created: true }
}

/**
 * Append session ids to a workspace, skipping ones it already lists.
 * @param index - index document, mutated in place.
 * @param workspaceId - owning workspace.
 * @param sessionIds - candidate ids; anything not shaped like a session id is dropped.
 * @returns the ids actually added.
 */
export function addSessions(index, workspaceId, sessionIds) {
  const workspace = index.tables.workspaces[workspaceId]
  if (!workspace) return []
  const seen = new Set(workspace.sessionIds)
  const added = []
  for (const id of sessionIds) {
    if (!SESSION_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    workspace.sessionIds.push(id)
    added.push(id)
  }
  if (added.length > 0) workspace.updatedAt = new Date().toISOString()
  return added
}

/**
 * Remove session ids from every workspace (used when a sync decides a session
 * no longer belongs to a path).
 * @param index - index document, mutated in place.
 * @param sessionIds - ids to drop.
 * @returns how many references were removed.
 */
export function removeSessions(index, sessionIds) {
  const drop = new Set(sessionIds)
  let removed = 0
  for (const workspace of Object.values(index.tables.workspaces)) {
    const kept = workspace.sessionIds.filter(id => {
      if (!drop.has(id)) return true
      removed += 1
      return false
    })
    workspace.sessionIds = kept
  }
  return removed
}

/** The directory name a title would become under a sync root. */
function safeName(title) {
  return String(title).replace(/[/\\:*?"<>|]/gu, '-').replace(/^\.+/u, '') || 'workspace'
}

/**
 * How a desktop workspace is addressed on the phone.
 *
 * Resolution order:
 *
 * 1. an explicit pairing from the panel (`workspaceMap[desktopId] = phoneId`) —
 *    the user asked for this project to land in *that* phone workspace, even
 *    when the titles differ;
 * 2. the phone's workspace with the same title ("同名工作区互传", the default);
 * 3. a fresh directory `<root>/<project>`.
 *
 * `root` mode skips step 2 (but not step 1: an explicit pairing is always an
 * explicit pairing).
 *
 * @param spec - `{ mode, root, workspace, phoneIndex, map }`; `workspace.id` is
 *   what `map` is keyed by.
 * @returns `{ phonePath, title, reuse, mapped }` — `reuse` names the phone
 *   workspace id, `mapped` says an explicit pairing was used.
 */
export function mapWorkspace(spec) {
  const { mode, root, workspace, phoneIndex, map } = spec
  const title = workspace.title || baseName(workspace.path)
  const pairing = workspace.id === undefined ? undefined : map?.[workspace.id]
  if (typeof pairing === 'string' && pairing.length > 0 && phoneIndex) {
    const target = phoneIndex.tables.workspaces[pairing]
    if (target !== undefined) {
      return {
        phonePath: target.path,
        title: target.title || title,
        reuse: pairing,
        mapped: true,
      }
    }
  }
  if (mode !== 'root' && phoneIndex) {
    const byTitle = findWorkspaceByTitle(phoneIndex, title)
    if (byTitle) {
      return { phonePath: phoneIndex.tables.workspaces[byTitle].path, title, reuse: byTitle, mapped: false }
    }
  }
  const trimmed = String(root).replace(/\/+$/u, '')
  return { phonePath: `${trimmed}/${safeName(title)}`, title, reuse: null, mapped: false }
}

/**
 * The reverse mapping: where a phone workspace lands on the desktop.
 *
 * An explicit pairing wins (a phone workspace that is the target of a desktop
 * workspace is that workspace, whatever its title says); otherwise the desktop
 * workspace with the same title; otherwise `<root>/<project>`.
 *
 * @param spec - `{ mode, root, phoneWorkspace, desktopIndex, map }`.
 * @returns `{ desktopPath, title, workspaceId, mapped }` — `workspaceId` is the
 *   existing desktop workspace id, or null when one has to be created.
 */
export function mapDesktopWorkspace(spec) {
  const { mode, root, phoneWorkspace, desktopIndex, map } = spec
  const title = phoneWorkspace.title || baseName(phoneWorkspace.path)
  if (phoneWorkspace.id !== undefined && map !== undefined) {
    for (const [desktopId, phoneId] of Object.entries(map)) {
      if (phoneId !== phoneWorkspace.id) continue
      const target = desktopIndex.tables.workspaces[desktopId]
      if (target !== undefined) {
        return {
          desktopPath: target.path,
          title: target.title || title,
          workspaceId: desktopId,
          mapped: true,
        }
      }
    }
  }
  if (mode !== 'root') {
    const byTitle = findWorkspaceByTitle(desktopIndex, title)
    if (byTitle) {
      const target = desktopIndex.tables.workspaces[byTitle]
      return { desktopPath: target.path, title: target.title || title, workspaceId: byTitle, mapped: false }
    }
  }
  const trimmed = String(root).replace(/[/\\]+$/u, '')
  return { desktopPath: path.join(trimmed, safeName(title)), title, workspaceId: null, mapped: false }
}

/**
 * The session ids an index assigns to one workspace.
 * @param index - index document.
 * @param workspaceId - workspace to inspect.
 */
export function sessionsOf(index, workspaceId) {
  return index.tables.workspaces[workspaceId]?.sessionIds ?? []
}

/**
 * Paths that a sync must not treat as ordinary workspaces.
 *
 * DSH keeps throwaway sessions in `incoming` (a phone upload's landing area) and
 * `tmp`; syncing those would recreate the scaffolding on the other machine. Only
 * the *final* segment counts: a real project that merely lives under a directory
 * called `Temp` (a checkout in `%TEMP%`, say) is an ordinary workspace.
 *
 * @param workspacePath - candidate path.
 */
export function isScratchWorkspace(workspacePath) {
  const normalized = String(workspacePath).replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /(^|\/)(incoming|tmp|temp|\.trash)$/iu.test(normalized)
}

/**
 * Group session ids by the workspace that owns them.
 * @param index - index document.
 * @returns a map from session id to workspace id (first owner wins).
 */
export function ownerOf(index) {
  const owners = new Map()
  for (const [id, workspace] of Object.entries(index.tables.workspaces)) {
    for (const sessionId of workspace.sessionIds) {
      if (!owners.has(sessionId)) owners.set(sessionId, id)
    }
  }
  return owners
}
