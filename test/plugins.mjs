/**
 * Exercise lib/plugins.js against a throwaway profile built in the temp dir.
 *
 * The package layout mirrors what a real DSH profile looks like: one plugin is
 * linked into a source directory (the shape a `link:` dependency takes, like
 * `dsh-mobile-sync` itself), the rest are plain directories. Between them they
 * cover the three reasons a plugin cannot be sent, the host-library exclusion,
 * the candidate union, the caller's `skip` list, and the byte cap in
 * `readPlugin`.
 *
 * Usage: node test/plugins.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listPlugins, NATIVE_EXT, pluginFiles, readPlugin, SKIP_DIRS } from '../lib/plugins.js'

/** The realpath the module itself uses (native resolves junctions on Windows). */
const realPath = fs.realpathSync.native ?? fs.realpathSync

/** Write a fake package: its manifest first, then every listed relative file. */
function writePackage(dir, manifest, files) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [relative, content] of Object.entries(files ?? {})) {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

/** One listed plugin by name, failing loudly when the listing dropped it. */
function byName(plugins, name) {
  const found = plugins.find((plugin) => plugin.name === name)
  assert.ok(found !== undefined, `${name} should be listed`)
  return found
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugins-test-'))
const profileDir = path.join(work, 'profile')
const modules = path.join(profileDir, 'node_modules')
const bundleSrc = path.join(work, 'source', 'demo-bundle')

// --- a clean bundle, living in a source checkout and installed behind a junction
writePackage(bundleSrc, {
  name: 'demo-bundle',
  version: '1.2.3',
  description: 'A clean bundle',
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: { platform: 'web' },
  },
}, {
  'index.js': "export const hello = 'bundle'\n",
  'lib/helper.js': 'export function double(value) {\n  return value * 2\n}\n',
  'cordis.patch.yml': '- insert:\n    - id: demo-bundle\n      name: demo-bundle/index\n',
  'README.md': '# demo-bundle\n\nA clean bundle used by test/plugins.mjs.\n',
  'nested/deep/asset.txt': 'asset\n',
  // Everything below must be filtered out of the shipped file list.
  'node_modules/ignored/index.js': 'ignored\n',
  '.git/config': '[core]\n',
  '.cache/blob.bin': Buffer.from([0, 1, 2, 3]),
  '.pnpm/store.json': '{}\n',
  '.dsh-market/entry.json': '{}\n',
  '.plugin-manager/state.json': '{}\n',
  '.DS_Store': 'junk\n',
  'debug.log': 'noise\n',
})

// The plugin itself lives in a source checkout and is installed behind a
// junction, exactly like `dsh-mobile-sync` in a real profile. Creating a
// directory symlink needs a privilege this test cannot assume, so a junction is
// used; `dir` must still come back as the source path.
fs.mkdirSync(modules, { recursive: true })
fs.symlinkSync(bundleSrc, path.join(modules, 'demo-bundle'), 'junction')

// --- a package that ships a native artifact *and* has dependencies (native wins)
writePackage(path.join(modules, 'demo-native'), {
  name: 'demo-native',
  version: '0.1.0',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  dependencies: { 'left-pad': '1.0.0' },
}, {
  'index.js': "module.exports = require('./lib/addon.node')\n",
  'lib/addon.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]),
})

// --- a package whose only native marker is the build file
writePackage(path.join(modules, 'demo-gyp'), {
  name: 'demo-gyp',
  version: '0.2.0',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, {
  'index.js': "module.exports = 'unbuilt'\n",
  'binding.gyp': "{ 'targets': [] }\n",
})

// --- runtime dependencies cannot be resolved on the phone
writePackage(path.join(modules, 'demo-dep'), {
  name: 'demo-dep',
  version: '2.0.0',
  dsh: { client: { platform: 'web' } },
  dependencies: { alpha: '^1.0.0', beta: '2.0.0' },
}, {
  'index.js': "export default 'dep'\n",
})

// --- `dsh` present but nothing the Loader could mount
writePackage(path.join(modules, 'demo-inert'), {
  name: 'demo-inert',
  version: '0.0.1',
  dsh: {},
}, {
  'index.js': "export default 'inert'\n",
})

// --- a host library: no `dsh` field, so it is not a plugin at all
writePackage(path.join(modules, 'demo-host'), {
  name: 'demo-host',
  version: '3.0.0',
}, {
  'index.js': "export default 'host'\n",
})

// --- the skip case: a plain directory, no junction involved, deliberately
// lacking `name`/`version` so the directory-name and null fallbacks are covered
writePackage(path.join(modules, 'demo-skip'), {
  description: 'No name field',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, {
  'index.js': "export default 'skip'\n",
})

// --- the profile: dependencies and bundles overlap only partly, and both name
// things that are not installed
writePackage(profileDir, {
  name: 'dsh-profile-test',
  private: true,
  dependencies: {
    'demo-bundle': 'link:../source/demo-bundle',
    'demo-native': '1.0.0',
    'demo-dep': '2.0.0',
    'demo-inert': '0.0.1',
    'demo-host': '3.0.0',
    'demo-skip': '1.0.0',
    'demo-missing': '9.9.9',
  },
  dsh: {
    profile: {
      bundles: ['demo-bundle', 'demo-gyp', '@deepseek-ai/dsh-ghost', 'demo-host'],
    },
  },
}, {})

// --- the listing
const all = listPlugins({ profileDir })
assert.deepEqual(
  all.map((plugin) => plugin.name),
  ['demo-bundle', 'demo-dep', 'demo-gyp', 'demo-inert', 'demo-native', 'demo-skip'],
  'candidates are the union of dependencies and bundles, sorted by name',
)
console.log(`ok  listed ${all.length} plugins: ${all.map((plugin) => plugin.name).join(', ')}`)

assert.deepEqual(
  Object.keys(byName(all, 'demo-bundle')).sort(),
  ['bundle', 'bytes', 'dependencies', 'description', 'dir', 'files', 'installable', 'name', 'patchFile', 'reason', 'version'],
  'a record carries exactly the documented fields',
)
for (const plugin of all) {
  assert.equal(path.isAbsolute(plugin.dir), true, `${plugin.name}.dir should be absolute`)
  assert.equal(fs.statSync(plugin.dir).isDirectory(), true, `${plugin.name}.dir should exist`)
}
console.log('ok  every record is absolute, on disk, and shaped as documented')

assert.equal(all.some((plugin) => plugin.name === 'demo-host'), false, 'a package without `dsh` is not a plugin')
assert.equal(all.some((plugin) => plugin.name === 'demo-missing'), false, 'a dependency that is not on disk is dropped')
assert.equal(all.some((plugin) => plugin.name === '@deepseek-ai/dsh-ghost'), false, 'a bundle entry that is not on disk is dropped')
console.log('ok  host library, missing dependency and missing bundle entry are dropped')

const skipped = listPlugins({ profileDir, skip: ['demo-skip'] })
assert.deepEqual(
  skipped.map((plugin) => plugin.name),
  ['demo-bundle', 'demo-dep', 'demo-gyp', 'demo-inert', 'demo-native'],
  'skip removes exactly the named package',
)
assert.equal(skipped.length, all.length - 1)
console.log('ok  skip removes only the named package')

const bundle = byName(all, 'demo-bundle')
assert.equal(bundle.version, '1.2.3')
assert.equal(bundle.description, 'A clean bundle')
assert.equal(bundle.installable, true)
assert.equal(bundle.reason, null)
assert.equal(bundle.bundle, true)
assert.deepEqual(bundle.dependencies, [])
assert.equal(bundle.dir, realPath(bundleSrc), 'dir is the real path behind the junction')
assert.notEqual(bundle.dir, path.join(modules, 'demo-bundle'))
console.log(`ok  clean bundle -> installable, dir=${bundle.dir}`)

const native = byName(all, 'demo-native')
assert.equal(native.installable, false)
assert.equal(native.reason, '含原生二进制，手机无法加载')
assert.equal(native.bundle, true)
assert.deepEqual(native.dependencies, ['left-pad'], 'a native package may still declare dependencies')
console.log(`ok  .node artifact -> ${native.reason}`)

const gyp = byName(all, 'demo-gyp')
assert.equal(gyp.installable, false)
assert.equal(gyp.reason, '含原生二进制，手机无法加载')
assert.equal(gyp.bundle, true)
console.log(`ok  binding.gyp alone -> ${gyp.reason}`)

const dep = byName(all, 'demo-dep')
assert.equal(dep.installable, false)
assert.equal(dep.reason, '依赖 2 个运行时包（alpha、beta），暂不支持整体搬移')
assert.equal(dep.bundle, false, 'this package is client-only')
console.log(`ok  runtime dependencies -> ${dep.reason}`)

const inert = byName(all, 'demo-inert')
assert.equal(inert.installable, false)
assert.equal(inert.reason, '不是可加载的 DSH 插件')
assert.equal(inert.bundle, false)
assert.deepEqual(inert.dependencies, [])
console.log(`ok  bare dsh field -> ${inert.reason}`)

const skippedRecord = byName(all, 'demo-skip')
assert.equal(skippedRecord.name, 'demo-skip', 'name falls back to the directory name')
assert.equal(skippedRecord.version, null)
assert.equal(skippedRecord.description, 'No name field')
assert.equal(skippedRecord.installable, true)
assert.equal(skippedRecord.bundle, true)
console.log('ok  missing manifest name/version fall back to directory name and null')

// --- pluginFiles
const expectedFiles = [
  'README.md',
  'cordis.patch.yml',
  'index.js',
  'lib/helper.js',
  'nested/deep/asset.txt',
  'package.json',
]
const expectedBytes = expectedFiles.reduce(
  (total, relative) => total + fs.statSync(path.join(bundle.dir, relative)).size,
  0,
)
assert.deepEqual(pluginFiles(bundle.dir), expectedFiles, 'files are sorted, slash-separated, and filtered')
for (const relative of expectedFiles) {
  assert.equal(fs.statSync(path.join(bundle.dir, relative)).isFile(), true)
}
assert.equal(pluginFiles(bundle.dir).includes('.DS_Store'), false)
assert.equal(pluginFiles(bundle.dir).includes('debug.log'), false)
console.log(`ok  pluginFiles -> ${expectedFiles.length} files, scratch files excluded`)

assert.deepEqual(pluginFiles(path.join(work, 'not-installed')), [], 'a missing directory lists nothing')
assert.deepEqual(pluginFiles(''), [], 'an empty path lists nothing')
console.log('ok  pluginFiles never throws on a missing directory')

// --- readPlugin
const read = readPlugin(bundle.dir)
assert.deepEqual(read.files.map((entry) => entry.relative), expectedFiles)
assert.equal(read.bytes, expectedBytes)
assert.equal(read.truncated, false)
for (const entry of read.files) {
  assert.equal(Buffer.isBuffer(entry.data), true, `${entry.relative} should carry a Buffer`)
  assert.deepEqual(entry.data, fs.readFileSync(path.join(bundle.dir, entry.relative)))
}
console.log(`ok  readPlugin shipped ${read.files.length} files, ${read.bytes} bytes, not truncated`)

const firstSize = fs.statSync(path.join(bundle.dir, expectedFiles[0])).size
const capped = readPlugin(bundle.dir, { maxBytes: firstSize })
assert.equal(capped.truncated, true, 'a cap below the total must truncate')
assert.deepEqual(capped.files.map((entry) => entry.relative), [expectedFiles[0]])
assert.equal(capped.bytes, firstSize)
console.log(`ok  maxBytes=${firstSize} keeps exactly the first file and reports truncation`)

const exact = readPlugin(bundle.dir, { maxBytes: expectedBytes })
assert.equal(exact.truncated, false, 'a cap equal to the total is not truncation')
assert.equal(exact.files.length, expectedFiles.length)

const lastSize = fs.statSync(path.join(bundle.dir, expectedFiles[expectedFiles.length - 1])).size
const tight = readPlugin(bundle.dir, { maxBytes: expectedBytes - 1 })
assert.equal(tight.truncated, true)
assert.equal(tight.files.length, expectedFiles.length - 1, 'the file that does not fit is left out')
assert.equal(tight.bytes, expectedBytes - lastSize)

const zero = readPlugin(bundle.dir, { maxBytes: 0 })
assert.equal(zero.truncated, true)
assert.deepEqual(zero.files, [])
assert.equal(zero.bytes, 0)
console.log('ok  byte cap boundary, one-byte-short cap and zero cap all behave')

assert.deepEqual(readPlugin(path.join(work, 'not-installed')), { files: [], bytes: 0, truncated: false })
assert.equal(readPlugin(bundle.dir, {}).truncated, false, 'the default cap is 64 MiB')
console.log('ok  readPlugin tolerates a missing directory and the default cap')

// --- profiles that do not exist or cannot be read
assert.deepEqual(listPlugins({ profileDir: path.join(work, 'no-such-profile') }), [])
assert.deepEqual(listPlugins(), [], 'no options at all is just an empty listing')
assert.deepEqual(listPlugins({ profileDir: '' }), [])

const broken = path.join(work, 'broken-profile')
fs.mkdirSync(broken, { recursive: true })
fs.writeFileSync(path.join(broken, 'package.json'), '{ not json at all')
assert.deepEqual(listPlugins({ profileDir: broken }), [], 'a damaged profile yields no listing')

const fileProfile = path.join(work, 'file-profile')
fs.writeFileSync(fileProfile, 'not a directory')
assert.deepEqual(listPlugins({ profileDir: fileProfile }), [], 'a file is not a profile')
console.log('ok  missing, empty, damaged and non-directory profiles all return []')

// --- the shared constants
assert.equal(SKIP_DIRS instanceof Set, true)
for (const name of ['node_modules', '.git', '.cache', '.pnpm', '.dsh-market', '.plugin-manager']) {
  assert.equal(SKIP_DIRS.has(name), true, `${name} should be skipped`)
}
assert.equal(SKIP_DIRS.size, 6)
for (const [file, expected] of [
  ['lib/addon.node', true],
  ['x.dll', true],
  ['x.so', true],
  ['x.dylib', true],
  ['X.NODE', true],
  ['index.js', false],
  ['x.node.js', false],
  ['binding.gyp', false],
]) {
  assert.equal(NATIVE_EXT.test(file), expected, `${file} should be native=${expected}`)
}
console.log('ok  SKIP_DIRS and NATIVE_EXT expose the shared rules')

console.log(`\nwork dir: ${work}`)
console.log('\nALL PLUGIN CHECKS PASSED')
