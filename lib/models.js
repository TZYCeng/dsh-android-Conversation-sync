/**
 * The model channel: which patch entries may be mirrored, and the merge of
 * those entries (plus their credentials) into another machine's files.
 *
 * Mirroring models between two desktops is only sound for providers that bring
 * their own endpoint. A provider that a *plugin* injects has no `baseURL` in the
 * patch layer, because the plugin computes it at load time; copying such an
 * entry to a phone would point at an endpoint that does not exist there. The
 * filter is therefore structural rather than a list of names: an entry is
 * mirrorable exactly when its `config` carries a non-empty `baseURL`.
 *
 * Keys are the other half of the problem. They live in `.credentials.yaml`
 * under a top-level `refs:` mapping, and a model row refers to them by a token
 * (`apiKeyEnv: DEEPSEEK_API_KEY` or `apiKey: CUSTOM_API_KEY`). Only the names
 * travel — the values are read from the local credentials file at merge time,
 * and that is precisely why the models channel has to be opt-in.
 *
 * Both merges operate on text, never on parsed YAML: see `lib/patch.js` for why
 * a round trip through a parser would destroy the phone's own edits.
 *
 * @module lib/models
 */
import fs from 'node:fs'

import { digestText, mergeBlocks, splitBlocks } from './patch.js'

/** Endpoint keys an entry may use for its own base URL, in precedence order. */
const ENDPOINTS = ['baseURL', 'baseUrl', 'apiBase', 'base_url']
/** Config keys that name a credential ref explicitly, even when it is missing. */
const KEY_REFS = ['apiKeyRef', 'apiKey', 'keyRef', 'apiKeyEnv']
/** `key: value` at whatever indentation a line carries. */
const KEY_LINE = /^([A-Za-z0-9_$.-]+)\s*:\s*(.*)$/u
/** A flat key inside the `refs:` section. */
const REF_LINE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u
/** The run of spaces or tabs that indents a line. */
const LEAD = /^[ \t]*/u
/** A quoted or plain scalar, long enough to be a credential name. */
const TOKEN = /[A-Za-z0-9_][A-Za-z0-9_.-]*/gu

/**
 * Coerce input to the canonical text form: no BOM, `\n` line endings.
 * @param value - candidate text.
 */
function normalizeText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
}

/**
 * Remove an unquoted trailing `# comment`, keeping hashes that are part of a
 * value or hidden inside quotes.
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
 * Unwrap a quoted scalar; an unterminated quote yields what was read.
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
 * Read one scalar the way the loader would.
 * @param raw - text after the colon.
 * @returns the scalar, or null when there is none.
 */
function readScalar(raw) {
  const value = stripComment(String(raw ?? ''))
  if (value === '') return null
  if (value[0] === '"' || value[0] === "'") {
    const inner = unquote(value)
    return inner === '' ? null : inner
  }
  if (/^(?:~|null|Null|NULL)$/u.test(value)) return null
  return value
}

/** True for the truthy spellings the loader accepts on `disabled:`. */
function isTrue(value) {
  return value !== null && value !== undefined && /^(?:true|yes|on|1)$/iu.test(value)
}

/**
 * Locate the top-level `refs:` section.
 *
 * It is recognised by its line rather than by parsing the document, so
 * `records:` — a structured block this module has no business understanding —
 * is never touched.
 * @param lines - document lines, already newline-normalised.
 * @returns `{ headerAt, end, indent }`; `headerAt` is -1 when there is no section.
 */
function refSection(lines) {
  const headerAt = lines.findIndex((line) => {
    if (line.trim() === '' || /^\s/u.test(line)) return false
    const match = /^refs\s*:\s*(.*)$/u.exec(line)
    if (match === null) return false
    const rest = stripComment(match[1]).trim()
    return rest === '' || rest === '{}'
  })
  if (headerAt === -1) return { headerAt: -1, end: lines.length, indent: '  ' }

  // A section runs until the next column-0 key; blank lines inside it do not end it.
  let end = lines.length
  for (let index = headerAt + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (!/^\s/u.test(line)) {
      end = index
      break
    }
  }

  let indent = null
  for (let index = headerAt + 1; index < end; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    const lead = LEAD.exec(line)[0]
    if (lead !== '') {
      indent = lead
      break
    }
  }
  return { headerAt, end, indent: indent ?? '  ' }
}

