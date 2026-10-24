/**
 * What a DSH profile has installed, and what a phone can actually receive.
 *
 * A profile is itself an npm package: `<profileDir>/package.json` lists its
 * `dependencies`, and every package physically lives under
 * `<profileDir>/node_modules/<name>` — often as a junction into a source
 * checkout, which is why a record's `dir` is the *real* path rather than the
 * path that was joined. `dsh.profile.bundles` names the subset the Loader
 * mounts, so both lists are candidates; the package's own `package.json`
 * decides the rest, because a `dsh` field is the only thing that makes a
 * package a DSH plugin. Host libraries (`@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-llm`) have no such field and must never be offered as
 * add-ons.
 *
 * Two kinds of plugin can be listed but not shipped. The phone is Android: a
 * native artifact (`.node`, `.dll`, `.so`, `.dylib`, `binding.gyp`) cannot be
 * loaded there at all. And npm installs a package's runtime `dependencies`
 * beside it in the *profile*, never inside the package, so a plugin that has
 * any arrives on the phone unable to resolve them. Sending either one would
 * fail at load time on the phone with no useful message, so this module reports
 * why the package cannot be sent instead.
 *
 * @module lib/plugins
 */
import fs from 'node:fs'
import path from 'node:path'

/** Byte budget a single plugin may use unless the caller asks for another. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

/**
 * Directory names that are never part of a package's own shipped source:
 * package managers (`node_modules`, `.pnpm`), version control (`.git`), caches,
 * and the scratch directories the market and plugin manager keep inside a
 * checkout.
 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.pnpm',
  '.dsh-market',
  '.plugin-manager',
])

/** Native artifacts an Android runtime cannot load, whatever platform built them for. */
export const NATIVE_EXT = /\.(node|dll|so|dylib)$/i

/**
 * Resolve a package path to its real one.
 *
 * `realpathSync.native` is preferred because the JavaScript implementation
 * treats a Windows junction as an ordinary directory; the real path is what a
 * caller has to read, and a junction is a common shape for a linked package.
 */
const realPath = fs.realpathSync.native ?? fs.realpathSync

/**
 * Is this a plain JSON object (not null, not an array)?
 * @param value - anything.
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse one JSON file without ever throwing.
 * @param file - absolute path.
 * @returns the parsed value, or undefined when the file is missing or damaged.
 */
function readJson(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (_error) {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch (_error) {
    return undefined
  }
}

/**
 * Does a shipped file force a native build?
 * @param relative - slash-separated path inside the package.
 */
function isNativeArtifact(relative) {
  return NATIVE_EXT.test(relative) || path.posix.basename(relative) === 'binding.gyp'
}

/**
 * Collect the files of one directory tree into `out`.
 *
 * Symbolic links are skipped rather than followed: a package that links to a
 * source checkout would otherwise drag a whole unrelated tree along, and a
 * phone could not use the link anyway.
 *
 * @param root - package directory, already a real path.
 * @param prefix - slash-separated path of the current directory relative to `root`.
 * @param out - accumulator of relative paths.
 */
function walk(root, prefix, out) {
  let entries
  try {
    entries = fs.readdirSync(prefix.length === 0 ? root : path.join(root, prefix), { withFileTypes: true })
  } catch (_error) {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, relative, out)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name === '.DS_Store' || entry.name.endsWith('.log')) continue
    out.push(relative)
  }
}

/**
 * Every file a package would ship, as slash-separated paths relative to `dir`.
 *
 * Only regular files are listed; `SKIP_DIRS`, `.DS_Store`, `*.log` and symlinks
 * are left out because they are not part of the package's own source. Totals
 * taken over this list are therefore the bytes a transfer would actually carry.
 *
 * @param dir - absolute path of the package directory.
 * @returns sorted relative paths; a missing or unreadable directory yields `[]`.
 */
export function pluginFiles(dir) {
  const files = []
  try {
    walk(String(dir), '', files)
  } catch (_error) {
    // A listing is display data: an unreadable package is simply empty.
    return []
  }
  return files.sort()
}

/**
 * Read one plugin's shipped files, honouring a byte cap.
 *
 * The cap exists because a transfer is a single HTTP body and a phone has the
 * smaller disk: a plugin over the budget is reported as `truncated`, which every
 * caller treats as "too big to send". Truncation is also reported when a member
 * cannot be read, because a package missing a file it listed is as unusable on
 * the phone as one that is too large.
 *
 * @param dir - absolute path of the package directory.
 * @param options - `{ maxBytes }`, defaulting to 64 MiB.
 * @returns `{ files: [{ relative, data }], bytes, truncated }` in listing order.
 */
