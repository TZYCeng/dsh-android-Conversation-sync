/**
 * Exercises the model channel without DSH: a throwaway desktop patch, a
 * throwaway credentials file, and a "phone" whose patch already holds an older
 * copy of the mirrored row — so the merge has to replace in place, append
 * nothing unwanted, and leave every other line byte-for-byte.
 *
 * Usage: node test/models.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { digestText, mergeBlocks, splitBlocks } from '../lib/patch.js'
import { buildMergedCredentials, buildMergedPatch, credentialRefs, listModels } from '../lib/models.js'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-models-test-'))

/** Write a fixture under the throwaway directory and return its path. */
function fixture(name, text) {
  const file = path.join(work, name)
  fs.writeFileSync(file, text)
  return file
}

// --- desktop patch: a mirrorable endpoint row, a plugin provider with no
// endpoint, an unrelated ui-settings entry, and comments above the first entry
const DESKTOP_HEADER =
  '# Desktop patch layer, mirrored to the phone.\n# Comments above the first entry must survive byte-for-byte.\n\n'
const DESKTOP_PATCH = `${DESKTOP_HEADER}- id: deepseek-official
  name: "@deepseek-ai/dsh-llm-deepseek"
  config:
    displayName: DeepSeek
    api: openai-completions
    provider: deepseek
    baseURL: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    models:
      - id: deepseek-v4.1-flash
        name: DeepSeek V4.1 Flash
        contextWindow: 1000000
        maxTokens: 384000
      - id: deepseek-v4-pro
        name: DeepSeek V4 Pro
        contextWindow: 1000000
        maxTokens: 384000
- id: plugin-injected
  name: dsh-opencode-connect
  config:
    provider: opencode-go
    apiKeyEnv: OPENCODE_GO_API_KEY
    models:
      - id: claude-haiku-5-5
        name: Claude Haiku 5.5
- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    enabled: false
`

// --- credentials: records are the desktop's own grants, refs are what a model
// row may name. UNUSED_REF and PACKED_KEY are never referenced by the row.
const CREDENTIALS = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      secret: phone-side-secret
refs:
  DEEPSEEK_API_KEY: sk-test-deepseek
  UNUSED_REF: sk-test-unused
  PACKED_KEY: '{"access_key_id":"AK","secret_access_key":"SK"}'
`
const credentialsFile = fixture('credentials.yaml', CREDENTIALS)
const desktopFile = fixture('desktop.patch.yml', DESKTOP_PATCH)

// --- the phone: its own layer, with an older copy of the mirrored row
const PHONE_HEADER = "# phone patch — the phone's own layer, never rewritten\n"
const PHONE_PATCH = `${PHONE_HEADER}- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: compact
- id: deepseek-official
  name: "@deepseek-ai/dsh-llm-deepseek"
  config:
    baseURL: https://old-laptop.local/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    models:
      - id: deepseek-v3
        name: DeepSeek V3
