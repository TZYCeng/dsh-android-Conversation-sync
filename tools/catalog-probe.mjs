/**
 * Print what this plugin would offer to sync, read-only.
 *
 * Useful when a build starts sending the wrong thing: it shows the exact catalog
 * the panel and the planner see — channels, switches, per-plugin installability,
 * per-skill digests and model rows — against the *real* `$DSH_HOME`, without
 * starting the listener or writing any state.
 *
 * Usage: node tools/catalog-probe.mjs [DSH_HOME]
 */
import os from 'node:os'
import path from 'node:path'

import { createController, activeProfile } from '../lib/controller.js'

const home = process.argv[2] ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

if (!(await import('node:fs')).existsSync(home)) {
  console.error(`no such DSH home: ${home}`)
  process.exit(1)
}

console.log(`home:    ${home}`)
console.log(`profile: ${activeProfile(home) ?? '(none)'}`)

const controller = createController({
  home,
  sessionsRoot: path.join(home, 'sessions'),
  logger: { info() {}, warn() {}, error() {} },
  deviceName: os.hostname(),
  readOnly: true,
})

const status = controller.status()
console.log(`channels: ${JSON.stringify(status.channels)}`)
console.log(`sync:     ${JSON.stringify(status.sync)}`)
console.log(`peer:     ${JSON.stringify(status.peer)}`)
console.log(`counts:   ${JSON.stringify(status.counts)}`)
for (const error of status.errors) console.log(`error:    ${error}`)

console.log(`\nplugins: ${status.plugins.length} (${status.plugins.filter(item => item.installable).length} installable)`)
let pluginBytes = 0
for (const plugin of status.plugins) {
  const marks = `${plugin.selected ? 'x' : '-'}${plugin.installable ? 'x' : '-'}`
  const reason = plugin.reason === null ? '' : `  ${plugin.reason}`
  if (plugin.selected && plugin.installable) pluginBytes += plugin.bytes
  console.log(
    `  [${marks}] ${plugin.name.padEnd(40)} ${String(plugin.version ?? '?').padEnd(12)} ${plugin.state.padEnd(12)}` +
      `${String(plugin.files).padStart(4)} files ${(plugin.bytes / 1024).toFixed(0).padStart(6)} KB${reason}`,
  )
}
console.log(`  selected payload: ${(pluginBytes / 1024 / 1024).toFixed(1)} MB`)

console.log(`\nskills: ${status.skills.length}`)
for (const skill of status.skills) {
  console.log(`  [${skill.selected ? 'x' : '-'}] ${skill.name.padEnd(30)} ${skill.source.padEnd(7)} ${skill.state.padEnd(12)} ${String(skill.files).padStart(3)} files ${(skill.bytes / 1024).toFixed(0)} KB`)
}

console.log(`\nmodels: ${status.models.length} groups`)
for (const model of status.models) {
  const source = model.source === 'plugin' ? `  <plugin:${model.plugin}>` : ''
  console.log(
    `  [${model.selected ? 'x' : '-'}] ${String(model.key).padEnd(32)} ${String(model.models.length).padStart(3)} models ` +
      `${(model.baseURL ?? '').padEnd(38)} keys=${(model.keys ?? []).join(',') || '-'}${source}`,
  )
}
