/**
 * Loader patch documents, handled as *text* rather than as parsed YAML.
 *
 * A profile's patch layer (`cordis.patch.yml`) is a YAML array, but this plugin
 * deliberately never parses it. The phone that receives a merged patch has no
 * Node and no YAML tooling, so the desktop has to ship the finished file back —
 * and a parse/serialize round trip would reflow the user's comments, drop keys
 * it did not understand, and re-quote every scalar. Instead one top-level entry
 * (a line starting with `- ` in column 0) is treated as a single verbatim
 * block, and blocks are replaced or appended as whole units. Comments, blank
 * lines, ordering and unknown entries therefore survive untouched.
 *
 * Newlines are normalised to `\n` on the way in. The loader accepts either
 * style, `digestText` ignores the difference, and block texts can then be
 * compared and concatenated without caring which machine they came from.
 *
 * @module lib/patch
 */
import crypto from 'node:crypto'

/** A top-level entry begins with a dash and whitespace in column 0. */
const ENTRY = /^-\s/u
/** `key: value` at whatever indentation the line carries, value possibly empty. */
const KEY_LINE = /^([A-Za-z0-9_$.-]+)\s*:\s*(.*)$/u
/** The run of spaces or tabs that indents a line. */
const LEAD = /^[ \t]*/u

/**
 * Coerce input to the canonical text form: no BOM, `\n` line endings.
 * Anything that is not a string becomes '', which is what every caller wants
 * from a missing file or a bad argument.
 * @param value - candidate text.
 */
function normalizeText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
}

/**
 * Remove an unquoted trailing `# comment` from a scalar value.
 * A `#` only starts a comment at the start of a token, so a value such as
 * `https://host/#frag` or `"a # b"` keeps its hash.
 * @param value - raw text after the colon.
 */
function stripComment(value) {
  let out = ''
  let quote = null
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]
    if (quote !== null) {
      out += ch
      if (ch === '\\' && quote === '"' && index + 1 < value.length) {
        out += value[index + 1]
        index += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    if (ch === '#' && (index === 0 || /\s/u.test(value[index - 1]))) break
    out += ch
  }
  return out.trim()
}

/**
 * Unwrap a quoted scalar. An unterminated quote simply yields what was read,
 * because a half-edited patch must not cost the caller the whole entry.
 * @param value - the value including its opening quote.
 */
function unquote(value) {
  const quote = value[0]
  let out = ''
  for (let index = 1; index < value.length; index += 1) {
    const ch = value[index]
    if (ch === '\\' && quote === '"' && index + 1 < value.length) {
      out += value[index + 1]
      index += 1
      continue
    }
    if (ch === quote) {
      if (quote === "'" && value[index + 1] === "'") {
        out += "'"
        index += 1
        continue
      }
      return out
    }
    out += ch
  }
  return out
}

/**
 * Read one scalar the way the loader would: strip a comment, unwrap quotes,
 * and treat YAML's null spellings as absent.
 * @param raw - text after the colon.
 * @returns the scalar, or null when there is none.
 */
function scalarValue(raw) {
  const value = stripComment(String(raw ?? ''))
  if (value === '') return null
  if (value[0] === '"' || value[0] === "'") {
    const inner = unquote(value)
    return inner === '' ? null : inner
  }
  if (/^(?:~|null|Null|NULL)$/u.test(value)) return null
  return value
}

/**
 * The entry's own keys: the ones written at the shallowest indent inside the
 * block, plus the key that shares the `- ` line.
 *
 * The indent is measured from the block rather than assumed to be two spaces,
 * because these layers are hand-edited and a file may be re-indented later.
 * @param blockText - one block, starting with `- `.
 * @returns `{ key, value }` pairs at that first level, in document order.
 */
function firstLevelPairs(blockText) {
  const lines = blockText.split('\n')
  const pairs = []
  const head = KEY_LINE.exec(lines[0].replace(/^-\s*/u, ''))
  if (head !== null) pairs.push({ key: head[1], value: head[2] })

  let indent = Infinity
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const lead = LEAD.exec(line)[0].length
    if (lead < indent) indent = lead
  }
  if (!Number.isFinite(indent)) return pairs

  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (LEAD.exec(line)[0].length !== indent) continue
    const match = KEY_LINE.exec(trimmed)
    if (match !== null) pairs.push({ key: match[1], value: match[2] })
  }
  return pairs
}

/**
 * The fields a merge matches on.
 * @param blockText - one block of text.
 * @returns `{ id, name }`, each null when the entry does not carry it.
 */
function blockFields(blockText) {
  const pairs = firstLevelPairs(blockText)
  const id = pairs.find(pair => pair.key === 'id')
  const name = pairs.find(pair => pair.key === 'name')
  return {
    id: id === undefined ? null : scalarValue(id.value),
    name: name === undefined ? null : scalarValue(name.value),
  }
}

