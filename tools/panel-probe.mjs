/**
 * Render the sidebar panel against the **real** `$DSH_HOME`, read-only.
 *
 * `test/client.mjs` proves the panel against a hand-written fixture; this probe
 * answers the other question: "does the real catalog (plugins, skills, model
 * groups, both workspace lists) render without blowing up?" It loads
 * `client.js` with a stub React, feeds it `controller.status()` through a fake
 * `fetch`, and prints the flattened text plus a few counts.
 *
 * Usage: node tools/panel-probe.mjs [DSH_HOME] [--text]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { activeProfile, createController } from '../lib/controller.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const showText = args.includes('--text')
const home = args.find(arg => !arg.startsWith('--')) ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

const controller = createController({
  home,
  sessionsRoot: path.join(home, 'sessions'),
  logger: { info() {}, warn() {}, error() {} },
  deviceName: os.hostname(),
  readOnly: true,
})
const status = controller.status()

/* ------------------------------------------------------------- stub React */

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
  useCallback: fn => fn,
  // The panel guards every card with an error boundary, so the stub needs a
  // base class with the state lifecycle a class component uses.
  Component: class {
    constructor(props) {
      this.props = props
      this.state = typeof this.constructor.getDerivedStateFromError === 'function' ? { error: null } : {}
    }
    setState(patch) {
      this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
    }
  },
}

const document = {
  baseURI: 'http://127.0.0.1:63705/',
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }),
  querySelector: () => null,
}
const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(status) })

let definition
const window = { __ModuleLoader__: { load: value => { definition = value } } }
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
vm.runInContext(fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8'), context, { filename: 'client.js' })
const module = definition.factory(() => React)

const registered = []
module.apply({
  effect(fn) { fn() },
  locale: { register: () => () => {}, bind: () => key => module.__test.DICT.zh[key] ?? key },
  slots: {
    inject(_name, fn) { fn() },
    register(options, render) { registered.push({ ...options, render }) },
  },
})

const panel = registered.find(item => item.name === 'main')
if (panel === undefined) {
  console.error('the panel did not register')
  process.exit(1)
}

/** Flatten an element tree into text, invoking every component. */
function walk(node, out) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node === 'object' && node.props) {
    if (typeof node.type === 'function') {
      cursor = 0
      const rendered = String(node.type).startsWith('class')
        ? new node.type(node.props).render()
        : node.type(node.props)
      return walk(rendered, out)
    }
    if (typeof node.type === 'string') out.tags[node.type] = (out.tags[node.type] ?? 0) + 1
    if (node.props.dangerouslySetInnerHTML?.__html) out.text.push('<svg>')
    walk(node.props.children, out)
  }
  return out
}

// The panel registers its effect on the first paint; that effect loads the
// status asynchronously, so the tree has to be walked twice.
cursor = 0
walk(panel.render({}), { text: [], tags: {} })
await new Promise(resolve => setTimeout(resolve, 100))
cursor = 0
const out = walk(panel.render({}), { text: [], tags: {} })
const text = out.text.join(' | ')

console.log(`home:       ${home}`)
console.log(`profile:    ${activeProfile(home) ?? '(none)'}`)
console.log(`status:     ${status.plugins.length} plugins, ${status.skills.length} skills, ${status.models.length} model groups`)
console.log(`workspaces: ${status.workspaces.desktop.length} desktop / ${status.workspaces.phone.length} phone (known=${status.workspaces.phoneKnown})`)
console.log(`request:    ${JSON.stringify(status.request)}`)
console.log(`tags:       ${JSON.stringify(out.tags)}`)
console.log(`text:       ${text.length} chars`)

const selected = text.match(/·\s*(\d+)\/(\d+)\s*已选/gu) ?? []
console.log(`headers:    ${selected.join(' ')}`)

if (showText) {
  for (const chunk of text.split(' | ')) {
    if (chunk.trim() !== '') console.log(`  ${chunk}`)
  }
}