export function readPlugin(dir, options = {}) {
  const requested = (options ?? {}).maxBytes
  const maxBytes = typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
    ? requested
    : DEFAULT_MAX_BYTES
  const root = String(dir)
  const files = []
  let bytes = 0
  let truncated = false
  for (const relative of pluginFiles(root)) {
    const absolute = path.join(root, relative)
    let stat
    try {
      stat = fs.statSync(absolute)
    } catch (_error) {
      truncated = true
      break
    }
    if (bytes + stat.size > maxBytes) {
      truncated = true
      break
    }
    let data
    try {
      data = fs.readFileSync(absolute)
    } catch (_error) {
      truncated = true
      break
    }
    if (bytes + data.length > maxBytes) {
      // The file grew between stat and read; never overshoot the advertised cap.
      truncated = true
      break
    }
    files.push({ relative, data })
    bytes += data.length
  }
  return { files, bytes, truncated }
}

/**
 * Describe every DSH plugin installed in one profile.
 *
 * The candidate set is the union of the profile's `dependencies` and its
 * `dsh.profile.bundles`, because a plugin can be mounted without being a direct
 * dependency and a dependency can be installed without being mounted. Packages
 * that are absent from disk, named in `skip`, or carry no `dsh` field are
 * dropped — the last is how host libraries stay out of the list.
 *
 * @param options - `{ profileDir, skip }`.
 * @returns records sorted by name; an unreadable profile yields `[]`.
 */
export function listPlugins(options = {}) {
  try {
    return collectPlugins(options ?? {})
  } catch (_error) {
    // A listing is display data: a damaged profile must not fail the caller.
    return []
  }
}

/**
 * The body of `listPlugins`, split out so the exported wrapper can promise it
 * never throws.
 * @param options - `{ profileDir, skip }`.
 */
function collectPlugins(options) {
  const profileDir = typeof options.profileDir === 'string' ? options.profileDir : ''
  if (profileDir.length === 0) return []
  const skip = new Set(Array.isArray(options.skip) ? options.skip : [])
  const profile = readJson(path.join(profileDir, 'package.json'))
  if (!isObject(profile)) return []

  const names = new Set()
  if (isObject(profile.dependencies)) {
    for (const name of Object.keys(profile.dependencies)) names.add(name)
  }
  const bundles = profile.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    for (const entry of bundles) {
      const name = typeof entry === 'string' ? entry : isObject(entry) ? entry.name : undefined
      if (typeof name === 'string' && name.length > 0) names.add(name)
    }
  }

  const modules = path.join(profileDir, 'node_modules')
  const plugins = []
  for (const name of names) {
    if (skip.has(name)) continue
    const entry = path.join(modules, name)
    let dir
    try {
      // A junction is the normal shape of a plugin developed from a source
      // checkout, so every caller gets the real path it can actually read.
      dir = realPath(entry)
      if (!fs.statSync(dir).isDirectory()) continue
    } catch (_error) {
      continue // not installed here, or a link with no target
    }
    const plugin = describePlugin(entry, dir)
    if (plugin !== undefined) plugins.push(plugin)
  }
  plugins.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return plugins
}

/**
 * Build the record for one installed package.
 * @param entry - `<profileDir>/node_modules/<name>`, used when the manifest has no name.
 * @param dir - the package's real path.
 * @returns the record, or undefined when the package is not a DSH plugin at all.
 */
function describePlugin(entry, dir) {
  const manifest = readJson(path.join(dir, 'package.json'))
  if (!isObject(manifest)) return undefined
  const dsh = manifest.dsh
  // Host libraries (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`) carry no `dsh`
  // field, so they are not plugins however they got installed.
  if (dsh === undefined || dsh === null || dsh === false) return undefined

  const meta = isObject(dsh) ? dsh : {}
  const files = pluginFiles(dir)
  let bytes = 0
  for (const relative of files) {
    try {
      bytes += fs.statSync(path.join(dir, relative)).size
    } catch (_error) {
      // A file that vanished between listing and measuring simply adds nothing.
    }
  }
  const dependencies = isObject(manifest.dependencies) ? Object.keys(manifest.dependencies) : []
  const bundle = Boolean(meta.bundle)
  // A bundle may ship its own loader patch; the model channel reads it to find
  // providers a plugin declares (their endpoint lives there, not in the
  // profile's patch layer).
  const patchRelative = isObject(meta.bundle) && typeof meta.bundle.patch === 'string'
    ? path.join(dir, meta.bundle.patch)
    : null

  // Priority matters: a native binary explains the failure even when the package
  // also has dependencies, and an unusable `dsh` field is the weakest claim.
  let reason = null
  if (files.some(isNativeArtifact)) {
    reason = '含原生二进制，手机无法加载'
  } else if (dependencies.length > 0) {
    reason = `依赖 ${dependencies.length} 个运行时包（${dependencies.join('、')}），暂不支持整体搬移`
  } else if (!bundle && !meta.client && !meta.patch) {
    reason = '不是可加载的 DSH 插件'
  }

  return {
    name: typeof manifest.name === 'string' && manifest.name.length > 0
      ? manifest.name
      : path.basename(entry),
    dir,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    bytes,
    files: files.length,
    installable: reason === null,
    reason,
    bundle,
    patchFile: patchRelative,
    dependencies,
  }
}
