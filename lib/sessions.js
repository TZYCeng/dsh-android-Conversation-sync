/**
 * Reading and merging the JSONL session store.
 *
 * A session lives at `<root>/<project-slug>/<session-id>/session.v<N>.jsonl.zstd`.
 * The `.zstd` file is a **concatenation of independently compressed frames**
 * (one frame per appended batch), so `zlib.zstdDecompressSync` alone only ever
 * decodes the first frame: this module splits on the zstd magic number and
 * decompresses frame by frame whenever it needs to look inside a log.
 *
 * The desktop never rewrites a log it receives — session files are append-only,
 * and a "newer" file is simply a longer one. That makes file size a sound
 * conflict oracle for the whole-file sync this plugin performs.
 *
 * @module lib/sessions
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** Frame delimiter of the zstd container format. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** Session log file name, capturing its format version. */
const LOG_NAME = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/
/** How much of a log is read to recover its header and first prompt. */
const META_BYTES = 512 * 1024
/** Longest prompt excerpt kept for display. */
const TITLE_MAX = 120

/**
 * Byte offsets where a new zstd frame starts.
 * @param buffer - the raw container bytes.
 * @returns ascending offsets, always starting with 0.
 */
export function frameOffsets(buffer) {
  const offsets = [0]
  let from = 1
  for (;;) {
    const at = buffer.indexOf(ZSTD_MAGIC, from)
    if (at === -1) return offsets
    offsets.push(at)
    from = at + ZSTD_MAGIC.length
  }
}

/**
 * Decompress the leading frames of a container.
 * @param buffer - raw container bytes, possibly a truncated prefix of the file.
 * @param stop - predicate run on every decoded line; a truthy result ends the walk.
 * @returns every decoded line, in order.
 */
export function decodeFrames(buffer, stop) {
  const offsets = frameOffsets(buffer)
  const lines = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    let text
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch (_error) {
      // A truncated tail frame is expected whenever only a prefix was read.
      break
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      lines.push(line)
      if (stop !== undefined && stop(line, lines)) return lines
    }
  }
  return lines
}

/**
 * Pull one human-readable text run out of an `agent/inbox/spliced` record.
 * @param record - a decoded record, or anything else.
 * @returns the text, or undefined when the record carries no user prompt.
 */
function promptOf(record) {
  if (record === null || typeof record !== 'object') return undefined
  if (record.type !== 'agent/inbox/spliced') return undefined
  const inserted = record.data?.inserted
  if (!Array.isArray(inserted)) return undefined
  for (const message of inserted) {
    if (message?.role !== 'user') continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 0) return text.slice(0, TITLE_MAX)
  }
  return undefined
}

/** Metadata cache, keyed by absolute path plus the stat signature it was read under. */
const metaCache = new Map()

/**
 * Read the header of one session log.
 * @param file - absolute path of a `session.v*.jsonl.zstd` file.
 * @param stat - the file's stat, when the caller already has it.
 * @returns `{ id, version, createdAt, cwd, agentPreset, origin, parent, title }`;
 *   null fields when unknown.
 */
export function readMeta(file, stat) {
  const info = stat ?? fs.statSync(file)
  const key = `${file}\u0000${info.size}\u0000${Math.trunc(info.mtimeMs)}`
  const cached = metaCache.get(key)
  if (cached !== undefined) return cached

  const result = {
    id: path.basename(path.dirname(file)),
    version: Number(LOG_NAME.exec(path.basename(file))?.[1] ?? 0),
    createdAt: null,
    cwd: null,
    agentPreset: null,
    // `origin: 'subagent'` marks a delegated session: a transcript the engine
    // writes for its own use, not a conversation the user opened in the sidebar.
    origin: null,
    parent: null,
    title: null,
  }

  let buffer
  try {
    const handle = fs.openSync(file, 'r')
    try {
      const length = Math.min(info.size, META_BYTES)
      buffer = Buffer.allocUnsafe(length)
      fs.readSync(handle, buffer, 0, length, 0)
    } finally {
      fs.closeSync(handle)
    }
  } catch (_error) {
    buffer = undefined
  }

  if (buffer !== undefined && buffer.length >= ZSTD_MAGIC.length) {
    let header = false
    try {
      decodeFrames(buffer, (line) => {
        let record
        try {
          record = JSON.parse(line)
        } catch (_error) {
          return false
        }
        if (record?.type === 'session' && header === false) {
          header = true
          if (typeof record.id === 'string') result.id = record.id
          if (typeof record.version === 'number') result.version = record.version
          if (typeof record.createdAt === 'number') result.createdAt = record.createdAt
          if (typeof record.cwd === 'string') result.cwd = record.cwd
          if (typeof record.agentPreset === 'string') result.agentPreset = record.agentPreset
          if (typeof record.origin === 'string') result.origin = record.origin
          if (typeof record.parentSession === 'string') result.parent = record.parentSession
          return false
        }
        const prompt = promptOf(record)
        if (prompt !== undefined) {
          result.title = prompt
          return true
        }
        return false
      })
    } catch (_error) {
      // A damaged log still yields a listing row; only its metadata is missing.
    }
  }

  metaCache.set(key, result)
  if (metaCache.size > 4096) {
    // Bounded cache: the oldest insert goes first, which is enough for a UI list.
    const oldest = metaCache.keys().next()
    if (!oldest.done) metaCache.delete(oldest.value)
  }
  return result
}