/**
 * Credential refs (`refs:` map) parsed out of a `.credentials.yaml`.
 *
 * Values are returned raw — quotes and all — because the same text is written
 * back into the phone's file, and re-quoting a JSON payload would corrupt it.
 * @param file - absolute path to the credentials file.
 * @returns a Map of name to raw value; empty when the file is missing or unreadable.
 */
export function credentialRefs(file) {
  const refs = new Map()
  if (typeof file !== 'string' || file === '') return refs

  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (_error) {
    return refs
  }

  const lines = normalizeText(text).split('\n')
  const { headerAt, end, indent } = refSection(lines)
  if (headerAt === -1) return refs

  for (let index = headerAt + 1; index < end; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    if (LEAD.exec(line)[0] !== indent) continue
    const match = REF_LINE.exec(line.trim())
    if (match === null) continue
    if (!refs.has(match[1])) refs.set(match[1], stripComment(match[2]))
  }
  return refs
}

/**
 * Entry-level scalars: the keys written at the block's shallowest indent, which
 * is where the loader reads `id:`, `name:` and `disabled:` from.
 * @param blockText - one block, starting with `- `.
 */
function entryKeys(blockText) {
  const lines = normalizeText(blockText).split('\n')
  const keys = new Map()

  let indent = Infinity
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const lead = LEAD.exec(line)[0].length
    if (lead < indent) indent = lead
  }
  if (!Number.isFinite(indent)) return keys

  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (LEAD.exec(line)[0].length !== indent) continue
    const match = KEY_LINE.exec(trimmed)
    if (match !== null && !keys.has(match[1])) keys.set(match[1], match[2])
  }
  return keys
}

/**
 * Read the list under `config.models`, whose items may be plain strings or
 * maps naming the model with `id` or `name`.
 * @param rows - config rows `{ lead, text }` in document order.
 * @param from - index of the `models:` row.
 * @returns the model ids (or names, for an item that is only a name).
 */
function modelsFrom(rows, from) {
  const relevant = []
  for (let index = from + 1; index < rows.length; index += 1) {
    const row = rows[index]
    // A key back at the models' own indent ends the list.
    if (row.lead <= rows[from].lead && KEY_LINE.test(row.text)) break
    relevant.push(row)
  }

  const items = []
  let itemLead = null
  let item = null
  for (const row of relevant) {
    const itemMatch = /^-\s+(.*)$/u.exec(row.text)
    if (itemLead === null && itemMatch !== null) itemLead = row.lead
    if (itemMatch !== null && row.lead === itemLead) {
      if (item !== null) items.push(item)
      const inner = itemMatch[1]
      const pair = KEY_LINE.exec(inner)
      item = { id: null, name: null, plain: null }
      if (pair === null) item.plain = readScalar(inner)
      else if (pair[1] === 'id') item.id = readScalar(pair[2])
      else if (pair[1] === 'name') item.name = readScalar(pair[2])
      continue
    }
    if (item === null) continue
    const pair = KEY_LINE.exec(row.text)
    if (pair === null) continue
    // A map item usually names itself inline; `- {` forms aside, take a later
    // `id:`/`name:` when the inline part did not carry one.
    if (item.id === null && pair[1] === 'id') item.id = readScalar(pair[2])
    else if (item.name === null && pair[1] === 'name') item.name = readScalar(pair[2])
  }
  if (item !== null) items.push(item)

  return items
    .map(entry => entry.id ?? entry.name ?? entry.plain)
    .filter(value => typeof value === 'string' && value !== '')
}

