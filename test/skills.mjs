/**
 * Exercise of the skills module against a throwaway home: both discovery roots,
 * de-duplication between them, digest stability, and the read cap.
 *
 * The fixtures deliberately include the shapes that actually trip a naive
 * implementation — a `__pycache__` beside a SKILL.md, a bundle with no
 * SKILL.md, a SKILL.md with no frontmatter, and the same skill name in both
 * roots.
 *
 * Usage: node test/skills.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SKIP_DIRS, digestOf, frontmatter, listSkills, readSkill, skillFiles } from '../lib/skills.js'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skills-test-'))
const home = path.join(work, 'home')
const agentsHome = path.join(work, 'agents')
const extra = path.join(work, 'extra')

/** Write a UTF-8 file, creating its parents. */
function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

/** Write a directory bundle: `---` frontmatter, then a small body. */
function bundle(root, name, meta, body = `# ${name}\n`) {
  const dir = path.join(root, name)
  put(path.join(dir, 'SKILL.md'), `---\n${meta}\n---\n\n${body}`)
  return dir
}

/** The frontmatter of the `alpha` bundle, reused by the digest twins. */
const ALPHA_META = [
  'name: alpha',
  'description: "参照文件很多的技能"',
  'whenToUse: working on alpha',
].join('\n')
const ALPHA_NOTES = '# notes\n'