/**
 * Hash a file's bytes.
 * @param buffer - the bytes to hash.
 * @returns lowercase hex SHA-256.
 */
export function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** Byte offset just past the first zstd frame. */
function firstFrameEnd(buffer) {
  const offsets = frameOffsets(buffer)
  return offsets.length > 1 ? offsets[1] : buffer.length
}

/**
 * Decode only the first frame, as text.
 * @param buffer - raw container bytes.
 * @returns the frame's text, or undefined when it cannot be decoded.
 */
function firstFrameText(buffer) {
  try {
    return zlib.zstdDecompressSync(buffer.subarray(0, firstFrameEnd(buffer))).toString('utf8')
  } catch (_error) {
    return undefined
  }
}

/**
 * How many append batches a log holds.
 *
 * The engine compresses each append into its own frame, so a log that has been
 * continued on another device has strictly more frames than the copy it started
 * from. That makes frame count a better "newer" oracle than byte size once a
 * sync has rewritten a header (which shifts size by a few bytes without
 * changing how much conversation the log holds).
 *
 * @param buffer - raw container bytes.
 */
export function frameCount(buffer) {
  return frameOffsets(buffer).length
}

/**
 * Hash a log's content while ignoring the header's `cwd`.
 *
 * Two copies of the same session that differ only in the directory the session
 * was started in must compare equal: a sync rewrites `cwd` when it mirrors a
 * session to the other machine, and without this the mirror would look like a
 * different, conflicting log on every single round.
 *
 * @param buffer - raw container bytes.
 * @returns lowercase hex SHA-256, or undefined when the log cannot be read.
 */
export function normalizedDigest(buffer) {
  const head = firstFrameText(buffer)
  if (head === undefined) return undefined
  const lines = head.split('\n')
  let header = null
  try {
    const record = JSON.parse(lines[0])
    if (record?.type === 'session') {
      header = { ...record, cwd: '' }
      lines[0] = JSON.stringify(header)
    }
  } catch (_error) {
    // Not a header line: hash the frame verbatim.
  }
  const hash = crypto.createHash('sha256')
  hash.update(lines.join('\n'))
  hash.update('\u0000')
  hash.update(buffer.subarray(firstFrameEnd(buffer)))
  return hash.digest('hex')
}

/**
 * Rewrite the `cwd` recorded in a log's header, leaving every other byte of the
 * log alone.
 *
 * Only the first frame is re-encoded; the remaining frames are copied verbatim,
 * because re-compressing them would discard the append structure the engine
 * relies on to resume a session.
 *
 * @param buffer - raw container bytes.
 * @param cwd - the directory the session should claim.
 * @returns the rewritten bytes, or undefined when the header cannot be read.
 */
export function rewriteCwd(buffer, cwd) {
  const head = firstFrameText(buffer)
  if (head === undefined) return undefined
  const lines = head.split('\n')
  let record
  try {
    record = JSON.parse(lines[0])
  } catch (_error) {
    return undefined
  }
  if (record?.type !== 'session') return undefined
  if (record.cwd === cwd) return buffer
  record.cwd = cwd
  lines[0] = JSON.stringify(record)
  const frame = zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'))
  return Buffer.concat([frame, buffer.subarray(firstFrameEnd(buffer))])
}

/**
 * Is this path a session log, and is it in a shape this plugin will move?
 * @param relative - a slash-separated path relative to the sessions root.
 * @returns true for `<project>/<session>/session.v<N>.jsonl.zstd`.
 */
export function isSessionPath(relative) {
  const parts = relative.split('/').filter((part) => part.length > 0)
  if (parts.length !== 3) return false
  if (parts.some((part) => part === '.' || part === '..')) return false
  return LOG_NAME.test(parts[2])
}

/**
 * Is this session log's format version one this desktop can read back?
 * @param version - the version parsed out of the file name or header.
 * @returns true for v1 through v4, the formats the current engine understands.
 */
export function supportedVersion(version) {
  return Number.isInteger(version) && version >= 1 && version <= 4
}

