/**
 * Just enough semver for plugin dependency ranges: `*`, `1.2.3`, `>=0.2.0`, `^1.2`, `~1.2.3`,
 * `1.x`, ranges joined by spaces (all must hold) and `||` (any may hold). Prerelease tags are
 * ignored when comparing.
 */

type Version = [number, number, number]

/** Reads `1.2.3`, `v1.2`, `1.2.3-rc.1`; missing parts count as 0. */
export function parseVersion(text: string): Version | undefined {
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?\s*$/.exec(text)
  if (!match) return
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

export function compareVersions(a: Version, b: Version) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** One comparator such as `>=1.2.0` or `^1.2`, as a test on a version. */
function comparator(text: string): ((version: Version) => boolean) | undefined {
  if (text === '*' || text === '' || text === 'x' || text === 'X' || text === 'latest') return () => true
  const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/.exec(text)
  if (!match) return
  const op = match[1] ?? ''
  const parts = [match[2], match[3], match[4]]
  // `1.x` and `1` mean any 1.*.*; the first wildcard or missing part ends the fixed prefix.
  const fixed = parts.findIndex((part) => part === undefined || /^[xX*]$/.test(part))
  const known = (fixed < 0 ? 3 : fixed)
  const base = parts.map((part, index) => (index < known ? Number(part) : 0)) as Version
  if (op === '' || op === '=') {
    if (known === 3) return (version) => compareVersions(version, base) === 0
    return (version) => base.slice(0, known).every((value, index) => version[index] === value)
  }
  if (op === '>=') return (version) => compareVersions(version, base) >= 0
  if (op === '>') return (version) => compareVersions(version, base) > 0
  if (op === '<=') return (version) => compareVersions(version, base) <= 0
  if (op === '<') return (version) => compareVersions(version, base) < 0
  if (op === '~') {
    const upper: Version = known >= 2 ? [base[0], base[1] + 1, 0] : [base[0] + 1, 0, 0]
    return (version) => compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0
  }
  // `^`: changes that do not modify the left-most non-zero part.
  const upper: Version = base[0] > 0 || known === 1
    ? [base[0] + 1, 0, 0]
    : base[1] > 0 || known === 2 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1]
  return (version) => compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0
}

/** `>= 1.2` and `>=1.2` mean the same. */
const tidy = (range: string) => range.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')

/** True when the range is written in a form this module understands. */
export function validRange(range: string) {
  return tidy(range).split('||').every((part) => part.trim().split(/\s+/).every((item) => !!comparator(item)))
}

/** Whether `version` falls in `range`. An unreadable version or range never satisfies. */
export function satisfies(version: string, range: string) {
  const parsed = parseVersion(version)
  if (!parsed) return false
  return tidy(range).split('||').some((part) => {
    const tests = part.trim().split(/\s+/).map(comparator)
    return tests.every((test) => !!test && test(parsed))
  })
}