/**
 * Read an entry's `config` block: its direct scalar children plus every scalar
 * below it, which is what the credential-token scan needs.
 * @param blockText - one block, starting with `- `.
 * @returns `{ direct, scalars, models }`; `direct` is a Map of first-level keys.
 */
function configOf(blockText) {
  const lines = normalizeText(blockText).split('\n')
  const empty = { direct: new Map(), scalars: [], models: [] }

  let headerAt = -1
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (LEAD.exec(line)[0].length === 0) continue
    const match = /^config\s*:\s*(.*)$/u.exec(trimmed)
    if (match !== null && stripComment(match[1]).trim() === '') {
      headerAt = index
      break
    }
  }
  if (headerAt === -1) return empty

  const headerIndent = LEAD.exec(lines[headerAt])[0].length
  const rows = []
  for (let index = headerAt + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '') continue
    const lead = LEAD.exec(line)[0].length
    if (lead <= headerIndent) break
    if (trimmed.startsWith('#')) continue
    rows.push({ lead, text: trimmed })
  }
  if (rows.length === 0) return empty

  let childIndent = Infinity
  for (const row of rows) if (row.lead < childIndent) childIndent = row.lead

  const direct = new Map()
  const scalars = []
  let modelsAt = -1
  rows.forEach((row, index) => {
    const pair = KEY_LINE.exec(row.text)
    if (pair !== null) {
      scalars.push({ key: pair[1], value: pair[2] })
      if (row.lead === childIndent) {
        if (!direct.has(pair[1])) direct.set(pair[1], pair[2])
        if (pair[1] === 'models' && modelsAt === -1) modelsAt = index
      }
      return
    }
    const itemMatch = /^-\s+(.*)$/u.exec(row.text)
    if (itemMatch === null) return
    const inner = KEY_LINE.exec(itemMatch[1])
    scalars.push({ key: null, value: inner === null ? itemMatch[1] : inner[2] })
  })

  return {
    direct,
    scalars,
    models: modelsAt === -1 ? [] : modelsFrom(rows, modelsAt),
  }
}

/** Leading indent width of one line. */
function leadLength(line) {
  return LEAD.exec(line)[0].length
}

/**
 * Index of the first line at or above `at`'s own indent — where `at`'s section
 * ends (exclusive). Blank lines and comments never end a section: a column-0
 * comment inside an entry (the loader allows one anywhere) is not its sibling.
 * @param lines - document lines.
 * @param at - index of the section's header line.
 */
function sectionEnd(lines, at) {
  const indent = leadLength(lines[at])
  for (let index = at + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (leadLength(lines[index]) <= indent) return index
  }
  return lines.length
}

/**
 * The `config.providers` entry ranges of one patch block, in document order.
 *
 * Providers are a *mapping* under `config.providers:`, one key per provider,
 * each with its own nested model list. This finds each provider's subtree so it
 * can be mirrored (or merged) as one unit — the model channel's natural group.
 *
 * @param lines - the block's lines.
 * @returns `[{ name, from, to, indent }]`; empty when the block has no such map.
 */