/**
 * Walk the sessions root and describe every session log it holds.
 * @param root - absolute path of `<DSH_HOME>/sessions`.
 * @returns entries sorted newest first; an unreadable root yields an empty list.
 */
export function scan(root) {
  const entries = []
  let projects
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch (_error) {
    return entries
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = fs.readdirSync(path.join(root, project.name), { withFileTypes: true })
    } catch (_error) {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = path.join(root, project.name, session.name)
      let files
      try {
        files = fs.readdirSync(dir, { withFileTypes: true })
      } catch (_error) {
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !LOG_NAME.test(file.name)) continue
        const absolute = path.join(dir, file.name)
        let stat
        try {
          stat = fs.statSync(absolute)
        } catch (_error) {
          continue
        }
        const meta = readMeta(absolute, stat)
        entries.push({
          id: meta.id,
          project: project.name,
          dir: session.name,
          file: file.name,
          version: meta.version,
          bytes: stat.size,
          mtime: Math.trunc(stat.mtimeMs),
          createdAt: meta.createdAt,
          cwd: meta.cwd,
          agentPreset: meta.agentPreset,
          origin: meta.origin,
          parent: meta.parent,
          title: meta.title,
          relative: `${project.name}/${session.name}/${file.name}`,
        })
      }
    }
  }
  entries.sort((left, right) => right.mtime - left.mtime)
  return entries
}

/**
 * Locate the on-disk file currently holding a session id.
 * @param root - absolute path of the sessions root.
 * @param id - the session id to look for.
 * @returns `{ file, relative, project, dir, bytes, mtime }`, or undefined.
 */
export function findSession(root, id) {
  let projects
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch (_error) {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let files
    try {
      files = fs.readdirSync(path.join(root, project.name, id), { withFileTypes: true })
    } catch (_error) {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !LOG_NAME.test(file.name)) continue
      const absolute = path.join(root, project.name, id, file.name)
      const stat = fs.statSync(absolute)
      return {
        file: absolute,
        relative: `${project.name}/${id}/${file.name}`,
        project: project.name,
        dir: id,
        bytes: stat.size,
        mtime: Math.trunc(stat.mtimeMs),
      }
    }
  }
  return undefined
}

/**
 * Verify that an incoming log really is a DSH session log.
 * @param buffer - the received bytes.
 * @returns the header record, or undefined when the bytes are not a session log.
 */
export function verifyLog(buffer) {
  if (buffer.length < ZSTD_MAGIC.length || !buffer.subarray(0, 4).equals(ZSTD_MAGIC)) return undefined
  let header
  try {
    decodeFrames(buffer.subarray(0, Math.min(buffer.length, META_BYTES)), (line) => {
      try {
        const record = JSON.parse(line)
        if (record?.type === 'session') {
          header = record
          return true
        }
      } catch (_error) {
        // Skip a damaged line; the next frame may still carry the header.
      }
      return false
    })
  } catch (_error) {
    return undefined
  }
  return header
}

/**
 * Copy a file aside, preserving its project/session placement.
 * @returns the backup path.
 */
function backup(file, root, backupDir) {
  const relative = path.relative(root, file)
  const target = path.join(backupDir, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(file, target)
  return target
}

/**
 * Write bytes to a path through a temporary file, so a reader never sees a partial log.
 * @param file - destination path.
 * @param buffer - the bytes to write.
 */
export function writeAtomic(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, buffer)
  fs.renameSync(temp, file)
}

/**
 * Move a session log into the project directory its header now names.
 *
 * The engine computes a log's path as `sessions/<projectKey(header.cwd)>/<id>`,
 * so a log whose directory and header disagree is simply not found — rewriting
 * `cwd` without moving the file hides the session. Empty directories left behind
 * are removed: a project directory with no sessions is a phantom workspace in
 * the sidebar.
 *
 * @param root - the sessions root.
 * @param existing - `{ file, relative, project }` as returned by `findSession`.
 * @param project - the project key the log belongs in now.
 * @param id - the session id.
 * @returns `{ file, relative }` pointing at the log's current location.
 */
function relocate(root, existing, project, id) {
  if (project === existing.project || project.length === 0) {
    return { file: existing.file, relative: existing.relative }
  }
  const name = path.basename(existing.file)
  const target = path.join(root, project, id, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.renameSync(existing.file, target)
  } catch (_error) {
    // A cross-device move (a sessions root with a mount inside it) cannot be a
    // rename; copy and unlink keeps the same end state.
    fs.copyFileSync(existing.file, target)
    fs.rmSync(existing.file, { force: true })
  }
  // Tidy up: an emptied session directory, then an emptied project directory.
  for (const dir of [path.dirname(existing.file), path.dirname(path.dirname(existing.file))]) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    } catch (_error) {
      // Still occupied, already gone, or not ours to remove.
    }
  }
  return { file: target, relative: `${project}/${id}/${name}` }
}