`

// --- splitBlocks
const desktop = splitBlocks(DESKTOP_PATCH)
assert.equal(desktop.header, DESKTOP_HEADER, 'header keeps its comments verbatim')
assert.equal(desktop.blocks.length, 3)
assert.deepEqual(
  desktop.blocks.map(block => block.id),
  ['deepseek-official', 'plugin-injected', 'ui-settings'],
)
assert.equal(desktop.blocks[0].name, '@deepseek-ai/dsh-llm-deepseek', 'quoted name is unquoted')
assert.equal(desktop.blocks[1].id, 'plugin-injected')
assert.ok(desktop.blocks.every(block => block.text.startsWith('- ') && block.text.endsWith('\n')))
console.log(`ok  splitBlocks -> header (${desktop.header.length} bytes) + ${desktop.blocks.length} blocks`)

// --- listModels: only the entry that carries its own endpoint survives
const rows = listModels({ patchFile: desktopFile, credentialsFile })
assert.deepEqual(rows.map(row => row.id), ['deepseek-official'], 'exactly the endpoint row is mirrorable')
const row = rows[0]
assert.equal(row.name, '@deepseek-ai/dsh-llm-deepseek')
assert.equal(row.endpoint, 'baseURL')
assert.equal(row.baseURL, 'https://api.deepseek.com/v1')
assert.equal(row.provider, 'deepseek')
assert.deepEqual(row.models, ['deepseek-v4.1-flash', 'deepseek-v4-pro'])
assert.deepEqual(row.keys, ['DEEPSEEK_API_KEY'], 'only the referenced ref is carried')
assert.equal(row.hasKey, true)
assert.equal(row.disabled, false)
assert.equal(row.text, desktop.blocks[0].text, 'row text is the raw block, ready to merge')
assert.equal(
  rows.some(entry => entry.id === 'plugin-injected' || entry.name === 'dsh-opencode-connect'),
  false,
  'a plugin-provided provider has no endpoint and must not be synced',
)
console.log(`ok  listModels -> ${row.id} (${row.models.length} models, keys=${row.keys.join(',')})`)

// --- a row whose own ref is missing still reports it, and is marked as keyless
const orphanFile = fixture(
  'orphan.patch.yml',
  `- id: orphan-provider
  name: "@deepseek-ai/dsh-llm-somewhere"
  disabled: true
  config:
    baseURL: https://nowhere.example/v1
    apiKeyRef: NOT_IN_CREDENTIALS
`,
)
const orphans = listModels({ patchFile: orphanFile, credentialsFile })
assert.equal(orphans.length, 1)
assert.deepEqual(orphans[0].keys, ['NOT_IN_CREDENTIALS'], 'an explicit ref is reported even when missing')
assert.equal(orphans[0].hasKey, false)
assert.equal(orphans[0].disabled, true)
console.log(`ok  listModels -> missing ref ${orphans[0].keys[0]} reports hasKey=false, disabled=true`)

// --- credentialRefs keeps values raw, so a JSON payload round-trips
const refs = credentialRefs(credentialsFile)
assert.equal(refs.size, 3, 'records: is not mistaken for a ref')
assert.equal(refs.get('DEEPSEEK_API_KEY'), 'sk-test-deepseek')
assert.equal(refs.get('UNUSED_REF'), 'sk-test-unused')
assert.equal(refs.get('PACKED_KEY'), `'{"access_key_id":"AK","secret_access_key":"SK"}'`, 'quotes are kept')
console.log(`ok  credentialRefs -> ${[...refs.keys()].join(', ')}`)

// --- mergeBlocks: replace in place, keep the phone's header and neighbours
const phone = splitBlocks(PHONE_PATCH)
assert.equal(phone.header, PHONE_HEADER)
const merged = mergeBlocks(PHONE_PATCH, rows.map(entry => entry.text))
assert.equal(merged.replaced, 1, 'the older copy is replaced, not appended')
assert.equal(merged.added, 0, 'no duplicate row is appended')
assert.equal(merged.text, buildMergedPatch(PHONE_PATCH, rows).text)
assert.ok(merged.text.startsWith(PHONE_HEADER), 'the phone header comment is untouched')
assert.ok(merged.text.includes(phone.blocks[0].text), 'the unrelated ui-chat entry is byte-identical')
assert.ok(merged.text.includes(row.text), 'the phone now carries the desktop copy')
assert.ok(!merged.text.includes('old-laptop.local'), 'the stale row is gone')
assert.equal(merged.text.split('- id: deepseek-official').length - 1, 1, 'exactly one copy remains')
assert.ok(merged.text.indexOf('- id: ui-chat') < merged.text.indexOf('- id: deepseek-official'), 'order is kept')
assert.equal(splitBlocks(merged.text).blocks.length, 2, 'nothing was added')
assert.ok(merged.text.endsWith('\n') && !merged.text.endsWith('\n\n'), 'exactly one trailing newline')
console.log(`ok  mergeBlocks -> replaced ${merged.replaced}, added ${merged.added}`)

// --- merging the desktop's own text with its own row is a literal no-op
const selfMerge = mergeBlocks(DESKTOP_PATCH, rows.map(entry => entry.text))
assert.equal(selfMerge.replaced, 1)
assert.equal(selfMerge.added, 0)
assert.equal(selfMerge.text, DESKTOP_PATCH, 'an unchanged row leaves every byte alone (ui-settings included)')
console.log('ok  mergeBlocks -> re-merging an unchanged row is byte-identical')

// --- buildMergedPatch is idempotent, and reports the digest of what it produced
const first = buildMergedPatch(PHONE_PATCH, rows)
const second = buildMergedPatch(first.text, rows)
assert.equal(first.added, 0)
assert.equal(first.replaced, 1)
assert.equal(second.digest, first.digest, 'merging twice yields the same document')
assert.equal(second.added, 0)
assert.equal(second.replaced, 1)
assert.match(first.digest, /^[0-9a-f]{64}$/u)
assert.equal(first.digest, digestText(first.text))
const crlf = buildMergedPatch(PHONE_PATCH.replace(/\n/gu, '\r\n'), rows)
assert.equal(crlf.digest, first.digest, 'CRLF and LF are the same document')
const fresh = buildMergedPatch('', rows)
assert.equal(fresh.added, 1)
assert.equal(fresh.replaced, 0)
assert.equal(fresh.text, row.text, 'an empty phone patch is just the incoming block')
console.log(`ok  buildMergedPatch -> idempotent (digest ${first.digest.slice(0, 12)}…)`)

// --- an id-less entry is matched by name instead
const byName = mergeBlocks(
  '- name: "@scope/thing"\n  config:\n    value: 1\n',
  ['- name: "@scope/thing"\n  config:\n    value: 2\n'],
)
assert.equal(byName.replaced, 1)
assert.equal(byName.added, 0)
assert.ok(byName.text.includes('value: 2'))
console.log('ok  mergeBlocks -> id-less entry matched by name')

// --- buildMergedCredentials: append under refs:, never touch records:
const PHONE_CREDENTIALS = `version: 1
refs:
  OLD_REF: old-value