/**
 * Canonical form of a block: no leading or trailing blank lines, a leading
 * `- ` when the caller handed over a bare entry body, and exactly one trailing
 * newline.
 *
 * Trailing blanks are dropped rather than kept so that the same entry merged
 * twice is byte-identical: an incoming copy has no separator and the document's
 * own spacing must not accumulate on every round.
 * @param raw - candidate block text.
 * @returns the canonical block, or '' when there is nothing in it.
 */
function normalizeBlock(raw) {
  const lines = normalizeText(raw).split('\n')
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length === 0) return ''
  if (!ENTRY.test(lines[0])) lines[0] = `- ${lines[0].trim()}`
  return `${lines.join('\n')}\n`
}

/**
 * Split a loader patch document into a verbatim header plus top-level blocks.
 *
 * The header is everything before the first `- ` line: the file's comments and
 * blank lines, which belong to the document rather than to any entry and so are
 * never rewritten. A file that is not an array at all (a scalar document, a
 * commented-out example, an empty file) comes back as a header and no blocks,
 * which every caller treats as "nothing to merge into".
 * @param text - the patch document, in any newline style.
 * @returns `{ header, blocks }`; each block is `{ id, name, text }`.
 */
export function splitBlocks(text) {
  const source = normalizeText(text)
  const lines = source.split('\n')
  // The empty tail left by a final newline is the terminator, not a line; it is
  // added back when the pieces are joined, so keeping it here would double it.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const headerLines = []
  const rawBlocks = []
  let current = null
  for (const line of lines) {
    if (ENTRY.test(line)) {
      if (current !== null) rawBlocks.push(current)
      current = [line]
    } else if (current === null) {
      headerLines.push(line)
    } else {
      current.push(line)
    }
  }
  if (current !== null) rawBlocks.push(current)

  const header = headerLines.length === 0 ? '' : `${headerLines.join('\n')}\n`
  const blocks = rawBlocks.map((raw) => {
    const body = raw.slice()
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    const blockText = `${body.join('\n')}\n`
    const fields = blockFields(blockText)
    return { id: fields.id, name: fields.name, text: blockText }
  })
  return { header, blocks }
}

/**
 * Replace entries by id and append the new ones; everything else is kept.
 *
 * Matching is by `id` first, then by `name` for an entry that carries no id
 * (a plugin fragment that is identified only by its package). Order is never
 * disturbed: a replacement takes the old slot, and an unmatched block is
 * appended after the last existing one, in the order given.
 * @param original - the document being merged into.
 * @param incoming - block texts to merge in, as `splitBlocks(...).blocks.map(b => b.text)` produces.
 * @returns `{ text, added, replaced }`; `text` ends with exactly one newline.
 */
export function mergeBlocks(original, incoming) {
  const { header, blocks } = splitBlocks(original)
  const working = blocks.map(block => ({ id: block.id, name: block.name, text: block.text }))

  // Index the slots once so a repeated incoming entry lands in the same place
  // and the counters describe distinct slots, not distinct input rows.
  const slots = new Map()
  working.forEach((block, position) => {
    const idKey = block.id === null ? null : `id:${block.id}`
    const nameKey = block.name === null ? null : `name:${block.name}`
    if (idKey !== null && !slots.has(idKey)) slots.set(idKey, position)
    if (nameKey !== null && !slots.has(nameKey)) slots.set(nameKey, position)
  })

  let added = 0
  let replaced = 0
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const blockText = normalizeBlock(raw)
    if (blockText === '') continue
    const fields = blockFields(blockText)
    const idKey = fields.id === null ? null : `id:${fields.id}`
    const nameKey = fields.name === null ? null : `name:${fields.name}`
    const slot = (idKey === null ? undefined : slots.get(idKey)) ?? (nameKey === null ? undefined : slots.get(nameKey))

    if (slot !== undefined) {
      working[slot] = { id: fields.id, name: fields.name, text: blockText }
      replaced += 1
      continue
    }
    const position = working.length
    working.push({ id: fields.id, name: fields.name, text: blockText })
    if (idKey !== null) slots.set(idKey, position)
    if (nameKey !== null) slots.set(nameKey, position)
    added += 1
  }

  const joined = `${header}${working.map(block => block.text).join('')}`.replace(/\s+$/u, '')
  return { text: joined === '' ? '' : `${joined}\n`, added, replaced }
}

/**
 * sha256 hex of a text, newlines normalised to `\n`.
 *
 * The digest is how a caller recognises a round that would change nothing: two
 * machines disagreeing only about CRLF are the same patch, and must not keep
 * shipping the file back and forth.
 * @param text - the text to hash.
 * @returns lowercase hex SHA-256.
 */
export function digestText(text) {
  return crypto.createHash('sha256').update(normalizeText(text), 'utf8').digest('hex')
}
