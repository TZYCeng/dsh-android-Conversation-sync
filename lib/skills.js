/**
 * The skills this desktop holds, described well enough to ship them to a phone.
 *
 * DSH discovers skills from two roots — `<DSH_HOME>/skills` and
 * `<agentsHome>/skills` (`~/.agents/skills` by default) — and a skill is either
 * a bundle (`<root>/<name>/SKILL.md` plus whatever resources sit beside it) or a
 * flat `<root>/<name>.md`. Anything nested deeper than that is *not* discovered,
 * and neither is a bundle whose `SKILL.md` is missing, which is what makes a
 * half-checked-out skill directory harmless.
 *
 * Two roots can describe the same skill: `~/.dsh/skills/session-sync` is
 * routinely a symlink into `~/.agents/skills/session-sync`, so the same files
 * are reachable twice. The phone installs skills by name into one flat
 * directory, so the second copy would silently overwrite the first — hence
 * de-duplication by name on the way out, with the DSH-owned root winning
 * (`dsh` before `agents` before `extra`).
 *
 * `digest` is what makes a re-send unnecessary: the phone compares it against
 * the copy it already holds and asks for nothing when the two match. It hashes
 * relative paths and file *contents* only — never timestamps or modes — so a
 * skill that was merely copied from one machine to another keeps its digest.
 *
 * Every reader here tolerates a missing root, an unreadable file or a damaged
 * frontmatter block by degrading instead of throwing: a sync round must never
 * fail because one skill directory is odd.
 *
 * @module lib/skills
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Directory and file names that are build residue rather than skill content.
 *
 * `__pycache__`/`*.pyc` are the ones that actually appear in practice (the
 * session-sync bundle ships Python), and shipping them would make a digest
 * change for reasons the user cannot see.
 */
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__'])

/** Compiled Python, skipped wherever it sits. */
const PYC = /\.pyc$/iu
/** A flat skill is a Markdown file; the extension decides, not the frontmatter. */
const FLAT = /\.md$/iu
/** Default ceiling for one skill's payload on the wire. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
/** Frontmatter keys this plugin understands; anything else is left in `raw`. */
const KEYS = new Set([
  'name',
  'description',
  'whenToUse',
  'disable-model-invocation',
  'user-invocable',
  'metadata',
])
/** Spellings YAML admits for "true"; every other spelling coerces to false. */
const TRUTHY = new Set(['true', 'yes', 'on', '1'])

/**
 * Strip one pair of surrounding quotes from a scalar.
 * @param value - the raw right-hand side of a `key: value` line.
 * @returns the unquoted text; unquoted values are returned trimmed.
 */
function scalar(value) {
  const text = value.trim()
  if (text.length >= 2) {
    const quote = text[0]
    if ((quote === '"' || quote === "'") && text[text.length - 1] === quote) {
      const inner = text.slice(1, -1)
      return quote === "'" ? inner.replace(/''/gu, "'") : inner.replace(/\\"/gu, '"')
    }
  }
  return text
}

/**
 * Read a YAML-ish boolean the permissive way.
 * @param value - the parsed scalar, or undefined when the key is absent.
 * @returns true only for an explicit true spelling.
 */
function truthy(value) {
  return value !== undefined && TRUTHY.has(String(value).trim().toLowerCase())
}

/**
 * Parse the frontmatter block that opens a `SKILL.md`.
 *
 * Only a `---`-fenced block at the very start counts; a document that begins
 * with a heading has no frontmatter and yields null, which is exactly how a
 * broken bundle is recognised. The parser is deliberately flat — real skill
 * files use nothing but top-level scalars — and permissive, because refusing to
 * list a skill over an unusual boolean spelling would cost the user a skill for
 * no gain.
 *
 * @param text - the whole file, or any prefix of it.
 * @returns `{ name, description, whenToUse, hidden, userInvocable, raw }`, with
 *   `name`/`description`/`whenToUse` undefined when absent, `raw` holding the
 *   block body; null when there is no fenced block.
 */
export function frontmatter(text) {
  const source = String(text ?? '')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
  const lines = source.split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') return null

  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    const marker = lines[index].trim()
    if (marker === '---' || marker === '...') {
      end = index
      break
    }
  }
  if (end === -1) return null

  const body = lines.slice(1, end)
  const fields = Object.create(null)
  for (const line of body) {
    // An indented line belongs to a nested block (or a block scalar) that this
    // parser does not model; treating it as a key would invent values.
    if (/^\s/u.test(line)) continue
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u.exec(trimmed)
    if (match === null) continue
    const key = match[1]
    if (!KEYS.has(key) || fields[key] !== undefined) continue
    fields[key] = scalar(match[2])
  }

  const name = fields.name !== undefined && fields.name.length > 0 ? fields.name : undefined
  const description = fields.description
  const whenToUse = fields.whenToUse
  return {
    name,
    description,
    whenToUse,
    hidden: truthy(fields['disable-model-invocation']),
    // Unknown spellings coerce to false, so an unreadable `user-invocable` makes
    // the skill manual rather than silently model-visible.
    userInvocable: fields['user-invocable'] === undefined ? true : truthy(fields['user-invocable']),
    raw: body.join('\n'),
  }
}