function providerEntries(lines) {
  // The block's direct keys start at the shallowest indent below the `- ` line.
  let blockLead = Infinity
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const lead = leadLength(lines[index])
    if (lead < blockLead) blockLead = lead
  }
  if (!Number.isFinite(blockLead)) return []

  const configAt = lines.findIndex((line, index) => {
    if (index === 0 || line.trim() === '' || line.trim().startsWith('#')) return false
    if (leadLength(line) !== blockLead) return false
    const match = /^config\s*:\s*(.*)$/u.exec(line.trim())
    return match !== null && stripComment(match[1]).trim() === ''
  })
  if (configAt === -1) return []

  const configEnd = sectionEnd(lines, configAt)
  let childLead = Infinity
  for (let index = configAt + 1; index < configEnd; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    childLead = Math.min(childLead, leadLength(lines[index]))
  }
  if (!Number.isFinite(childLead)) return []

  const providersAt = lines.findIndex((line, index) => {
    if (index <= configAt || index >= configEnd) return false
    if (line.trim() === '' || line.trim().startsWith('#')) return false
    if (leadLength(line) !== childLead) return false
    const match = /^providers\s*:\s*(.*)$/u.exec(line.trim())
    return match !== null
  })
  if (providersAt === -1) return []
  const inline = /^providers\s*:\s*(.*)$/u.exec(lines[providersAt].trim())?.[1] ?? ''
  // `providers: {}` (or `providers: ~`) would have to become a block before a
  // provider could be inserted; the merge treats a non-empty value as empty.
  if (stripComment(inline).trim() !== '' && stripComment(inline).trim() !== '{}') return []

  const providersEnd = sectionEnd(lines, providersAt)
  let keyLead = Infinity
  for (let index = providersAt + 1; index < providersEnd; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    keyLead = Math.min(keyLead, leadLength(lines[index]))
  }
  if (!Number.isFinite(keyLead)) return []

  const starts = []
  for (let index = providersAt + 1; index < providersEnd; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (leadLength(lines[index]) === keyLead) starts.push(index)
  }

  const entries = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    // An entry owns everything deeper than its key line. A line at the key's
    // indent (the next provider, or a column-0 comment that ends the map) is
    // not part of it.
    let to = from
    for (let at = from + 1; at < providersEnd; at += 1) {
      if (lines[at].trim() === '') continue
      if (leadLength(lines[at]) <= keyLead) break
      to = at
    }
    const match = /^([^:]+?)\s*:\s*(.*)$/u.exec(lines[from].trim())
    if (match === null) continue
    const name = readScalar(match[1]) ?? match[1].trim()
    if (name === '') continue
    entries.push({ name, from, to, indent: keyLead })
  }
  return entries
}

/**
 * Read one provider subtree: its scalar fields, model ids and credential refs.
 * @param lines - the block's lines.
 * @param entry - one item from `providerEntries`.
 * @param known - credential refs the local machine holds.
 */
function providerInfo(lines, entry, known) {
  const rows = []
  let childLead = Infinity
  for (let index = entry.from + 1; index <= entry.to; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    childLead = Math.min(childLead, leadLength(lines[index]))
  }

  const direct = new Map()
  const scalars = []
  let modelsAt = -1
  for (let index = entry.from + 1; index <= entry.to; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const lead = leadLength(line)
    rows.push({ index, lead, text: trimmed })
    const pair = KEY_LINE.exec(trimmed)
    if (pair !== null) {
      scalars.push({ key: pair[1], value: pair[2] })
      if (lead === childLead) {
        if (!direct.has(pair[1])) direct.set(pair[1], pair[2])
        if (pair[1] === 'models' && modelsAt === -1) modelsAt = index
      }
      continue
    }
    const item = /^-\s+(.*)$/u.exec(trimmed)
    if (item !== null) {
      const inner = KEY_LINE.exec(item[1])
      scalars.push({ key: null, value: inner === null ? item[1] : inner[2] })
    }
  }

  const models = modelsAt === -1
    ? []
    : modelsFrom(rows, rows.findIndex(row => row.index === modelsAt))

  let endpoint = null
  let baseURL = null
  for (const key of ENDPOINTS) {
    if (!direct.has(key)) continue
    const value = readScalar(direct.get(key))
    if (value !== null) {
      endpoint = key
      baseURL = value
      break
    }
  }

  const keys = []
  const remember = (name) => {
    if (typeof name === 'string' && name !== '' && !keys.includes(name)) keys.push(name)
  }
  for (const key of KEY_REFS) {
    if (direct.has(key)) remember(readScalar(direct.get(key)))
  }
  for (const scalar of scalars) {
    for (const token of String(scalar.value ?? '').match(TOKEN) ?? []) {
      if (known.has(token)) remember(token)
    }
  }

  const displayName = readScalar(direct.get('displayName'))

  return {
    endpoint,
    baseURL,
    displayName,
    models,
    keys,
    hasKey: keys.length === 0 || keys.every(key => known.has(key)),
    disabled: isTrue(readScalar(direct.get('disabled'))),
  }
}

