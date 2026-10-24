/**
 * Smoke-test the browser half without a shell: a stub React with just enough
 * hooks to render the panel once, a stub document, and a fake host response.
 *
 * The interesting part now is the switches: the fixture advertises one plugin
 * that is already on the phone, one that cannot be shipped, and two skills, so
 * the test can prove every row renders its own switch, its own state chip, and
 * that ticking a row posts exactly `set-plugin` / `set-skill` with the item
 * name and the flipped value.
 *
 * Usage: node test/client.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

/* --------------------------------------------------------------- stubs */

/** Minimal hook runtime: one render pass, effects run once. */
const hooks = []
let cursor = 0
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState(initial) {
    const slot = cursor++
    if (!(slot in hooks)) hooks[slot] = initial
    return [hooks[slot], value => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value }]
  },
  useEffect(fn) {
    const slot = cursor++
    if (!(slot in hooks)) {
      hooks[slot] = true
      fn()
    }
  },
  useRef(initial) {
    const slot = cursor++
    if (!(slot in hooks)) hooks[slot] = { current: initial }
    return hooks[slot]
  },
  useCallback(fn) {
    return fn
  },
}

const styles = []
const document = {
  baseURI: 'http://127.0.0.1:63705/',
  head: { appendChild: node => styles.push(node) },
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({
    setAttribute() {},
    remove() {},
    style: {},
    textContent: '',
  }),
  querySelector: () => null,
}

const status = {
  running: true,
  port: 8733,
  error: null,
  token: 'a'.repeat(32),
  urls: ['http://192.168.1.9:8733'],
  addresses: [
    { name: 'WLAN', address: '192.168.1.9' },
    { name: 'vEthernet (WSL)', address: '172.26.23.72' },
  ],
  preferred: null,
  pairUrl: 'http://192.168.1.9:8733/j?t=' + 'a'.repeat(32),
  localUrl: 'http://127.0.0.1:8733/j?t=' + 'a'.repeat(32),
  command: "curl -fsSL 'http://192.168.1.9:8733/join.sh?t=" + 'a'.repeat(32) + "' | sh -s both",
  qr: '<svg id="qr"></svg>',
  host: 'DESKTOP',
  sessionsRoot: 'C:\\Users\\x\\.dsh\\sessions',
  total: 12,
  fromPhone: 3,
  log: [{ at: Date.now(), text: '来自 Pixel 9：导入 1，相同 2' }],
  channels: { sessions: true, models: false, plugins: true, skills: true },
  sync: {
    mode: 'auto',
    includeArchived: false,
    secrets: false,
    force: false,
    phoneRoot: '/storage/emulated/0/DSH',
    desktopRoot: 'C:\\Users\\x\\DSH',
    workspaceMap: { 'ws-2': 'phone-2' },
    defaultsRev: 2,
  },
  request: { id: 'deadbeef', at: Date.now() - 4000, status: 'done', doneAt: Date.now() },
  workspaces: {
    desktop: [
      { id: 'ws-1', title: 'demo', path: 'C:\\work\\demo', sessions: 3, archived: 0, mapped: null },
      { id: 'ws-2', title: 'Odds and ends', path: 'C:\\work\\Odds and ends', sessions: 1, archived: 2, mapped: 'phone-2' },
    ],
    phone: [
      { id: 'phone-1', title: 'demo', path: '/storage/emulated/0/DSH/demo', sessions: 2 },
      { id: 'phone-2', title: 'Phone Project', path: '/storage/emulated/0/DSH/Phone Project', sessions: 0 },
    ],
    phoneKnown: true,
    map: { 'ws-2': 'phone-2' },
    mode: 'auto',
    phoneRoot: '/storage/emulated/0/DSH',
    desktopRoot: 'C:\\Users\\x\\DSH',
  },
  paths: {
    profile: 'C:\\Users\\x\\.dsh\\profiles\\desktop',
    patch: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\cordis.patch.yml',
    skills: 'C:\\Users\\x\\.dsh\\skills',
    sessions: 'C:\\Users\\x\\.dsh\\sessions',
    index: 'C:\\Users\\x\\.dsh\\storages\\workspace.json',
  },
  peer: { device: 'Pixel 9', at: Date.now(), home: '/data/.dsh', profile: 'desktop', plugins: 1, skills: 1 },
  counts: { sessions: 12, unindexed: 0, indexed: 12 },
  plugins: [
    {
      name: 'dsh-demo',
      version: '1.2.3',
      bytes: 4096,
      files: 4,
      installable: true,
      reason: null,
      bundle: true,
      selected: true,
      phoneVersion: '1.2.3',
      state: 'same',
    },
    {
      name: 'dsh-native',
      version: '0.9.0',
      bytes: 1024,
      files: 2,
      installable: false,
      reason: '含原生二进制，手机无法加载',
      bundle: true,
      selected: false,
      phoneVersion: null,
      state: 'unsupported',
    },
  ],
  skills: [
    {
      name: 'kimi-computer-use',
      description: '桌面控制',
      source: 'dsh',
      kind: 'dir',
      bytes: 8312,
      files: 1,
      selected: true,
      onPhone: false,
      state: 'send',
    },
    {
      name: 'session-sync',
      description: '会话同步',
      source: 'agents',
      kind: 'dir',
      bytes: 1008500,
      files: 98,
      selected: false,
      onPhone: true,
      state: 'off',
    },
  ],
  models: [
    {
      key: 'llm-pi-ai/grok',
      kind: 'provider',
      label: 'Grok',
      rowId: 'llm-pi-ai',
      provider: 'grok',
      baseURL: 'https://wecodex.lol/v1',
      endpoint: 'baseURL',
      models: ['grok-4.5', 'grok-4.6'],
      keys: ['GROK_API_KEY'],
      hasKey: true,
      disabled: false,
      source: 'profile',
      plugin: null,
      pluginSelected: null,
      selected: true,
    },
    {
      key: 'llm-pi-ai/opencode-free',
      kind: 'provider',
      label: 'OpenCode Free',
      rowId: 'llm-pi-ai',
      provider: 'opencode-free',
      baseURL: 'http://127.0.0.1:19395/v1',
      endpoint: 'baseURL',
      models: ['free-1'],
      keys: [],
      hasKey: true,
      disabled: false,
      source: 'plugin',
      plugin: 'dsh-opencode-free',
      pluginSelected: false,
      selected: false,
    },
  ],
  errors: [],
}

