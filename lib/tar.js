/**
 * A minimal tar reader/writer, so the desktop needs no external archiver.
 *
 * The phone side is a plain `sh` script that runs `tar czf -`, so reading has to
 * cope with whatever its tar emits: ustar as well as the GNU long-name and pax
 * extended-header records that a long directory name triggers. Writing is always
 * plain ustar with a `prefix`, which every tar in the Termux snapshot reads.
 *
 * @module lib/tar
 */
import zlib from 'node:zlib'

const BLOCK = 512

/** Write an octal field padded to `length` with a trailing NUL. */
function octal(value, length) {
  const text = Math.max(0, value).toString(8)
  return text.padStart(length - 1, '0') + '\u0000'
}

/** Split a path into the ustar `prefix` and `name` halves, or fail. */
function splitName(relative) {
  const clean = relative.replace(/^\.?\//, '')
  if (Buffer.byteLength(clean) <= 100) return { prefix: '', name: clean }
  for (let at = clean.lastIndexOf('/'); at > 0; at = clean.lastIndexOf('/', at - 1)) {
    const prefix = clean.slice(0, at)
    const name = clean.slice(at + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name }
  }
  throw new Error(`tar: path too long for ustar: ${relative}`)
}

/**
 * Build one 512-byte ustar header block.
 * @param relative - slash-separated path inside the archive.
 * @param size - byte length of the file body.
 * @param mtime - modification time in seconds.
 * @returns the header block.
 */
function header(relative, size, mtime) {
  const { prefix, name } = splitName(relative)
  const block = Buffer.alloc(BLOCK, 0)
  block.write(name, 0, 100, 'utf8')
  block.write(octal(0o644, 8), 100, 8, 'ascii')
  block.write(octal(0, 8), 108, 8, 'ascii')
  block.write(octal(0, 8), 116, 8, 'ascii')
  block.write(octal(size, 12), 124, 12, 'ascii')
  block.write(octal(mtime, 12), 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write('0', 156, 1, 'ascii')
  block.write('ustar\u0000', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\u0000 `, 148, 8, 'ascii')
  return block
}

/**
 * Pack entries into a gzipped tar archive.
 * @param entries - `{ relative, data, mtime? }` items; `mtime` is in milliseconds.
 * @returns the gzip-compressed archive bytes.
 */
export function pack(entries) {
  const parts = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const seconds = Math.trunc((entry.mtime ?? Date.now()) / 1000)
    parts.push(header(entry.relative, data.length, seconds), data)
    const pad = data.length % BLOCK
    if (pad !== 0) parts.push(Buffer.alloc(BLOCK - pad, 0))
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0))
  return zlib.gzipSync(Buffer.concat(parts))
}

/** Read a NUL-terminated ASCII/UTF-8 string out of a block slice. */
function text(block, offset, length) {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

/** Parse a pax extended-header body into its key/value records. */
function paxRecords(body) {
  const records = {}
  let at = 0
  while (at < body.length) {
    const space = body.indexOf(0x20, at)
    if (space === -1) break
    const length = Number.parseInt(body.subarray(at, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = body.subarray(space + 1, at + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    at += length
  }
  return records
}

/**
 * Unpack a gzipped (or plain) tar archive.
 *
 * Unknown entry types are skipped rather than rejected, and no path ever escapes
 * the archive root: every entry is returned as a normalized relative path and the
 * caller decides where to put it.
 *
 * @param buffer - archive bytes, gzipped or raw.
 * @returns `{ entries, skipped }` where entries carry `{ relative, data, mtime }`.
 */
export function unpack(buffer) {
  let raw = buffer
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) raw = zlib.gunzipSync(buffer)
  const entries = []
  const skipped = []
  let at = 0
  let longName
  let paxPath
  while (at + BLOCK <= raw.length) {
    const block = raw.subarray(at, at + BLOCK)
    at += BLOCK
    if (block.every((byte) => byte === 0)) break
    const size = Number.parseInt(text(block, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(block[156] === 0 ? 0x30 : block[156])
    const bodyStart = at
    const bodyEnd = Math.min(raw.length, bodyStart + size)
    const body = raw.subarray(bodyStart, bodyEnd)
    at = bodyStart + Math.ceil(size / BLOCK) * BLOCK

    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'x') {
      paxPath = paxRecords(body).path
      continue
    }
    if (type === 'g') continue
    if (type === '5') continue

    const prefix = text(block, 345, 155)
    const name = longName ?? paxPath ?? (prefix.length > 0 ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100))
    longName = undefined
    paxPath = undefined

    const relative = name.replace(/\\/g, '/').replace(/^\.?\//, '')
    if (relative.length === 0) continue
    if (relative.split('/').some((part) => part === '..')) {
      skipped.push(relative)
      continue
    }
    if (type !== '0' && type !== '7') {
      skipped.push(relative)
      continue
    }
    entries.push({
      relative,
      data: Buffer.from(body),
      mtime: Number.parseInt(text(block, 136, 12).trim() || '0', 8) * 1000,
    })
  }
  return { entries, skipped }
}
