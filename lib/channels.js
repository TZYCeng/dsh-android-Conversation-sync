/**
 * Which sync channels are on, and what each of them carries.
 *
 * The panel's switches have to survive a restart, a reinstall and a profile
 * repair, so they live in `$DSH_HOME/dsh-mobile-sync/state.json` next to the
 * token — never in the profile patch layer, which gets rebuilt from bundle
 * defaults and would silently forget a user's choice.
 *
 * Two different kinds of switch exist and they are not the same thing:
 *
 * - a **channel** (sessions / models / plugins / skills) decides whether a kind
 *   of record moves at all;
 * - a **selection** (one entry per plugin, skill or model group) decides whether
 *   that particular item moves inside its channel.
 *
 * Selections start *off* for everything that leaves this machine (plugins,
 * skills, model groups): a fresh install pushes sessions and nothing else, and
 * the user opts in item by item. Once an item is flipped, the chosen value is
 * kept verbatim — that is what makes the next sync use the same switches as the
 * previous one.
 *
 * @module lib/channels
 */
import os from 'node:os'
import path from 'node:path'

/** The four channels, in the order the panel lists them. */
export const CHANNELS = ['sessions', 'models', 'plugins', 'skills']

/**
 * Every per-item switch map. `modelKeys` is not a channel: it is a second switch
 * per model group (whether that group carries the credential refs it names).
 */
export const SELECTION_KINDS = [...CHANNELS, 'modelKeys']

/**
 * Channel defaults: sessions travel (that is the whole point), the other three
 * are opt-in kinds of payload.
 */
const CHANNEL_DEFAULTS = { sessions: true, models: false, plugins: true, skills: true }

/**
 * Per-item default for kind of payload: **nothing is ticked until the user ticks
 * it**. A phone sync must never install a plugin, a skill or a model group the
 * user did not ask for.
 */
export const ITEM_DEFAULTS = { plugins: false, skills: false, models: false }

/**
 * Shape revision of the stored `sync` section.
 *
 * Rev 2 is the build that turned every per-item default off and stopped syncing
 * archived sessions unless asked. A state file written by an older build has no
 * revision, so the first load of this build re-seeds the three affected fields
 * once (clearing old implicit "everything on" choices) and stamps the revision.
 * After that, an explicit choice is never touched again.
 */
export const DEFAULTS_REV = 2

/** Where a brand new pair of machines puts workspaces it has to invent. */
export const PHONE_ROOT_DEFAULT = '/storage/emulated/0/DSH'

/**
 * The default desktop root: `<home>/DSH` — deliberately outside `$DSH_HOME`,
 * which is the harness's own private store and not a place for project files.
 * @param homeDir - the user's home directory.
 */
export function desktopRootDefault(homeDir = os.homedir()) {
  return path.join(homeDir, 'DSH')
}

/**
 * A fresh, fully-populated sync section.
 * @param homeDir - used only for the default desktop root.
 */
export function defaultSync(homeDir = os.homedir()) {
  return {
    channels: { ...CHANNEL_DEFAULTS },
    // Per-item switches. An absent key means "not decided yet", which the UI
    // resolves with ITEM_DEFAULTS for that item's kind (off for all of them).
    plugins: {},
    skills: {},
    models: {},
    // Per-model-group key switch: whether that group carries the credential refs
    // it names. Undecided means "yes, with the group" — a model whose key never
    // arrives is a model the phone cannot call.
    modelKeys: {},
    // The master switch for shipping credential values at all. Turning a model
    // group on is useless without the key it names, so this defaults to on; the
    // panel still spells out that the LAN channel is plain HTTP.
    secrets: true,
    // `auto` reuses a workspace whose title matches; `root` always creates
    // `<root>/<title>` on the other machine.
    mode: 'auto',
    // Archived sessions are a local opinion; they stay home unless asked for.
    includeArchived: false,
    phoneRoot: PHONE_ROOT_DEFAULT,
    desktopRoot: desktopRootDefault(homeDir),
    // Desktop workspace id → phone workspace id. An absent pair means "align by
    // title" (the default); an entry lets the user send one project into a
    // differently named workspace on the other side.
    workspaceMap: {},
    // One-shot: ignore the "already same version" shortcut for the next pull.
    force: false,
    // Which revision of the defaults above this state file was written with.
    defaultsRev: DEFAULTS_REV,
  }
}

/** Coerce anything into a boolean with the shell-ish spellings people type. */
function boolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false
  }
  return fallback
}

/** Keep only string→boolean pairs, so a hand-edited state file cannot poison it. */
function selection(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (typeof value === 'boolean') out[key] = value
    else if (value === 1 || value === 'true') out[key] = true
    else if (value === 0 || value === 'false') out[key] = false
  }
  return out
}

/** Keep only non-empty string→string pairs (the workspace pairing map). */
function stringMap(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.trim().length === 0) continue
    if (typeof value !== 'string' || value.trim().length === 0) continue
    out[key.trim()] = value.trim()
  }
  return out
}