/**
 * Point a log's header at `cwd`, leaving the bytes alone when it already agrees.
 * @param buffer - the log's bytes.
 * @param cwd - the directory it should claim.
 * @returns the bytes to store (the input buffer when nothing needs changing).
 */
function alignCwd(buffer, cwd) {
  if (typeof cwd !== 'string') return buffer
  const header = verifyLog(buffer)
  if (header === undefined || header.cwd === cwd) return buffer
  return rewriteCwd(buffer, cwd) ?? buffer
}

/**
 * Merge one incoming session log into the local store.
 *
 * The rule is deliberately conservative: a session log only ever grows, so the
 * copy with more append frames is the newer one. Two copies whose content
 * matches once the header's `cwd` is ignored are the same session and neither is
 * touched — that is what stops a mirrored log from being re-imported forever
 * just because the two machines spell the project directory differently.
 *
 * An equal frame count with different content means the two devices diverged (an
 * edited or partially copied log) and the local copy is kept untouched — the
 * caller reports it so the user can decide.
 *
 * Whichever copy wins, the log ends up under the project directory its header
 * names: the engine looks a log up by `projectKey(header.cwd)`, so a session that
 * was relocated between machines has to move on disk as well as in its header.
 * The local copy's header is realigned for the same reason — a kept-local log
 * that still claimed the other machine's directory would be unreachable.
 *
 * @param root - absolute path of the sessions root.
 * @param incoming - `{ relative, data }` as extracted from the peer bundle.
 * @param backupDir - where a replaced local log is preserved.
 * @param options - `{ cwd, project }`: the directory the session should claim
 *   and the project slug it should live under, when relocating it.
 * @returns `{ status, relative, id, project }` with status one of
 *   `imported | kept-local | identical | diverged | rejected`.
 */
export function mergeOne(root, incoming, backupDir, options = {}) {
  const header = verifyLog(incoming.data)
  if (header === undefined) return { status: 'rejected', relative: incoming.relative, reason: 'not a session log' }

  // Identity comes from the path, because that is what the engine enumerates: a
  // session is found by looking for `<project>/<session-id>/`. The header id is
  // only a fallback, so a bundle whose directory and header disagree can never
  // link an incoming log to a different local session.
  const dirName = path.basename(path.dirname(incoming.relative))
  const headerId = typeof header.id === 'string' ? header.id : ''
  const id = dirName.length > 0 && dirName !== '.' ? dirName : headerId
  const project = options.project ?? incoming.relative.split('/')[0]
  const fileName = path.basename(incoming.relative)

  let data = incoming.data
  if (typeof options.cwd === 'string' && header.cwd !== options.cwd) {
    const rewritten = rewriteCwd(data, options.cwd)
    if (rewritten === undefined) {
      return { status: 'rejected', relative: incoming.relative, reason: 'header cwd could not be rewritten' }
    }
    data = rewritten
  }

  const existing = findSession(root, id)
  if (existing === undefined) {
    const target = path.join(root, project, id, fileName)
    writeAtomic(target, data)
    return {
      status: 'imported',
      relative: `${project}/${id}/${fileName}`,
      id,
      project,
      bytes: data.length,
      title: header.cwd ?? null,
    }
  }

  const localBytes = fs.readFileSync(existing.file)
  const localDigest = normalizedDigest(localBytes)
  const incomingDigest = normalizedDigest(data)
  const placed = (extra) => {
    const moved = relocate(root, existing, project, id)
    return { ...extra, relative: moved.relative, id, project }
  }

  if (localDigest !== undefined && localDigest === incomingDigest) {
    // Same conversation. The local copy may still be sitting in the other
    // machine's directory, so align and move it.
    const aligned = alignCwd(localBytes, options.cwd)
    if (aligned !== localBytes) writeAtomic(existing.file, aligned)
    return placed({ status: 'identical', bytes: aligned.length })
  }

  const localFrames = frameCount(localBytes)
  const incomingFrames = frameCount(data)
  const newer = incomingFrames > localFrames
    || (incomingFrames === localFrames && data.length > localBytes.length)
  if (!newer) {
    const status = incomingFrames === localFrames && data.length === localBytes.length ? 'diverged' : 'kept-local'
    const aligned = alignCwd(localBytes, options.cwd)
    if (aligned !== localBytes) writeAtomic(existing.file, aligned)
    return placed({ status, bytes: aligned.length, incoming: data.length })
  }

  backup(existing.file, root, path.join(backupDir, String(Date.now())))
  writeAtomic(existing.file, data)
  return placed({ status: 'imported', bytes: data.length, replaced: localBytes.length })
}
