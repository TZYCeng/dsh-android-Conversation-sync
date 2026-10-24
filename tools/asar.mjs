/**
 * List paths inside an asar archive without extracting it.
 *
 * Usage: node tools/asar.mjs <app.asar> [filter-regex] [--read <path>]
 */
import fs from 'node:fs'

const file = process.argv[2]
const filter = process.argv[3] && !process.argv[3].startsWith('--') ? new RegExp(process.argv[3], 'i') : null
const readIndex = process.argv.indexOf('--read')
const wantRead = readIndex > 0 ? process.argv[readIndex + 1] : null

const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)

const headerSize = head.readUInt32LE(12)
const header = Buffer.alloc(headerSize)
fs.readSync(fd, header, 0, headerSize, 16)
const json = JSON.parse(header.toString('utf8').replace(/\0+$/, ''))
const dataOffset = 8 + head.readUInt32LE(4)

/** Walk the asar tree, collecting `[path, {size, offset}]`. */
function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (child.files) walk(child, full, out)
    else out.push([full, child])
  }
  return out
}

const all = walk(json, '', [])
if (wantRead) {
  const entry = all.find(([p]) => p === wantRead)
  if (!entry) {
    console.error(`not found: ${wantRead}`)
    process.exit(1)
  }
  const buffer = Buffer.alloc(entry[1].size)
  fs.readSync(fd, buffer, 0, entry[1].size, dataOffset + Number(entry[1].offset))
  process.stdout.write(buffer)
} else {
  const hits = filter ? all.filter(([p]) => filter.test(p)) : all
  for (const [p, meta] of hits.slice(0, 400)) console.log(`${String(meta.size).padStart(9)}  ${p}`)
  console.log(`\n${hits.length} of ${all.length} entries`)
}