records:
  client-connection/browser-session:
    kind: grant
    payload:
      secret: phone-side-secret
`
const creds = buildMergedCredentials(PHONE_CREDENTIALS, row.keys, credentialsFile)
assert.equal(creds.added, 1)
assert.equal(creds.replaced, 0)
assert.ok(creds.text.includes('  DEEPSEEK_API_KEY: sk-test-deepseek'), 'the referenced ref is copied')
assert.ok(creds.text.indexOf('DEEPSEEK_API_KEY') < creds.text.indexOf('records:'), 'appended inside refs:')
assert.equal(
  creds.text.slice(creds.text.indexOf('records:')),
  PHONE_CREDENTIALS.slice(PHONE_CREDENTIALS.indexOf('records:')),
  'records: is untouched byte-for-byte',
)
assert.ok(!creds.text.includes('UNUSED_REF') && !creds.text.includes('PACKED_KEY'), 'unreferenced refs stay home')
assert.equal(creds.digest, digestText(creds.text))
const credsAgain = buildMergedCredentials(creds.text, row.keys, credentialsFile)
assert.equal(credsAgain.digest, creds.digest, 'credentials merge is idempotent')
assert.equal(credsAgain.added, 0)
assert.equal(credsAgain.replaced, 1)
console.log(`ok  buildMergedCredentials -> added ${creds.added}, records: intact`)

// --- an existing (stale) ref line is replaced in place
const stale = PHONE_CREDENTIALS.replace('OLD_REF: old-value', 'DEEPSEEK_API_KEY: sk-stale')
const refreshed = buildMergedCredentials(stale, ['DEEPSEEK_API_KEY'], credentialsFile)
assert.equal(refreshed.added, 0)
assert.equal(refreshed.replaced, 1)
assert.ok(refreshed.text.includes('  DEEPSEEK_API_KEY: sk-test-deepseek'))
assert.ok(!refreshed.text.includes('sk-stale'))

// --- the raw (quoted) value is what gets written back
const packed = buildMergedCredentials(PHONE_CREDENTIALS, ['PACKED_KEY'], credentialsFile)
assert.ok(packed.text.includes(`  PACKED_KEY: '{"access_key_id":"AK","secret_access_key":"SK"}'`))

// --- a ref the credentials file does not hold is skipped, not invented
const impossible = buildMergedCredentials(PHONE_CREDENTIALS, ['NOT_IN_CREDENTIALS'], credentialsFile)
assert.equal(impossible.added, 0)
assert.equal(impossible.text, PHONE_CREDENTIALS)
console.log('ok  buildMergedCredentials -> stale ref replaced, quoted value kept, missing ref skipped')

// --- refs: is created at the end when the phone has no section yet
const NO_REFS = 'version: 1\nrecords:\n  x:\n    kind: grant\n'
const created = buildMergedCredentials(NO_REFS, ['DEEPSEEK_API_KEY'], credentialsFile)
assert.equal(created.added, 1)
assert.ok(created.text.startsWith('version: 1\nrecords:\n  x:\n    kind: grant\n\nrefs:\n'))
assert.ok(created.text.includes('  DEEPSEEK_API_KEY: sk-test-deepseek'))
assert.equal(buildMergedCredentials(created.text, ['DEEPSEEK_API_KEY'], credentialsFile).digest, created.digest)
console.log('ok  buildMergedCredentials -> creates refs: at EOF without reordering records:')

// --- nested providers: each `config.providers.<name>` is a group of its own,
// merged *inside* the phone's row with that id (never as a second row: a patch
// entry replaces the whole config, so a duplicate id would wipe the phone's own
// providers).
const NESTED = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      alpha:
        displayName: Alpha
        baseURL: https://alpha.example/v1
        apiKeyEnv: ALPHA_KEY
        models:
          - id: alpha-1
          - id: alpha-2
      beta:
        displayName: Beta
        apiKeyEnv: BETA_KEY
        models:
          - id: beta-1
`
const nestedFile = fixture('nested.yml', NESTED)
const groups = listModels({ patchFile: nestedFile, credentialsFile })
assert.deepEqual(groups.map(group => group.key), ['llm-pi-ai/alpha', 'llm-pi-ai/beta'])
assert.deepEqual(groups[0].models, ['alpha-1', 'alpha-2'])
assert.equal(groups[0].baseURL, 'https://alpha.example/v1')
assert.equal(groups[1].baseURL, null, 'a provider without its own endpoint is still a group')
assert.deepEqual(groups[1].keys, ['BETA_KEY'])
assert.equal(groups[0].kind, 'provider')