const calls = []
const fetch = async (url, init) => {
  calls.push({ url, init })
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(status),
  }
}

/* --------------------------------------------------------------- load */

let loaded
const window = {
  __ModuleLoader__: {
    load: definition => {
      loaded = definition
    },
  },
}
const context = vm.createContext({
  window,
  document,
  fetch,
  navigator: { clipboard: { writeText: async () => {} } },
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  console,
  URL,
  AbortController,
  JSON,
  Promise,
  String,
  Number,
  Array,
  Object,
  Error,
})
vm.runInContext(source, context, { filename: 'client.js' })

assert.ok(loaded !== undefined, 'client.js must call __ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-mobile-sync')
assert.equal(typeof loaded.factory, 'function')

const module = loaded.factory(name => {
  assert.equal(name, 'react')
  return React
})
assert.equal(module.name, 'mobile-sync')
assert.deepEqual([...module.inject], ['slots', 'locale'])
assert.equal(typeof module.apply, 'function')
console.log('ok  module loads and exports name/inject/apply')

/* --------------------------------------------------------------- apply */

const registered = []
const ctx = {
  effect(fn, label) {
    const off = fn()
    if (typeof off === 'function') registered.push({ label, off })
  },
  locale: {
    register: () => () => {},
    bind: () => key => module.__test.DICT.zh[key] ?? key,
  },
  slots: {
    inject(name, fn) {
      assert.equal(name, 'sidebar.panellist')
      fn()
    },
    register(options, render) {
      registered.push({ name: options.name, id: options.id, key: options.key, order: options.order, render })
      return () => {}
    },
  },
}
module.apply(ctx)
assert.equal(styles.length, 1, 'one <style> is injected')
const panel = registered.find(item => item.name === 'main')
const row = registered.find(item => item.name === 'sidebar.panellist')
assert.ok(panel !== undefined && panel.key === 'dsh-mobile-sync', 'panel registers into the main slot')
assert.ok(row !== undefined && row.id === 'dsh-mobile-sync', 'rail entry registers into sidebar.panellist')
assert.equal(row.order, 5)
console.log('ok  registers the sidebar panel and its rail entry')

/* --------------------------------------------------------------- render */

cursor = 0
const first = texts(panel.render({})).join(' | ')
await new Promise(resolve => setTimeout(resolve, 30))
cursor = 0
const hydrated = panel.render({})

/** Flatten an element tree into a list of strings, invoking components. */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node === 'object' && node.props) {
    if (typeof node.type === 'function') {
      cursor = 0
      return texts(node.type(node.props), out)
    }
    if (typeof node.props.dangerouslySetInnerHTML?.__html === 'string') out.push(node.props.dangerouslySetInnerHTML.__html)
    texts(node.props.children, out)
  }
  return out
}

/** Walk an element tree, collecting every element that satisfies a test. */
function collect(node, test, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, test, out)
    return out
  }
  if (typeof node === 'object' && node.props) {
    if (typeof node.type === 'function') {
      // The stub keeps hook slots in call order, so every fresh render has to
      // start from the first slot the way the real renderer would.
      cursor = 0
      return collect(node.type(node.props), test, out)
    }
    if (test(node)) out.push(node)
    collect(node.props.children, test, out)
  }
  return out
}

