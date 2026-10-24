/**
 * Verify the pairing QR: the SVG must carry exactly the matrix the encoder
 * produced, at integer module coordinates, inside a quiet zone wide enough to
 * scan.
 *
 * Usage: node test/test-qr.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { qrSvg } from '../lib/qr.js'

const require = createRequire(import.meta.url)
const qrcode = require('../lib/vendor/qrcode.cjs')

/** Pull `M<x> <y>h1v1h-1z` module coordinates back out of the SVG. */
function decode(svg) {
  const modules = new Set()
  for (const match of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    modules.add(`${match[1]},${match[2]}`)
  }
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)
  return { modules, total: Number(viewBox?.[1] ?? 0) }
}

const payloads = [
  'http://192.168.1.9:8733/j?t=0123456789abcdef0123456789abcdef',
  'http://10.0.0.7:8733/j?t=ffffffffffffffffffffffffffffffff',
  'http://172.26.23.72:8733/j?t=0123456789abcdef0123456789abcdef',
  '中文设备名 · http://192.168.1.9:8733/j?t=0123456789abcdef0123456789abcdef',
  `http://192.168.1.9:8733/j?t=${'a'.repeat(64)}`,
]

for (const payload of payloads) {
  const svg = qrSvg(payload, { size: 208 })
  assert.notEqual(svg, '', `payload should encode: ${payload.slice(0, 40)}`)
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, 'svg root')
  assert.match(svg, /width="208" height="208"/, 'requested size')
  assert.match(svg, /shape-rendering="crispEdges"/, 'crisp edges')
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/, 'quiet zone is white')
  assert.match(svg, /fill="#000000"/, 'modules are black')

  // Rebuild the matrix the SVG draws and compare it with the encoder's own.
  const { modules, total } = decode(svg)
  const code = qrcode(0, 'M')
  code.addData(payload)
  code.make()
  const count = code.getModuleCount()
  const margin = 4
  assert.equal(total, count + margin * 2, 'viewBox covers the matrix plus the quiet zone')

  const expected = new Set()
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (code.isDark(row, column)) expected.add(`${column + margin},${row + margin}`)
    }
  }
  assert.equal(modules.size, expected.size, 'dark module count')
  for (const cell of expected) assert.ok(modules.has(cell), `missing dark module ${cell}`)
  assert.equal(modules.size, expected.size)

  // A scanner needs a clear margin on every side.
  const coords = [...modules].map(cell => cell.split(',').map(Number))
  const minX = Math.min(...coords.map(([x]) => x))
  const minY = Math.min(...coords.map(([, y]) => y))
  const maxX = Math.max(...coords.map(([x]) => x))
  const maxY = Math.max(...coords.map(([, y]) => y))
  assert.ok(minX >= margin && minY >= margin, 'quiet zone on the top/left')
  assert.ok(maxX <= total - margin - 1 && maxY <= total - margin - 1, 'quiet zone on the bottom/right')

  console.log(`ok  v${(count - 17) / 4} · ${count}x${count} modules · ${modules.size} dark · ${payload.slice(0, 32)}…`)
}

// A payload far too large must fail softly instead of throwing.
assert.equal(qrSvg('x'.repeat(5000)), '')
console.log('ok  oversized payload returns an empty string instead of throwing')

// The UTF-8 byte mapping is installed, which is what makes a non-ASCII payload work.
assert.equal(typeof qrcode.stringToBytesFuncs['UTF-8'], 'function')
console.log('ok  UTF-8 encoder is installed')

console.log('\nALL QR CHECKS PASSED')
