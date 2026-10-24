/**
 * Enough version comparison to answer one question: is the copy on the phone
 * already at least as new as the one on this desktop?
 *
 * A sync never downgrades a phone plugin. "Same version" is the case the user
 * asked to skip, but a manual install can leave the phone *ahead*, and pushing
 * the desktop's copy over it would silently roll the user back — so "ahead" is
 * skipped as well, and reported separately.
 *
 * The comparison is deliberately forgiving: release segments are compared
 * numerically, a pre-release suffix (`-rc.2`, `-beta`) ranks below the plain
 * release, and anything unparsable falls back to plain string equality (which
 * means "not comparable", and the caller sends).
 *
 * @module lib/version
 */

/**
 * Split a version into numeric and textual parts.
 * @param value - a version string.
 * @returns `{ numbers, prerelease, raw }`, or null when nothing numeric parses.
 */
function parse(value) {
  const raw = String(value ?? '').trim().replace(/^v/iu, '')
  if (raw.length === 0) return null
  const [release, ...rest] = raw.split('-')
  const numbers = release.split('.').map((part) => {
    const match = /^(\d+)/u.exec(part)
    return match === null ? null : Number.parseInt(match[1], 10)
  })
  if (numbers.length === 0 || numbers.some(item => item === null)) return null
  return { numbers, prerelease: rest.join('-'), raw }
}

/**
 * Compare two pre-release suffixes the way semver does.
 *
 * Dot-separated identifiers are compared one by one: numeric identifiers compare
 * numerically and rank *below* alphanumeric ones, and a shorter suffix that is a
 * prefix of the other ranks lower (`2.0.0-rc` < `2.0.0-rc.2`).
 *
 * @param left - a suffix without its leading `-`.
 * @param right - a suffix without its leading `-`.
 * @returns -1, 0 or 1.
 */
function comparePrerelease(left, right) {
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index]
    const other = b[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    const numberA = /^\d+$/u.test(one)
    const numberB = /^\d+$/u.test(other)
    if (numberA && numberB) {
      const delta = Number(one) - Number(other)
      if (delta !== 0) return delta < 0 ? -1 : 1
      continue
    }
    if (numberA !== numberB) return numberA ? -1 : 1
    if (one !== other) return one < other ? -1 : 1
  }
  return 0
}

/**
 * Compare two versions.
 * @param left - a version string.
 * @param right - a version string.
 * @returns -1, 0 or 1 when both parse; null when they cannot be compared.
 */
export function compareVersions(left, right) {
  const a = parse(left)
  const b = parse(right)
  if (a === null || b === null) return null
  const length = Math.max(a.numbers.length, b.numbers.length)
  for (let index = 0; index < length; index += 1) {
    const one = a.numbers[index] ?? 0
    const other = b.numbers[index] ?? 0
    if (one !== other) return one < other ? -1 : 1
  }
  // Same release: a pre-release is older than the plain release.
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1
  if (b.prerelease.length === 0 && a.prerelease.length > 0) return -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * Is the remote copy at least as new as the local one?
 *
 * Used to decide "nothing to send": a null comparison (unparsable version)
 * answers false, so the caller keeps its conservative "send it" behaviour.
 *
 * @param remote - the version reported by the other machine.
 * @param local - the version this machine would send.
 * @returns true only when both parse and remote >= local.
 */
export function atLeast(remote, local) {
  const compared = compareVersions(remote, local)
  return compared !== null && compared >= 0
}

/** Is the remote copy strictly newer than the local one? */
export function isNewer(remote, local) {
  const compared = compareVersions(remote, local)
  return compared !== null && compared > 0
}