// The phone already has its own provider in that row: only beta is merged in,
// the phone's own entry survives, and there is still exactly one llm-pi-ai row.
const PHONE_ROW = `# phone header
- id: llm-pi-ai
  config:
    providers:
      phone-own:
        baseURL: http://phone.local/v1
`
const nestedMerge = buildMergedPatch(PHONE_ROW, [groups[1]])
assert.equal(nestedMerge.added, 1)
assert.equal(nestedMerge.replaced, 0)
assert.match(nestedMerge.text, /phone-own/)
assert.match(nestedMerge.text, /beta:/)
assert.doesNotMatch(nestedMerge.text, /alpha:/)
assert.match(nestedMerge.text, /^# phone header/m, "the phone's header is untouched")
assert.equal((nestedMerge.text.match(/- id: llm-pi-ai/gu) ?? []).length, 1, 'exactly one row with that id')
assert.equal(buildMergedPatch(nestedMerge.text, [groups[1]]).text, nestedMerge.text, 'nested merge is idempotent')

// A phone with no such row gets one created, provider included.
const freshNested = buildMergedPatch('# phone\n- id: ui-chat\n  config:\n    x: 1\n', [groups[0]])
assert.match(freshNested.text, /- id: llm-pi-ai/)
assert.match(freshNested.text, /name: "@deepseek-ai\/dsh-llm-pi-ai"/)
assert.match(freshNested.text, /alpha:/)
assert.match(freshNested.text, /- id: alpha-1/)
assert.equal(buildMergedPatch(freshNested.text, [groups[0]]).text, freshNested.text, 'fresh row merge is idempotent')

// A plugin's own patch layer contributes groups too, tagged with the plugin, so
// the panel can show plugin-provided models instead of hiding them.
const pluginDir = path.join(work, 'plugin-with-providers')
fs.mkdirSync(pluginDir, { recursive: true })
fs.writeFileSync(
  path.join(pluginDir, 'cordis.patch.yml'),
  `- id: llm-pi-ai
  config:
    providers:
      gamma:
        displayName: Gamma
        models:
          - id: gamma-1
`,
)
const withPlugin = listModels({
  patchFile: nestedFile,
  credentialsFile,
  plugins: [
    { name: 'dsh-with-provider', patchFile: path.join(pluginDir, 'cordis.patch.yml') },
    { name: 'dsh-no-patch', patchFile: path.join(work, 'missing.yml') },
  ],
})
assert.deepEqual(
  withPlugin.map(group => group.key),
  ['llm-pi-ai/alpha', 'llm-pi-ai/beta', 'llm-pi-ai/gamma'],
)
assert.equal(withPlugin[2].source, 'plugin')
assert.equal(withPlugin[2].plugin, 'dsh-with-provider')
assert.equal(withPlugin[0].source, 'profile')
console.log(`ok  nested providers -> ${groups.length} groups, merged inside the phone's row, plugin groups tagged`)

// --- empty results instead of exceptions on missing or garbage input
assert.equal(credentialRefs(path.join(work, 'does-not-exist.yaml')).size, 0)
assert.equal(credentialRefs(fixture('garbage.yaml', '\u0000\u0001 not: [valid: yaml\n{{{')).size, 0)
assert.deepEqual(listModels({ patchFile: path.join(work, 'does-not-exist.yml') }), [])
assert.deepEqual(listModels({ patchFile: fixture('garbage.yml', '\u0000\u0001 {{{') }), [])
assert.deepEqual(listModels({}), [])
assert.deepEqual(listModels({ patchFile: fixture('scalar.yml', 'version: 1\nrecords: {}\n') }), [])
const empty = splitBlocks('')
assert.equal(empty.header, '')
assert.deepEqual(empty.blocks, [])
const scalarDoc = splitBlocks('version: 1\nrecords: {}\n')
assert.equal(scalarDoc.header, 'version: 1\nrecords: {}\n', 'a file that is not an array is all header')
assert.deepEqual(scalarDoc.blocks, [])
assert.deepEqual(mergeBlocks('', []), { text: '', added: 0, replaced: 0 })
assert.deepEqual(
  mergeBlocks(PHONE_PATCH, [null, 42, '   ']).text,
  PHONE_PATCH,
  'junk rows merge into nothing',
)
const bare = mergeBlocks(PHONE_PATCH, ['id: added-by-hand\n  name: "@scope/thing"\n'])
assert.equal(bare.added, 1)
assert.ok(bare.text.includes('- id: added-by-hand'), 'a block without its dash is still an entry')
const nothing = buildMergedPatch(undefined, undefined)
assert.equal(nothing.text, '')
assert.equal(nothing.digest, digestText(''))
const noCreds = buildMergedCredentials(undefined, undefined, undefined)
assert.equal(noCreds.text, '')
assert.equal(noCreds.digest, digestText(''))
console.log('ok  every function returns empty results on missing/garbage files')

console.log(`\nwork dir: ${work}`)
console.log('ALL MODEL CHECKS PASSED')