// --- root one: the DSH home, whose skills win every name collision
const dshSkills = path.join(home, 'skills')
bundle(dshSkills, 'alpha', ALPHA_META)
put(path.join(dshSkills, 'alpha', 'reference', 'notes.md'), ALPHA_NOTES)
// Residue that must never reach the phone, and must never change a digest.
put(path.join(dshSkills, 'alpha', '__pycache__', 'junk.pyc'), 'compiled')
put(path.join(dshSkills, 'alpha', 'stray.pyc'), 'compiled')
put(path.join(dshSkills, 'alpha', '.DS_Store'), 'junk')
put(path.join(dshSkills, 'alpha', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

// a flat skill: `<root>/<name>.md`
put(path.join(dshSkills, 'flat-one.md'), '---\nname: flat-one\ndescription: a flat skill\n---\n\n# flat\n')

// a broken bundle: no SKILL.md at all
put(path.join(dshSkills, 'broken', 'README.md'), 'this bundle never became a skill\n')
// a bundle whose SKILL.md carries no frontmatter, so it has no name
put(path.join(dshSkills, 'plain', 'SKILL.md'), '# just a heading\n')
// an explicitly hidden (model-invocation-disabled) skill
bundle(dshSkills, 'quiet', 'name: quiet\ndescription: hidden one\ndisable-model-invocation: true')
// a skill that is manual only, spelled with YAML synonyms
bundle(dshSkills, 'manual', 'name: manual\ndescription: manual one\ndisable-model-invocation: yes\nuser-invocable: no')
// the name that both roots also carry
bundle(dshSkills, 'dup', 'name: dup\ndescription: from dsh')

// --- root two: the shared agents home
const agentsSkills = path.join(agentsHome, 'skills')
bundle(agentsSkills, 'dup', 'name: dup\ndescription: from agents')
bundle(agentsSkills, 'agents-only', 'name: agents-only\ndescription: only in the agents home')

// --- root three: an extra directory the caller asked for
bundle(extra, 'extra-one', 'name: extra-one\ndescription: only in the extra root')
bundle(extra, 'dup', 'name: dup\ndescription: from extra')

const found = listSkills({ home, agentsHome, extraDirs: [extra] })
const byName = new Map(found.map((skill) => [skill.name, skill]))

// --- discovery and ordering
assert.deepEqual(
  found.map((skill) => skill.name),
  ['agents-only', 'alpha', 'dup', 'extra-one', 'flat-one', 'manual', 'quiet'],
  'every real skill, sorted by name',
)
console.log(`ok  discovered ${found.length} skills: ${found.map((skill) => skill.name).join(', ')}`)

// --- a directory bundle
const alpha = byName.get('alpha')
assert.equal(alpha.kind, 'dir')
assert.equal(alpha.source, 'dsh')
assert.equal(alpha.dir, path.join(dshSkills, 'alpha'))
assert.equal(alpha.file, path.join(dshSkills, 'alpha', 'SKILL.md'))
assert.equal(alpha.description, '参照文件很多的技能', 'surrounding quotes are stripped')
assert.equal(alpha.whenToUse, 'working on alpha')
assert.equal(alpha.hidden, false)
assert.equal(alpha.userInvocable, true)
console.log('ok  a bundle reports name, description, whenToUse and its absolute paths')

// --- skillFiles: the whole bundle, with the bundle name prefixed, minus residue
const alphaFiles = skillFiles(alpha)
assert.deepEqual(
  alphaFiles.map((file) => file.relative),
  ['alpha/SKILL.md', 'alpha/reference/notes.md'],
)
for (const file of alphaFiles) {
  assert.equal(file.absolute, path.join(dshSkills, file.relative))
  assert.ok(fs.existsSync(file.absolute))
}
assert.equal(alpha.files, alphaFiles.length)
assert.equal(
  alpha.bytes,
  alphaFiles.reduce((sum, file) => sum + fs.statSync(file.absolute).size, 0),
  'bytes is the total over skillFiles',
)
console.log(`ok  __pycache__, *.pyc, .DS_Store and node_modules are skipped (${alpha.files} files, ${alpha.bytes} bytes)`)

// --- a flat skill
const flat = byName.get('flat-one')
assert.equal(flat.kind, 'file')
assert.equal(flat.dir, null)
assert.equal(flat.file, path.join(dshSkills, 'flat-one.md'))
assert.deepEqual(skillFiles(flat), [{ relative: 'flat-one.md', absolute: path.join(dshSkills, 'flat-one.md') }])
assert.equal(flat.files, 1)
console.log('ok  a flat <name>.md is a skill of kind file with one relative entry')

// --- rejected entries
assert.equal(byName.has('broken'), false, 'a bundle without SKILL.md is not a skill')
assert.equal(byName.has('plain'), false, 'a SKILL.md without frontmatter has no name')
console.log('ok  a bundle without SKILL.md and a nameless SKILL.md are both ignored')

// --- de-duplication: dsh beats agents beats extra
assert.equal(byName.get('dup').source, 'dsh')
assert.equal(byName.get('dup').description, 'from dsh')
assert.equal(found.filter((skill) => skill.name === 'dup').length, 1, 'one entry per name')
assert.equal(byName.get('agents-only').source, 'agents')
assert.equal(byName.get('extra-one').source, 'extra')
console.log('ok  duplicate names collapse to one entry, and the dsh root wins')

// --- frontmatter flags
assert.equal(byName.get('quiet').hidden, true)
assert.equal(byName.get('quiet').userInvocable, true, 'user-invocable defaults to true')
assert.equal(byName.get('manual').hidden, true, '`yes` is a YAML boolean')
assert.equal(byName.get('manual').userInvocable, false, '`no` disables user invocation')
console.log('ok  disable-model-invocation and user-invocable land on hidden/userInvocable')

// --- the frontmatter parser on its own
const parsed = frontmatter('---\nname: x\ndescription: "quoted: yes"\n---\n\n# body\n')
assert.equal(parsed.name, 'x')
assert.equal(parsed.description, 'quoted: yes')
assert.equal(parsed.hidden, false)
assert.equal(parsed.userInvocable, true)
assert.ok(parsed.raw.includes('name: x'), 'raw keeps the block body')
assert.equal(frontmatter('# no frontmatter at all'), null)
assert.equal(frontmatter('---\nname: x\n'), null, 'an unterminated block is not frontmatter')
assert.equal(frontmatter('---\ndescription: d\n---\n').name, undefined)
assert.equal(frontmatter("---\nname: 'single'\n---\n").name, 'single', 'single quotes are stripped')
assert.equal(frontmatter('---\r\nname: crlf\r\n---\r\n').name, 'crlf', 'CRLF line endings work')
assert.equal(frontmatter('---\ndisable-model-invocation: OFF\n---\n').hidden, false)
assert.equal(frontmatter('---\ndisable-model-invocation: On\n---\n').hidden, true)
assert.equal(frontmatter('---\nuser-invocable: 0\n---\n').userInvocable, false)
assert.equal(frontmatter('---\nuser-invocable: perhaps\n---\n').userInvocable, false, 'an unknown spelling coerces to false')
assert.equal(frontmatter('---\n  name: indented\nname: top\n---\n').name, 'top', 'an indented line is not a key')
console.log('ok  frontmatter() parses quotes, booleans and CRLF, and rejects a missing block')

// --- digest stability
assert.match(alpha.digest, /^[0-9a-f]{64}$/u)
assert.equal(digestOf(alphaFiles), alpha.digest, 'digestOf agrees with the listing')

// the same content under another home must hash identically
const twinHome = path.join(work, 'twin')
const twinSkills = path.join(twinHome, 'skills')
bundle(twinSkills, 'alpha', ALPHA_META)
put(path.join(twinSkills, 'alpha', 'reference', 'notes.md'), ALPHA_NOTES)
const twin = listSkills({ home: twinHome, agentsHome: null }).find((skill) => skill.name === 'alpha')
assert.equal(twin.digest, alpha.digest, 'same content at the same relative paths -> same digest')
console.log('ok  identical content in another home yields an identical digest')

// one changed byte must move the digest
put(path.join(twinSkills, 'alpha', 'reference', 'notes.md'), `${ALPHA_NOTES}!`)
const changed = listSkills({ home: twinHome, agentsHome: null }).find((skill) => skill.name === 'alpha')
assert.notEqual(changed.digest, alpha.digest, 'a changed byte changes the digest')
console.log('ok  one changed byte changes the digest')

// timestamps and modes are not content
fs.utimesSync(alpha.file, new Date(2001, 1, 1), new Date(2001, 1, 1))
const retouched = listSkills({ home, agentsHome, extraDirs: [extra] }).find((skill) => skill.name === 'alpha')
assert.equal(retouched.digest, alpha.digest, 'mtime is not part of the digest')
console.log('ok  touching a file leaves the digest alone')

// --- readSkill
const whole = readSkill(alpha)
assert.equal(whole.truncated, false)
assert.equal(whole.bytes, alpha.bytes)
assert.deepEqual(whole.files.map((file) => file.relative), ['alpha/SKILL.md', 'alpha/reference/notes.md'])
assert.ok(Buffer.isBuffer(whole.files[0].data))
assert.equal(whole.files[0].data.toString('utf8'), fs.readFileSync(alpha.file, 'utf8'))
console.log(`ok  readSkill() returns every file (${whole.bytes} bytes)`)

const skillMdBytes = fs.statSync(alpha.file).size
const exact = readSkill(alpha, { maxBytes: skillMdBytes })
assert.equal(exact.files.length, 1, 'the first file fits the cap exactly')
assert.equal(exact.bytes, skillMdBytes)
assert.equal(exact.truncated, true, 'the second file did not fit')
const tiny = readSkill(alpha, { maxBytes: 8 })
assert.equal(tiny.files.length, 0)
assert.equal(tiny.bytes, 0)
assert.equal(tiny.truncated, true)
console.log('ok  readSkill() truncates on a file boundary and reports it')

// --- missing roots never throw
assert.deepEqual(listSkills({ home: path.join(work, 'absent'), agentsHome: null }), [])
assert.deepEqual(
  listSkills({ home, agentsHome: path.join(work, 'absent-agents') }).filter((skill) => skill.source === 'agents'),
  [],
)
assert.deepEqual(listSkills({ home: path.join(work, 'absent'), agentsHome: null, extraDirs: [path.join(work, 'nope')] }), [])
assert.equal(typeof listSkills({ home, agentsHome, extraDirs: [extra] }), 'object')
console.log('ok  a missing root yields [] instead of throwing')

// --- SKIP_DIRS is part of the contract
assert.ok(SKIP_DIRS instanceof Set)
for (const name of ['.git', 'node_modules', '.DS_Store', '__pycache__']) {
  assert.ok(SKIP_DIRS.has(name), `${name} must be skipped`)
}
console.log('ok  SKIP_DIRS carries the four names the caller may rely on')

// --- a skill reached through a symlink is still one skill
// DSH's own root routinely links into the agents home, so this is the real-world
// duplicate. Junctions need no privilege on Windows; plain symlinks work elsewhere.
let linked = false
try {
  fs.symlinkSync(path.join(agentsSkills, 'agents-only'), path.join(dshSkills, 'agents-only'), 'junction')
  linked = true
} catch (_error) {
  try {
    fs.symlinkSync(path.join(agentsSkills, 'agents-only'), path.join(dshSkills, 'agents-only'), 'dir')
    linked = true
  } catch (_error2) {
    // A platform that refuses links cannot exercise this branch.
  }
}
if (linked) {
  const linkedCopies = listSkills({ home, agentsHome, extraDirs: [extra] }).filter((skill) => skill.name === 'agents-only')
  assert.equal(linkedCopies.length, 1, 'a symlinked duplicate must not appear twice')
  assert.equal(linkedCopies[0].source, 'dsh', 'the DSH root still wins')
  console.log('ok  a skill symlinked into both roots is listed once')
} else {
  console.log('ok  symlink dedup not exercised: this platform refused to create a link')
}

console.log(`\nwork dir: ${work}`)
console.log('\nALL SKILL CHECKS PASSED')
