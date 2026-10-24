/**
 * Project directory name ("slug") for a workspace path.
 *
 * DSH stores a session under `sessions/<project-key>/<session-id>/`, where the
 * project key is derived from the session header's `cwd` — and the engine
 * derives the *file path it will read* from that same header. A copied log
 * therefore only stays reachable while its directory name and its header agree:
 * rewrite one and the session vanishes from the store. This module is the single
 * place that computes the key.
 *
 * The rule, taken from the persistence backend's `projectKey()` and verified
 * against every directory on this machine:
 *
 *   `D:\code\Odds and ends` -> `--D-code-Odds~0020and~0020ends--`
 *   `/storage/emulated/0/DSH` -> `--storage-emulated-0-DSH--`
 *
 * i.e. a run of `:` `/` `\` becomes one `-`; remaining characters outside
 * `[A-Za-z0-9._-]` (and `~` itself) become `~` + the UTF-16 code unit in
 * **four upper-case** hex digits; leading dashes are dropped; the whole thing is
 * capped at 251 characters and wrapped in `--`.
 *
 * @module lib/slug
 */

/** The kernel's cap on one filesystem component. */
const MAX_KEY = 251

/**
 * Derive the project key for an absolute workspace path.
 * @param cwd - absolute path as the host would see it.
 * @returns the directory name DSH uses under `sessions/`.
 */
export function slugOf(cwd) {
  const text = String(cwd)
  if (text.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const body = readable.replace(/^-+/u, '') || 'root'
  return `--${body.slice(0, MAX_KEY)}--`
}

/** The directory name DSH uses for a session that recorded no `cwd`. */
export const NO_CWD_KEY = '_no-cwd'

/**
 * Normalize a path for comparison: separators unified, trailing separators
 * dropped, case folded only where the platform folds it.
 * @param value - raw path.
 * @param foldCase - true for Windows/macOS style comparisons.
 */
export function normalizePath(value, foldCase) {
  let out = String(value).replace(/\\/gu, '/').replace(/\/{2,}/gu, '/')
  if (out.length > 1) out = out.replace(/\/+$/u, '')
  return foldCase ? out.toLowerCase() : out
}

/** The final path segment, used as the default workspace title. */
export function baseName(cwd) {
  const parts = String(cwd).replace(/\\/gu, '/').split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : 'workspace'
}