/**
 * Every model *group* this machine can mirror.
 *
 * A group is the unit the panel offers and the planner sends:
 *
 * - `kind: 'row'` — a whole patch entry that carries its own `baseURL`;
 * - `kind: 'provider'` — one provider inside a `config.providers:` mapping (the
 *   shape most installs use: `llm-pi-ai` owns many providers).
 *
 * Groups are discovered **regardless of who loads them**: the profile's own
 * patch layer first, then every installed plugin's bundle patch (a plugin that
 * declares a provider, e.g. a local proxy, is still listed — its group is tagged
 * with the plugin so the panel can say it needs that plugin on the phone too).
 *
 * `key` is what the user's per-group switch is stored under: `rowId` for a row,
 * `rowId/provider` for a provider.
 *
 * @param options - `{ patchFile, credentialsFile?, plugins? }`; `plugins` is the
 *   output of `listPlugins` (each record may carry `patchFile`).
 * @returns a list of groups, profile groups first; empty on a missing patch.
 */
export function listModels(options) {
  const known = credentialRefs(options?.credentialsFile)
  const found = []
  const seen = new Set()

  const collect = (file, source, plugin) => {
    if (typeof file !== 'string' || file === '') return
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (_error) {
      return
    }
    for (const block of splitBlocks(text).blocks) {
      const blockKey = block.id ?? block.name
      if (blockKey === null) continue
      const lines = normalizeText(block.text).split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

      // A whole entry with its own endpoint: mirror it as one block.
      const config = configOf(block.text)
      let endpoint = null
      let baseURL = null
      for (const key of ENDPOINTS) {
        if (!config.direct.has(key)) continue
        const value = readScalar(config.direct.get(key))
        if (value !== null) {
          endpoint = key
          baseURL = value
          break
        }
      }

      if (baseURL !== null && !seen.has(blockKey)) {
        const keys = []
        const remember = (name) => {
          if (typeof name === 'string' && name !== '' && !keys.includes(name)) keys.push(name)
        }
        for (const key of KEY_REFS) {
          if (config.direct.has(key)) remember(readScalar(config.direct.get(key)))
        }
        for (const scalar of config.scalars) {
          for (const token of String(scalar.value ?? '').match(TOKEN) ?? []) {
            if (known.has(token)) remember(token)
          }
        }
        seen.add(blockKey)
        found.push({
          key: blockKey,
          kind: 'row',
          id: block.id,
          name: block.name,
          rowId: block.id,
          rowName: block.name,
          provider: readScalar(config.direct.get('provider')) ?? block.id,
          label: readScalar(config.direct.get('displayName')) ?? block.id ?? block.name,
          displayName: readScalar(config.direct.get('displayName')) ?? '',
          endpoint,
          baseURL,
          models: config.models,
          keys,
          text: block.text,
          hasKey: keys.length === 0 || keys.every(key => known.has(key)),
          disabled: isTrue(readScalar(entryKeys(block.text).get('disabled'))),
          source,
          plugin,
        })
      }

      // Every provider inside `config.providers:` is a group of its own.
      for (const entry of providerEntries(lines)) {
        const key = `${blockKey}/${entry.name}`
        if (seen.has(key)) continue
        const info = providerInfo(lines, entry, known)
        seen.add(key)
        found.push({
          key,
          kind: 'provider',
          id: block.id,
          name: block.name,
          rowId: blockKey,
          rowName: block.name,
          provider: entry.name,
          label: info.displayName || entry.name,
          displayName: info.displayName ?? '',
          endpoint: info.endpoint,
          baseURL: info.baseURL,
          models: info.models,
          keys: info.keys,
          indent: entry.indent,
          lines: lines.slice(entry.from, entry.to + 1),
          text: `${lines.slice(entry.from, entry.to + 1).join('\n')}\n`,
          hasKey: info.hasKey,
          disabled: info.disabled,
          source,
          plugin,
        })
      }
    }
  }

  collect(options?.patchFile, 'profile', null)
  for (const plugin of Array.isArray(options?.plugins) ? options.plugins : []) {
    if (plugin === null || typeof plugin !== 'object') continue
    const name = typeof plugin.name === 'string' ? plugin.name : null
    if (name === null) continue
    collect(plugin.patchFile ?? null, 'plugin', name)
  }

  const rank = (group) => (group.source === 'profile' ? 0 : 1)
  found.sort((left, right) => {
    if (rank(left) !== rank(right)) return rank(left) - rank(right)
    const a = String(left.key ?? '')
    const b = String(right.key ?? '')
    if (a === b) return 0
    return a < b ? -1 : 1
  })
  return found
}

