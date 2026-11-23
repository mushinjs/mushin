/**
 * Whether a command only looks: lists, reads and status checks that change nothing. Used to run such commands for
 * Fairy without asking when the user allows it. Conservative: anything it does not know, any redirection, command
 * substitution or mention of `.env` counts as a change.
 */

const PLAIN = new Set([
  'ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'less', 'more', 'wc', 'tree', 'stat', 'file', 'du', 'df',
  'grep', 'rg', 'findstr', 'which', 'where', 'whoami', 'hostname', 'uname', 'date', 'echo', 'nproc', 'free', 'uptime', 'ps', 'tasklist',
  'get-childitem', 'gci', 'get-content', 'gc', 'get-location', 'gl', 'get-item', 'gi', 'select-string', 'sls', 'test-path', 'resolve-path',
  'get-process', 'gps', 'measure-object', 'select-object', 'sort-object', 'format-table', 'format-list', 'out-string', 'get-date', 'write-output',
])

/** Programs that only look with some subcommands or flags. */
const VERSION = /^(-v|--version|-version|version)$/i
const SUB: Record<string, (args: string[]) => boolean> = {
  git: (args) => {
    const [sub, ...rest] = args.filter((arg) => !/^-C$|^--no-pager$/.test(arg))
    if (!sub) return false
    if (['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'reflog'].includes(sub)) return true
    if (sub === 'branch') return rest.every((arg) => /^(-a|-r|-v|-vv|--list|--show-current|--all|--remotes)$/.test(arg))
    if (sub === 'remote') return rest.every((arg) => /^(-v|--verbose|show|get-url)$/.test(arg) || !arg.startsWith('-'))
      && !rest.some((arg) => /^(add|remove|rm|rename|set-url|prune)$/.test(arg))
    if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show'
    if (sub === 'config') return rest.some((arg) => /^(--get|--list|-l|--get-all)$/.test(arg))
    return false
  },
  node: (args) => args.length === 1 && VERSION.test(args[0]!),
  npm: (args) => (args.length === 1 && VERSION.test(args[0]!)) || ['ls', 'list', 'view', 'outdated', 'root', 'prefix', 'config'].includes(args[0] ?? '') && !(args[0] === 'config' && args[1] !== 'get' && args[1] !== 'list'),
  pnpm: (args) => (args.length === 1 && VERSION.test(args[0]!)) || ['ls', 'list', 'why', 'outdated', 'root'].includes(args[0] ?? ''),
  python: (args) => args.length === 1 && VERSION.test(args[0]!),
  python3: (args) => args.length === 1 && VERSION.test(args[0]!),
  find: (args) => !args.some((arg) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(arg)),
  sed: (args) => args.includes('-n') && !args.some((arg) => /^(-i|--in-place)/.test(arg)),
}

/** Splits a command line into words, honoring simple quotes; good enough to look at program names and flags. */
function words(segment: string) {
  const out: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let match = pattern.exec(segment); match; match = pattern.exec(segment)) out.push(match[1] ?? match[2] ?? match[3]!)
  return out
}

export function isReadOnlyCommand(command: string) {
  const text = command.trim()
  if (!text || text.length > 2000) return false
  // Writes to files, runs other commands inside this one, or touches secrets.
  if (/[<>`]|\$\(|\bTee-Object\b|\btee\b|\.env\b|\bset-content\b|\bout-file\b|\binvoke-expression\b|\biex\b/i.test(text)) return false
  const segments = text.split(/\|\||&&|[|;\n]|(?<![<>])&(?!&)/)
  return segments.every((segment) => {
    const [first, ...args] = words(segment.trim())
    if (!first) return true
    const program = first.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
    if (PLAIN.has(program)) return true
    return SUB[program]?.(args) ?? false
  })
}
