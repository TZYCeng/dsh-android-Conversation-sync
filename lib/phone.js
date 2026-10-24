/**
 * Delivery of the phone-side script.
 *
 * The script itself lives in `mobile/dsh-sync.sh` so it can be read, reviewed
 * and edited as what it is — a plain shell script — while this module bakes the
 * pairing values into it for `GET /join.sh`.
 *
 * @module lib/phone
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'dsh-sync.sh')

/** Quote a value for a single-quoted shell literal. */
function shellQuote(value) {
  return String(value).replace(/'/g, `'\\''`)
}

/** Read the template fresh: `join.sh` is fetched a handful of times per pairing,
 *  and a cached copy would keep serving a script the user has since edited. */
function readTemplate() {
  try {
    return fs.readFileSync(SCRIPT, 'utf8')
  } catch (error) {
    return `#!/bin/sh\necho "dsh-sync.sh missing: ${String(error.message ?? error)}" >&2\nexit 1\n`
  }
}

/**
 * Render the phone script with the pairing values substituted.
 * @param values - `{ base, token, name }`.
 * @returns the script text, or a short explanation when the template is missing.
 */
export function phoneScript(values) {
  return readTemplate()
    .replace(`'__BASE__'`, `'${shellQuote(values.base)}'`)
    .replace(`'__TOKEN__'`, `'${shellQuote(values.token)}'`)
    .replace(`'__NAME__'`, `'${shellQuote(values.name)}'`)
}