/**
 * Walk one bundle, collecting files under a `relative` path that already starts
 * with the bundle directory name.
 *
 * The prefix is the directory name rather than the frontmatter name because the
 * caller untars straight into the skills root: what the phone ends up with must
 * be the path DSH will discover, not the path the skill calls itself.
 *
 * @param dir - absolute directory to read.
 * @param prefix - slash-separated relative path of `dir`.
 * @param out - accumulator of `{ relative, absolute }`.
 */
function walkBundle(dir, prefix, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_error) {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || PYC.test(entry.name)) continue
    const absolute = path.join(dir, entry.name)
    const relative = `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) {
      // Follow a linked *file* (bundles legitimately link shared assets) but
      // never a linked directory: a cycle here would hang the listing.
      try {
        const stat = fs.statSync(absolute)
        if (stat.isFile()) out.push({ relative, absolute })
      } catch (_error) {
        // A dangling link is simply not part of the payload.
      }
      continue
    }
    if (entry.isDirectory()) {
      walkBundle(absolute, relative, out)
      continue
    }
    if (entry.isFile()) out.push({ relative, absolute })
  }
}

/**
 * Every file a skill ships.
 *
 * Paths are slash-separated on every platform so a bundle built on Windows and
 * a bundle built on Linux unpack to the same thing.
 *
 * @param skill - a skill as `listSkills` returns it (only `kind`/`dir`/`file` are read).
 * @returns `[{ relative, absolute }]` sorted by `relative`; empty when the skill is unreadable.
 */
export function skillFiles(skill) {
  if (skill === null || typeof skill !== 'object') return []
  if (skill.kind === 'dir') {
    if (typeof skill.dir !== 'string' || skill.dir.length === 0) return []
    const out = []
    walkBundle(skill.dir, path.basename(skill.dir), out)
    out.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0))
    return out
  }
  if (typeof skill.file !== 'string' || skill.file.length === 0) return []
  return [{ relative: path.basename(skill.file), absolute: skill.file }]
}

/**
 * Content digest of a file list.
 *
 * The digest deliberately hashes per-file SHA-256 values instead of the bytes
 * themselves: that way it depends on paths and content and on nothing else, and
 * the same skill copied between machines — different timestamps, different
 * modes — still compares equal.
 *
 * @param fileList - `[{ relative, absolute }]` as `skillFiles` returns.
 * @returns lowercase hex SHA-256; the digest of an empty or unreadable list is
 *   the digest of no lines, never an error.
 */
export function digestOf(fileList) {
  const lines = []
  for (const item of Array.isArray(fileList) ? fileList : []) {
    if (item === null || typeof item !== 'object' || typeof item.relative !== 'string') continue
    let data
    try {
      data = fs.readFileSync(item.absolute)
    } catch (_error) {
      // A file that vanished between listing and hashing is left out; the next
      // round picks up whatever the directory looks like then.
      continue
    }
    lines.push(`${item.relative}\u0000${crypto.createHash('sha256').update(data).digest('hex')}\n`)
  }
  lines.sort()
  const hash = crypto.createHash('sha256')
  for (const line of lines) hash.update(line, 'utf8')
  return hash.digest('hex')
}

/**
 * Read a skill's files, honouring a byte cap.
 *
 * The cap is what keeps one oversized bundle from monopolising the LAN payload;
 * it truncates on a file boundary so the phone never reassembles half a file.
 *
 * @param skill - a skill as `listSkills` returns it.
 * @param options - `{ maxBytes }`, default 16 MiB.
 * @returns `{ files, bytes, truncated }`; `truncated` says at least one file was left out.
 */
export function readSkill(skill, options = {}) {
  const wanted = options?.maxBytes
  const maxBytes = typeof wanted === 'number' && Number.isFinite(wanted) && wanted > 0
    ? wanted
    : DEFAULT_MAX_BYTES
  const files = []
  let bytes = 0
  let truncated = false
  for (const item of skillFiles(skill)) {
    if (bytes >= maxBytes) {
      truncated = true
      break
    }
    let data
    try {
      data = fs.readFileSync(item.absolute)
    } catch (_error) {
      continue
    }
    if (bytes + data.length > maxBytes) {
      truncated = true
      break
    }
    files.push({ relative: item.relative, data })
    bytes += data.length
  }
  return { files, bytes, truncated }
}

/**
 * Read one root's entries and order them the way de-duplication should see them.
 *
 * `statSync` (not the dirent) decides what an entry is, because a skill reached
 * through a symlink — the normal shape of a DSH-owned skill that lives in the
 * agents home — reports as neither a file nor a directory to `readdir`.
 *
 * @param root - absolute skills root.
 * @returns bundle and flat descriptors, bundles first, each group name-sorted.
 */
function scanRoot(root) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (_error) {
    return []
  }
  const bundles = []
  const flats = []
  for (const entry of entries) {
    // A leading dot covers DSH's own `.system` skills and any editor litter.
    if (entry.name.startsWith('.')) continue
    const absolute = path.join(root, entry.name)
    let stat
    try {
      stat = fs.statSync(absolute)
    } catch (_error) {
      continue
    }
    if (stat.isDirectory()) bundles.push({ name: entry.name, dir: absolute })
    else if (stat.isFile() && FLAT.test(entry.name)) flats.push({ name: entry.name, file: absolute })
  }
  const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  return [...bundles.sort(byName), ...flats.sort(byName)]
}

/**
 * Describe one discovered skill, or reject it.
 * @param entry - `{ dir }` for a bundle or `{ file }` for a flat skill.
 * @param source - `'dsh' | 'agents' | 'extra'`.
 * @returns the skill record, or null when the entry is not a usable skill.
 */
function describe(entry, source) {
  let meta = null
  if (entry.dir !== undefined) {
    const file = path.join(entry.dir, 'SKILL.md')
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (_error) {
      return null
    }
    meta = frontmatter(text)
    if (meta === null || meta.name === undefined) return null
    return build({ name: meta.name, meta, source, kind: 'dir', dir: entry.dir, file })
  }

  let text
  try {
    text = fs.readFileSync(entry.file, 'utf8')
  } catch (_error) {
    return null
  }
  meta = frontmatter(text)
  // A flat skill without a frontmatter name is still installable under its own
  // file name, which is the only identity the phone would have anyway.
  const stem = path.basename(entry.file).replace(FLAT, '')
  const name = meta?.name !== undefined ? meta.name : stem
  return build({ name, meta, source, kind: 'file', dir: null, file: entry.file })
}

/**
 * Assemble the record a caller consumes, computing its totals and digest.
 * @param spec - `{ name, meta, source, kind, dir, file }`.
 * @returns the skill record.
 */
function build(spec) {
  const { name, meta, source, kind, dir, file } = spec
  const skill = {
    name,
    description: meta?.description ?? '',
    whenToUse: meta?.whenToUse ?? '',
    source,
    kind,
    dir,
    file,
    bytes: 0,
    files: 0,
    digest: '',
    hidden: meta?.hidden === true,
    userInvocable: meta?.userInvocable !== false,
  }
  const list = skillFiles(skill)
  skill.files = list.length
  for (const item of list) {
    try {
      skill.bytes += fs.statSync(item.absolute).size
    } catch (_error) {
      // Size is reporting data; a file that cannot be stat'ed just adds nothing.
    }
  }
  skill.digest = digestOf(list)
  return skill
}

/**
 * Describe every skill the desktop holds.
 *
 * De-duplication is by skill name, and the first root to claim a name keeps it:
 * the DSH home is the user's own deliberate placement, so it must not be
 * shadowed by the shared agents home or by an extra directory.
 *
 * @param options - `{ home, agentsHome, extraDirs }`. `home` is `<DSH_HOME>`;
 *   `agentsHome` defaults to `~/.agents` and `null` disables that root;
 *   `extraDirs` are additional skills roots searched last.
 * @returns skill records sorted by name; a missing root contributes nothing.
 */
export function listSkills(options) {
  const { home, agentsHome, extraDirs } = options ?? {}
  const roots = []
  if (typeof home === 'string' && home.length > 0) {
    roots.push({ source: 'dsh', dir: path.join(home, 'skills') })
  }
  if (agentsHome !== null) {
    const base = typeof agentsHome === 'string' && agentsHome.length > 0
      ? agentsHome
      : path.join(os.homedir(), '.agents')
    roots.push({ source: 'agents', dir: path.join(base, 'skills') })
  }
  for (const extra of Array.isArray(extraDirs) ? extraDirs : []) {
    if (typeof extra === 'string' && extra.length > 0) roots.push({ source: 'extra', dir: extra })
  }

  const found = new Map()
  for (const root of roots) {
    for (const entry of scanRoot(root.dir)) {
      const skill = describe(entry, root.source)
      // Earlier roots win: `found` already holding the name means this copy is
      // the duplicate the phone would otherwise overwrite.
      if (skill === null || found.has(skill.name)) continue
      found.set(skill.name, skill)
    }
  }
  return [...found.values()].sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))
}