assert.match(first, /手机同步/, 'title renders')
assert.match(first, /启动中/, 'first paint shows the loading state')

cursor = 0
const all = texts(hydrated).join(' | ')
assert.match(all, /运行中/, 'running state renders')
assert.match(all, /join\.sh\?t=/, 'the pairing command renders')
assert.match(all, /<svg id="qr">/, 'the QR markup is injected')
assert.match(all, /192\.168\.1\.9/, 'the adapter list renders')
assert.match(all, /172\.26\.23\.72/, 'every adapter address is listed')
assert.match(all, /导入 1，相同 2/, 'the log renders')
assert.match(all, /C:\\Users\\x\\.dsh\\sessions/, 'the session store path renders')

// The switches the user asked for: every channel, every plugin, every skill.
assert.match(all, /同步通道/, 'the channel card renders')
for (const label of ['会话', '模型', '插件', '技能']) {
  assert.match(all, new RegExp(label), `the ${label} channel chip renders`)
}
assert.match(all, /同名工作区互传/, 'the workspace mode renders')
assert.match(all, /插件 · 1\/2 已选/, 'the plugin header counts the ticked items')
assert.match(all, /技能 · 1\/2 已选/, 'the skill header counts the ticked items')
assert.match(all, /本机会话 12 · 已登记 12 · 未登记（不同步） 0/, 'the panel explains how many sessions are actually synced')
const roots = collect(hydrated, node => node.props?.className === 'msy-input')
assert.deepEqual(
  roots.map(node => node.props.defaultValue),
  ['/storage/emulated/0/DSH', 'C:\\Users\\x\\DSH'],
  'both sync roots are editable',
)

assert.match(all, /dsh-demo@1\.2\.3/, 'a plugin is listed with its version')
assert.match(all, /版本相同/, 'a plugin already on the phone is tagged')
assert.match(all, /dsh-native@0\.9\.0/, 'an unsupported plugin is still listed')
assert.match(all, /不支持/, 'an unsupported plugin explains itself')
assert.match(all, /kimi-computer-use/, 'a skill is listed')
assert.match(all, /session-sync/, 'every skill is listed')
assert.match(all, /98 · 985 KB/, 'a skill shows its file count and size')

// The manual sync button: without it a paired phone only waits.
assert.match(all, /手动同步/, 'the manual sync card renders')
assert.match(all, /同步完成/, 'a finished request is reported')
assert.match(all, /再同步一次/, 'the button offers another round after a finished one')
assert.match(all, /手机配对后不会自动同步/, 'the panel says a download does not sync by itself')

// Workspace pairing: both machines' workspaces, and a select per desktop one.
assert.match(all, /工作区配对/, 'the workspace pairing card renders')
assert.match(all, /Phone Project/, 'the phone workspace list renders')
assert.match(all, /恢复同名/, 'the reset button renders when a pairing exists')
const selects = collect(hydrated, node => node.type === 'select')
assert.equal(selects.length, 2, 'one target select per desktop workspace')
assert.deepEqual(
  selects.map(node => node.props.value),
  ['', 'phone-2'],
  'the default is same-name; an explicit pairing shows its phone workspace',
)
// The fixture's request is `done`, so the sync button is enabled (「再同步一次」);
// `busy` is the only thing that disables it.
assert.equal(
  collect(hydrated, node => typeof node.props?.className === 'string' && node.props.className.includes('msy-btn-sync')).length,
  1,
  'exactly one sync button renders',
)

// Model groups: grouped by the patch row, plugin-provided ones tagged.
assert.match(all, /模型组 · 1\/2 已选/, 'the model card counts ticked groups')
assert.match(all, /llm-pi-ai/, 'the model section names its patch row')
assert.match(all, /Grok/, 'a profile provider is listed by its display name')
assert.match(all, /OpenCode Free/, 'a plugin provider is listed too')
assert.match(all, /插件 dsh-opencode-free 未勾选/, 'a plugin group says the plugin itself is not ticked')

const checks = collect(hydrated, node => node.props?.role === 'checkbox')
// Per model group there are two switches: the group itself and its key.
assert.equal(checks.length, 8, 'one switch per plugin, skill and model group, plus one key switch per group')
assert.equal(checks.filter(node => node.props['aria-checked'] === true).length, 5, 'exactly the selected items are ticked')

// The fixture host is `busy` for this render (the stub never settles its first
// action), so disabled proves the wiring, not the unsupported state.
assert.equal(
  checks.filter(node => node.props.disabled === true).length,
  checks.length,
  'every switch is disabled while an action is in flight',
)
console.log(`ok  panel renders ${checks.length} per-item switches`)