/**
 * Merge chosen model groups into the phone's patch text.
 *
 * Two shapes, matching `listModels`:
 *
 * - a **row group** is merged as one whole top-level entry (by id, then name);
 * - a **provider group** is merged *inside* the phone's entry with the same
 *   `id`, under `config.providers.<name>` — never as a second entry with that
 *   id, because a patch entry replaces the whole config and a duplicate id would
 *   wipe every other provider the phone already had.
 *
 * @param phonePatchText - the patch document currently on the phone.
 * @param groups - model groups from `listModels`, or raw block texts.
 * @returns `{ text, digest, added, replaced }`; `digest` lets a caller skip an identical round.
 */
export function buildMergedPatch(phonePatchText, groups) {
  const blocks = []
  const providers = new Map()
  for (const group of Array.isArray(groups) ? groups : []) {
    if (typeof group === 'string') {
      if (group.trim() !== '') blocks.push(group)
      continue
    }
    if (group === null || typeof group !== 'object') continue
    if (group.kind === 'provider' && typeof group.rowId === 'string' && group.rowId !== '') {
      if (!providers.has(group.rowId)) {
        providers.set(group.rowId, { rowId: group.rowId, rowName: group.rowName ?? null, providers: [] })
      }
      if (Array.isArray(group.lines) && group.lines.length > 0) {
        providers.get(group.rowId).providers.push(group)
      }
      continue
    }
    if (typeof group.text === 'string' && group.text.trim() !== '') blocks.push(group.text)
  }

  const rows = mergeBlocks(phonePatchText, blocks)
  let text = rows.text
  let added = rows.added
  let replaced = rows.replaced
  if (providers.size > 0) {
    const merged = mergeProviders(text, [...providers.values()])
    text = merged.text
    added += merged.added
    replaced += merged.replaced
  }
  return { text, digest: digestText(text), added, replaced }
}

