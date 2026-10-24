/**
 * QR rendering for the pairing link.
 *
 * Encoding comes from Kazuhiko Arase's `qrcode-generator` (MIT, zero
 * dependencies, vendored under `./vendor/qrcode.js`) so the plugin never needs
 * the network or an image library at runtime. Only the matrix is borrowed; the
 * markup is generated here, because both surfaces that show a code — the sidebar
 * panel and the LAN page — want inline SVG with no external asset.
 *
 * @module lib/qr
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const qrcode = require('./vendor/qrcode.cjs')

// Both surfaces may carry a non-ASCII device name inside the payload.
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']

/**
 * Build a QR code as a self-contained SVG document.
 * @param text - payload to encode; encodes at error-correction level M.
 * @param options - `size` in CSS pixels and `margin` in modules.
 * @returns an `<svg>` string sized in CSS pixels, or an empty string when the
 *   payload is too large for the format.
 */
export function qrSvg(text, options = {}) {
  const size = options.size ?? 220
  const margin = options.margin ?? 4
  let code
  try {
    code = qrcode(0, 'M')
    code.addData(text)
    code.make()
  } catch (_error) {
    return ''
  }
  const count = code.getModuleCount()
  const total = count + margin * 2
  const rects = []
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!code.isDark(row, column)) continue
      rects.push(`M${column + margin} ${row + margin}h1v1h-1z`)
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="pairing QR code">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${rects.join('')}" fill="#000000"/>` +
    `</svg>`
  )
}