/** A trimmed string, or the fallback when it is empty/not a string. */
function text(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * Complete an arbitrary stored sync section.
 *
 * Every field is optional; this is the one place that decides what a missing
 * field means, so a state file written by an older build keeps working.
 *
 * @param raw - whatever `state.json` held under `sync`.
 * @param homeDir - used for the desktop root default.
 * @returns a complete sync section.
 */
export function normalizeSync(raw, homeDir = os.homedir()) {
  const defaults = defaultSync(homeDir)
  const source = raw !== null && typeof raw === 'object' ? raw : {}

  const channels = { ...defaults.channels }
  if (source.channels !== null && typeof source.channels === 'object') {
    for (const channel of CHANNELS) {
      channels[channel] = boolean(source.channels[channel], channels[channel])
    }
  }

  // A state file from before rev 2 carries no revision: its implicit "on"
  // choices were the old defaults, not decisions the user made, so they are
  // re-seeded once. From rev 2 on, every stored value is a real choice.
  const revision = Number.isInteger(source.defaultsRev) ? source.defaultsRev : 0
  const fresh = revision < DEFAULTS_REV

  return {
    channels,
    plugins: fresh ? {} : selection(source.plugins),
    skills: fresh ? {} : selection(source.skills),
    models: fresh ? {} : selection(source.models),
    modelKeys: selection(source.modelKeys),
    secrets: boolean(source.secrets, defaults.secrets),
    mode: source.mode === 'root' ? 'root' : 'auto',
    // Rev 2 also makes "archived sessions stay home" the default. An older state
    // file that had it on is reset with the rest of the re-seed.
    includeArchived: fresh ? false : boolean(source.includeArchived, defaults.includeArchived),
    phoneRoot: text(source.phoneRoot, defaults.phoneRoot),
    desktopRoot: text(source.desktopRoot, defaults.desktopRoot),
    workspaceMap: stringMap(source.workspaceMap),
    force: boolean(source.force, false),
    defaultsRev: DEFAULTS_REV,
  }
}

/**
 * Is a channel switched on?
 * @param sync - normalized sync section.
 * @param channel - one of `CHANNELS`.
 */
export function isOn(sync, channel) {
  return sync?.channels?.[channel] === true
}

/**
 * The effective switch for one item.
 * @param map - the selection map (plugins / skills / models).
 * @param name - the item's key.
 * @param defaultSelected - what an undecided item does.
 */
export function selected(map, name, defaultSelected) {
  const value = map?.[name]
  return typeof value === 'boolean' ? value : defaultSelected
}

/**
 * The effective switch for one item, using the kind's default (off).
 * @param sync - normalized sync section.
 * @param kind - `plugins` / `skills` / `models`.
 * @param key - the item's key.
 */
export function itemSelected(sync, kind, key) {
  return selected(sync?.[kind], key, ITEM_DEFAULTS[kind] === true)
}

/**
 * Flip one item and keep the result, so the next sync starts from the same
 * switches.
 * @param sync - normalized sync section, mutated in place.
 * @param kind - `plugins` / `skills` / `models`.
 * @param name - the item's key.
 * @param on - the new value.
 * @returns the stored value.
 */
export function setSelected(sync, kind, name, on) {
  if (!SELECTION_KINDS.some(known => known === kind)) return false
  if (sync[kind] === undefined || sync[kind] === null) sync[kind] = {}
  if (typeof name !== 'string' || name.length === 0) return false
  sync[kind][name] = on === true
  return sync[kind][name]
}

/**
 * Set every item of one kind at once (the panel's "全选 / 清空" buttons).
 * @param sync - normalized sync section, mutated in place.
 * @param kind - `plugins` / `skills` / `models`.
 * @param names - the items currently offered.
 * @param on - the value to store for all of them.
 */
export function setSelectedAll(sync, kind, names, on) {
  if (!SELECTION_KINDS.some(known => known === kind)) return 0
  if (sync[kind] === undefined || sync[kind] === null) sync[kind] = {}
  let count = 0
  for (const name of names ?? []) {
    if (typeof name !== 'string' || name.length === 0) continue
    sync[kind][name] = on === true
    count += 1
  }
  return count
}

/**
 * Pair one desktop workspace with a phone workspace.
 * @param sync - normalized sync section, mutated in place.
 * @param desktopId - desktop workspace id (empty removes the pairing).
 * @param phoneId - phone workspace id, or '' to fall back to matching by title.
 * @returns the stored value ('' when the pairing was cleared).
 */
export function setWorkspaceMap(sync, desktopId, phoneId) {
  const desktop = typeof desktopId === 'string' ? desktopId.trim() : ''
  const phone = typeof phoneId === 'string' ? phoneId.trim() : ''
  if (desktop.length === 0) return ''
  if (phone.length === 0) {
    delete sync.workspaceMap[desktop]
    return ''
  }
  sync.workspaceMap[desktop] = phone
  return phone
}

/** Drop every explicit workspace pairing, restoring "match by title". */
export function clearWorkspaceMap(sync) {
  const count = Object.keys(sync.workspaceMap ?? {}).length
  sync.workspaceMap = {}
  return count
}