/** Quote a scalar for a YAML mapping value. */
function quoteScalar(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_@./$+-]+$/u.test(text)) return text
  return `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/** Always double-quote a value (a `@scope/name` must never be a plain scalar). */
function alwaysQuote(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/**
 * A fresh top-level entry that carries providers and nothing else.
 * @param spec - `{ rowId, rowName, providers }`.
 */
function freshProviderBlock(spec) {
  const lines = [`- id: ${quoteScalar(spec.rowId)}`]
  if (typeof spec.rowName === 'string' && spec.rowName !== '') {
    lines.push(`  name: ${alwaysQuote(spec.rowName)}`)
  }
  lines.push('  config:', '    providers:')
  for (const provider of spec.providers) {
    lines.push(`      ${provider.provider}:`)
    const sourceIndent = typeof provider.indent === 'number' ? provider.indent : leadLength(provider.lines[0])
    for (const line of reindentProvider(provider.lines.slice(1), sourceIndent, 6)) {
      lines.push(line)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Re-indent one provider subtree to a target indent.
 * @param lines - raw subtree lines (first line is the provider key).
 * @param sourceIndent - the original indent of the key line.
 * @param targetIndent - the indent the key line should have.
 */
function reindentProvider(lines, sourceIndent, targetIndent) {
  const delta = targetIndent - sourceIndent
  const out = []
  for (const line of lines) {
    if (line.trim() === '') {
      out.push('')
      continue
    }
    if (delta === 0) {
      out.push(line)
    } else if (delta > 0) {
      out.push(`${' '.repeat(delta)}${line}`)
    } else {
      const drop = Math.min(-delta, leadLength(line))
      out.push(line.slice(drop))
    }
  }
  return out
}

/**
 * Merge provider subtrees into one top-level entry of `originalText`.
 * @param originalText - the whole patch document.
 * @param specs - `[{ rowId, rowName, providers }]`.
 * @returns `{ text, added, replaced }`.
 */
function mergeProviders(originalText, specs) {
  const { header, blocks } = splitBlocks(originalText)
  let added = 0
  let replaced = 0

  for (const spec of specs) {
    const at = blocks.findIndex(block => block.id === spec.rowId || (block.id === null && block.name === spec.rowName))
    if (at === -1) {
      blocks.push({ id: spec.rowId, name: spec.rowName, text: freshProviderBlock(spec) })
      added += spec.providers.length
      continue
    }
    const result = mergeProvidersIntoBlock(blocks[at].text, spec)
    blocks[at].text = result.text
    added += result.added
    replaced += result.replaced
  }

  const joined = `${header}${blocks.map(block => block.text).join('')}`.replace(/\s+$/u, '')
  return { text: joined === '' ? '' : `${joined}\n`, added, replaced }
}

/**
 * Merge provider subtrees into one block's text, preserving every other line.
 * @param blockText - one block, starting with `- `.
 * @param spec - `{ providers }` as built by `buildMergedPatch`.
 * @returns `{ text, added, replaced }`.
 */
function mergeProvidersIntoBlock(blockText, spec) {
  const lines = normalizeText(blockText).replace(/\n$/u, '').split('\n')

  // The block's direct keys sit at its shallowest indent.
  let blockLead = Infinity
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    blockLead = Math.min(blockLead, leadLength(lines[index]))
  }
  if (!Number.isFinite(blockLead)) blockLead = 2

  let added = 0
  let replaced = 0

  let configAt = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '' || lines[index].trim().startsWith('#')) continue
    if (leadLength(lines[index]) !== blockLead) continue
    if (/^config\s*:\s*(?:#.*)?$/u.test(lines[index].trim())) {
      configAt = index
      break
    }
  }

  if (configAt === -1) {
    // No config at all: append one with the providers map.
    lines.push(`${' '.repeat(blockLead)}config:`)
    configAt = lines.length - 1
  }

  const configLead = leadLength(lines[configAt])
  const configEnd = sectionEnd(lines, configAt)
  let childLead = configLead + 2
  for (let index = configAt + 1; index < configEnd; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    childLead = Math.min(childLead, leadLength(lines[index]))
  }
  if (childLead <= configLead) childLead = configLead + 2

  let providersAt = -1
  for (let index = configAt + 1; index < configEnd; index += 1) {
    if (lines[index].trim() === '' || lines[index].trim().startsWith('#')) continue
    if (leadLength(lines[index]) !== childLead) continue
    if (/^providers\s*:\s*(.*)$/u.test(lines[index].trim())) {
      providersAt = index
      break
    }
  }

  if (providersAt === -1) {
    // Insert the map as the first child of `config:`.
    lines.splice(configAt + 1, 0, `${' '.repeat(childLead)}providers:`)
    providersAt = configAt + 1
  } else {
    // `providers: {}` has to become a block before anything can be added.
    const match = /^providers\s*:\s*(.*)$/u.exec(lines[providersAt].trim())
    if (match !== null && stripComment(match[1]).trim() !== '') {
      lines[providersAt] = `${' '.repeat(leadLength(lines[providersAt]))}providers:`
    }
  }

  const providersLead = leadLength(lines[providersAt])
  let providersEnd = sectionEnd(lines, providersAt)
  let keyLead = Infinity
  for (let index = providersAt + 1; index < providersEnd; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    keyLead = Math.min(keyLead, leadLength(lines[index]))
  }
  if (!Number.isFinite(keyLead) || keyLead <= providersLead) keyLead = providersLead + 2

  for (const provider of spec.providers) {
    if (!Array.isArray(provider.lines) || provider.lines.length === 0) continue
    const sourceIndent = typeof provider.indent === 'number' ? provider.indent : leadLength(provider.lines[0])
    const body = reindentProvider(provider.lines, sourceIndent, keyLead)
    // Recompute the section end each round: an insertion moves it.
    providersEnd = sectionEnd(lines, providersAt)
    let existing = -1
    for (let index = providersAt + 1; index < providersEnd; index += 1) {
      if (lines[index].trim() === '') continue
      if (leadLength(lines[index]) !== keyLead) continue
      const match = /^([^:]+?)\s*:\s*(.*)$/u.exec(lines[index].trim())
      if (match === null) continue
      if ((readScalar(match[1]) ?? match[1].trim()) === provider.provider) {
        existing = index
        break
      }
    }

    if (existing !== -1) {
      let stop = providersEnd
      for (let index = existing + 1; index < providersEnd; index += 1) {
        if (lines[index].trim() === '') continue
        if (leadLength(lines[index]) <= keyLead) {
          stop = index
          break
        }
      }
      let last = stop - 1
      while (last > existing && lines[last].trim() === '') last -= 1
      lines.splice(existing, last - existing + 1, ...body)
      replaced += 1
      continue
    }

    // Append after the last non-blank line of the providers section.
    let insertAt = providersEnd
    while (insertAt > providersAt + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1
    lines.splice(insertAt, 0, ...body)
    added += 1
  }

  const text = `${lines.join('\n')}\n`
  return { text, added, replaced }
}

/**
 * Merge chosen credential refs into the phone's credentials text.
 *
 * Only the `refs:` mapping is rewritten: `records:` holds this machine's own
 * grants and is never understood, let alone reformatted.
 * @param phoneText - the credentials document currently on the phone.
 * @param refs - ref names to mirror; their values come from `credentialsFile`.
 * @param credentialsFile - absolute path to the local credentials file.
 * @returns `{ text, digest, added, replaced }`.
 */
export function buildMergedCredentials(phoneText, refs, credentialsFile) {
  const values = credentialRefs(credentialsFile)

  const wanted = []
  for (const name of Array.isArray(refs) ? refs : []) {
    if (typeof name !== 'string') continue
    const clean = name.trim()
    if (clean === '' || wanted.includes(clean)) continue
    wanted.push(clean)
  }

  const lines = normalizeText(phoneText).split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let added = 0
  let replaced = 0
  const section = refSection(lines)

  if (section.headerAt === -1) {
    // No section yet: the mapping belongs at the end, after every existing
    // top-level key, so nothing that is already there has to move.
    const fresh = wanted.filter(name => values.has(name))
    if (fresh.length > 0) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
      lines.push('refs:')
      for (const name of fresh) {
        lines.push(`  ${name}: ${values.get(name)}`)
        added += 1
      }
    }
  } else {
    const { headerAt, end, indent } = section
    let lastContent = headerAt
    const rows = []
    for (let index = headerAt + 1; index < end; index += 1) {
      const line = lines[index]
      if (line.trim() === '') continue
      lastContent = index
      if (/^\s*#/u.test(line)) continue
      if (LEAD.exec(line)[0] !== indent) continue
      const match = REF_LINE.exec(line.trim())
      if (match !== null) rows.push({ index, name: match[1], lead: LEAD.exec(line)[0] })
    }

    const missing = []
    for (const name of wanted) {
      if (!values.has(name)) continue
      const row = rows.find(entry => entry.name === name)
      if (row === undefined) {
        missing.push(name)
        continue
      }
      lines[row.index] = `${row.lead}${name}: ${values.get(name)}`
      replaced += 1
    }
    if (missing.length > 0) {
      const appended = missing.map(name => `${indent}${name}: ${values.get(name)}`)
      lines.splice(lastContent + 1, 0, ...appended)
      added += missing.length
    }
  }

  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`
  return { text, digest: digestText(text), added, replaced }
}