/* ------------------------------------------------------------- toggling */

const before = calls.length
// Find the skill row's switch and flip it: it must post set-skill with the name.
const skillSwitch = checks.find(node => node.props['aria-label'] === 'session-sync sync')
assert.ok(skillSwitch !== undefined, 'the skill row carries a named switch')
await skillSwitch.props.onClick()
const posted = calls.slice(before).find(call => String(call.url).endsWith('/action'))
assert.ok(posted !== undefined, 'toggling posts to the action route')
const body = JSON.parse(posted.init.body)
assert.deepEqual(body, { action: 'set-skill', name: 'session-sync', on: true })
console.log('ok  ticking a skill posts set-skill with its name and flipped value')

// A model group posts its key (row/provider), not a display name.
const modelSwitch = checks.find(node => node.props['aria-label'] === 'Grok sync')
assert.ok(modelSwitch !== undefined, 'the model group carries its own switch')
await modelSwitch.props.onClick()
const modelPost = calls.slice(before).find(call => {
  if (!String(call.url).endsWith('/action')) return false
  return JSON.parse(call.init.body).action === 'set-model'
})
assert.ok(modelPost !== undefined, 'toggling a model group posts set-model')
assert.deepEqual(JSON.parse(modelPost.init.body), { action: 'set-model', name: 'llm-pi-ai/grok', on: false })
console.log('ok  ticking a model group posts set-model with its group key')

// Keys ride along with the group unless the user says otherwise.
const keySwitch = checks.find(node => node.props['aria-label'] === 'Grok key')
assert.ok(keySwitch !== undefined, 'a model group carries its own key switch')
assert.equal(keySwitch.props['aria-checked'], true, 'a key travels with its group by default')
assert.match(String(keySwitch.props.title), /GROK_API_KEY/, 'the key switch names the ref it carries')
assert.equal(typeof keySwitch.props.onClick, 'function', 'the key switch is clickable')
// The click itself is covered by `test/entry.mjs` over the real action route
// (`set-key` round trip); the stub host here stays `busy` after its first action
// and the panel refuses to act while busy, by design.
console.log('ok  the model key switch renders with its ref')

// The「开始同步」button arms a request; the pairing select repoints a workspace.
const syncButton = collect(hydrated, node => node.type === 'button' && String(node.props.className ?? '').includes('msy-btn-sync'))[0]
assert.ok(syncButton !== undefined, 'the sync button renders')
await syncButton.props.onClick()
const syncPost = calls.slice(before).find(call => {
  if (!String(call.url).endsWith('/action')) return false
  return JSON.parse(call.init.body).action === 'request-sync'
})
assert.ok(syncPost !== undefined, 'pressing the button posts request-sync')
const workspaceSelect = selects[0]
await workspaceSelect.props.onChange({ target: { value: 'phone-1' } })
const mapPost = calls.slice(before).find(call => {
  if (!String(call.url).endsWith('/action')) return false
  return JSON.parse(call.init.body).action === 'set-workspace-map'
})
assert.deepEqual(JSON.parse(mapPost.init.body), {
  action: 'set-workspace-map',
  desktop: 'ws-1',
  phone: 'phone-1',
})
console.log('ok  the sync button and the workspace pairing post their actions')

/* --------------------------------------------------------------- chrome */

/** Collect every href in a tree, invoking components. */
function hrefs(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) hrefs(child, out)
    return out
  }
  if (typeof node === 'object' && node.props) {
    if (typeof node.type === 'function') {
      cursor = 0
      return hrefs(node.type(node.props), out)
    }
    if (typeof node.props.href === 'string') out.push(node.props.href)
    hrefs(node.props.children, out)
  }
  return out
}

assert.ok(
  hrefs(hydrated).some(href => href.startsWith('http://127.0.0.1:8733/j?t=')),
  'the local control page is linked',
)
console.log(`ok  panel renders (${all.length} chars of text)`)

// The rail icon renders without the shell's size prop.
const iconElement = row.render({})
const icon = iconElement.type(iconElement.props)
assert.equal(icon.type, 'svg')
assert.equal(icon.props.width, 16)
const bigger = row.render({ size: 22 })
assert.equal(bigger.type(bigger.props).props.width, 22)
console.log('ok  rail icon honours the requested size')

// Clock and size formatting are what the log column relies on.
const { clock, size } = module.__test
assert.equal(clock(0), '—')
assert.match(clock(Date.now()), /^\d{2}:\d{2}$/)
assert.equal(size(512), '512 B')
assert.equal(size(2048), '2 KB')
assert.equal(size(5 * 1024 * 1024), '5.0 MB')
console.log('ok  clock and size format')

console.log('\nALL CLIENT CHECKS PASSED')
