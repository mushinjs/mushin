/**
 * Whether a command could do harm that is hard to undo: delete files or data, change the system, its users or its
 * services, stop other programs, push or publish, run code fetched from the network, or touch secrets. Fairy's
 * "approve for me" mode runs everything else without asking (builds, installs into the project, scripts, look-only
 * commands) and asks for these. It reads program names and a few flags, so it errs toward asking: an inline script
 * it cannot follow counts as risky when it mentions deleting or spawning.
 */

/** Programs that delete, change the system or users, stop processes, or run as someone else, whatever their flags. */
const RISKY = new Set([
  // Deleting
  'rm', 'rmdir', 'unlink', 'shred', 'del', 'erase', 'rd', 'truncate', 'remove-item', 'ri', 'clear-content', 'clc',
  'remove-itemproperty', 'rp', 'clear-recyclebin', 'clear-item', 'cli', 'rimraf', 'del-cli', 'trash',
  // The machine itself
  'shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer', 'format', 'format-volume', 'mkfs', 'dd',
  'diskpart', 'fdisk', 'parted', 'bcdedit', 'regedit', 'netsh', 'iptables', 'ufw', 'setx', 'set-executionpolicy',
  'set-itemproperty', 'sp', 'new-itemproperty', 'attrib', 'icacls', 'takeown', 'launchctl', 'service',
  // Running as someone else, and users
  'sudo', 'su', 'doas', 'runas', 'useradd', 'userdel', 'usermod', 'passwd', 'new-localuser', 'remove-localuser', 'set-localuser',
  // Stopping other programs
  'kill', 'pkill', 'killall', 'taskkill', 'stop-process', 'spps', 'stop-service', 'spsv',
  // Installing system-wide
  'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew', 'choco', 'winget', 'scoop', 'snap',
])

/** Programs that are risky only with some subcommands or flags. */
const SUB: Record<string, (args: string[]) => boolean> = {
  git: (args) => {
    const [sub, ...rest] = args.filter((arg) => !/^-C$|^--no-pager$/.test(arg))
    if (['push', 'clean', 'rebase', 'filter-branch', 'filter-repo', 'rm', 'gc', 'prune'].includes(sub ?? '')) return true
    if (sub === 'reset') return rest.includes('--hard') || rest.includes('--merge')
    if (sub === 'checkout' || sub === 'restore') return rest.includes('--') || rest.includes('.') || rest.includes('-f') || rest.includes('--force')
    if (sub === 'branch' || sub === 'tag') return rest.some((arg) => /^(-d|-D|--delete|-f|--force)$/.test(arg))
    if (sub === 'stash') return ['drop', 'clear'].includes(rest[0] ?? '')
    if (sub === 'remote') return ['remove', 'rm', 'set-url'].includes(rest[0] ?? '')
    if (sub === 'config') return rest.includes('--global') || rest.includes('--system')
    return false
  },
  npm: (args) => ['publish', 'unpublish', 'deprecate', 'owner', 'access', 'adduser', 'login', 'logout', 'token'].includes(args[0] ?? '') || args.some((arg) => arg === '-g' || arg === '--global'),
  pnpm: (args) => ['publish'].includes(args[0] ?? '') || args.some((arg) => arg === '-g' || arg === '--global'),
  yarn: (args) => ['publish', 'npm'].includes(args[0] ?? '') || (args[0] === 'global'),
  bun: (args) => args[0] === 'publish' || args.some((arg) => arg === '-g' || arg === '--global'),
  pip: (args) => args[0] === 'uninstall' || args.includes('--user') || args.includes('--break-system-packages'),
  pip3: (args) => args[0] === 'uninstall' || args.includes('--user') || args.includes('--break-system-packages'),
  cargo: (args) => ['publish', 'yank', 'owner', 'login'].includes(args[0] ?? '') || args[0] === 'install',
  twine: (args) => args[0] === 'upload',
  docker: (args) => ['rm', 'rmi', 'kill', 'stop', 'push', 'prune', 'system', 'volume', 'network', 'login'].includes(args[0] ?? '') || args.includes('--privileged'),
  kubectl: (args) => ['delete', 'apply', 'replace', 'patch', 'scale', 'drain', 'cordon', 'edit', 'create', 'rollout'].includes(args[0] ?? ''),
  gh: (args) => args.some((arg) => /^(delete|merge|close|create|edit|comment|archive|transfer|rename|upload|lock)$/.test(arg)),
  find: (args) => args.some((arg) => /^-(delete|exec|execdir|ok|okdir)$/.test(arg)),
  chmod: (args) => args.some((arg) => /^-R$|^--recursive$/.test(arg)) || args.some((arg) => /^\/(\w|$)/.test(arg)),
  chown: () => true,
  chgrp: () => true,
  reg: (args) => ['delete', 'add', 'import', 'restore', 'load', 'unload', 'copy'].includes((args[0] ?? '').toLowerCase()),
  sc: (args) => ['delete', 'config', 'stop', 'create', 'failure'].includes((args[0] ?? '').toLowerCase()),
  'sc.exe': (args) => ['delete', 'config', 'stop', 'create', 'failure'].includes((args[0] ?? '').toLowerCase()),
  systemctl: (args) => args.some((arg) => /^(stop|disable|mask|kill|restart|reboot|poweroff|halt|isolate|enable|daemon-reload)$/.test(arg)),
  schtasks: (args) => args.some((arg) => /^\/(delete|create|change|end)$/i.test(arg)),
  net: (args) => ['user', 'localgroup', 'stop', 'share', 'use'].includes((args[0] ?? '').toLowerCase()),
  crontab: (args) => args.includes('-r') || args.includes('-e'),
  'start-process': (args) => args.some((arg) => /^runas$/i.test(arg)),
  saps: (args) => args.some((arg) => /^runas$/i.test(arg)),
}

/** Programs that run the rest of their words as a command: `env FOO=1 npm test`, `xargs rm`, `npx rimraf`. */
const PREFIX = new Set(['env', 'nohup', 'time', 'nice', 'ionice', 'xargs', 'watch', 'command', 'builtin', 'exec', 'call', 'npx', 'pnpx', 'bunx'])

/** Shells, with the flag that runs a command given as text. */
const SHELLS: Record<string, RegExp> = {
  bash: /^-c$/, sh: /^-c$/, zsh: /^-c$/, dash: /^-c$/, fish: /^-c$/, wsl: /^(-e|--exec|--)$/,
  cmd: /^\/[ck]$/i, powershell: /^-(c|command)$/i, pwsh: /^-(c|command)$/i,
}

/** Interpreters, with the flag that runs code given as text, and what in such code deletes files or starts programs. */
const INLINE: Record<string, RegExp> = { node: /^(-e|-p|--eval|--print)$/, python: /^-c$/, python3: /^-c$/, py: /^-c$/, perl: /^-e$/, ruby: /^-e$/, deno: /^eval$/, bun: /^-e$/ }
const HARMFUL_CODE = /rmSync|rmdirSync|unlinkSync|\brm\(|rimraf|rmtree|os\.remove|os\.unlink|os\.rmdir|shutil\.|child_process|execSync|spawnSync|\bexec\(|subprocess|os\.system|Deno\.remove|Bun\.spawn|truncate/i

/** Splits a command line into words, honoring simple quotes. */
function words(segment: string) {
  const out: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let match = pattern.exec(segment); match; match = pattern.exec(segment)) out.push(match[1] ?? match[2] ?? match[3]!)
  return out
}

function programOf(word: string) {
  return word.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

/** Whether one command, without `;`, `|` or `&&`, is risky. */
function riskySegment(list: string[], depth: number): boolean {
  let rest = list
  // Leading variable assignments and wrappers (`FOO=1 npm test`, `nohup …`) run what follows.
  while (rest.length && (/^\w+=/.test(rest[0]!) || PREFIX.has(programOf(rest[0]!)))) {
    rest = rest.slice(1)
    while (rest.length && /^-/.test(rest[0]!)) rest = rest.slice(1)
  }
  const [first, ...args] = rest
  if (!first) return false
  const program = programOf(first)
  if (RISKY.has(program) || /^mkfs\./.test(program)) return true
  if (SUB[program]?.(args)) return true
  const shell = SHELLS[program]
  if (shell) {
    const at = args.findIndex((arg) => shell.test(arg))
    if (at >= 0) return depth > 3 || isRiskyCommand(args.slice(at + 1).join(' '), depth + 1)
    // Encoded commands cannot be read.
    return args.some((arg) => /^-(e|ec|enc|encodedcommand)$/i.test(arg))
  }
  const inline = INLINE[program]
  if (inline) {
    const at = args.findIndex((arg) => inline.test(arg))
    if (at >= 0) return HARMFUL_CODE.test(args.slice(at + 1).join(' '))
  }
  return false
}

export function isRiskyCommand(command: string, depth = 0): boolean {
  const text = command.trim()
  if (!text) return false
  if (text.length > 4000) return true
  // Secrets, code fetched and run at once, inline evaluation, and SQL that drops or deletes.
  if (/\.env\b|id_rsa|id_ed25519|\.ssh[\\/]|\.aws[\\/]|\.npmrc\b|\.git-credentials/i.test(text)) return true
  if (/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|powershell|pwsh|python3?|node|perl|ruby)\b/i.test(text)) return true
  if (/\b(iex|invoke-expression|eval)\b/i.test(text)) return true
  if (/\b(drop\s+(table|database|schema|index|view)|truncate\s+table|delete\s+from|alter\s+table)\b/i.test(text)) return true
  // Writes to files outside the project: an absolute path, the home folder, or a system location.
  for (const match of text.matchAll(/(?<![<-])>>?\s*["']?([^\s"';|&]+)/g)) {
    const target = match[1]!
    if (/^(\/dev\/(null|stdout|stderr)|\$null|nul|&\d)$/i.test(target)) continue
    if (/^(\/|~|[a-z]:[\\/]|\$env:|%\w+%|\$home)/i.test(target)) return true
  }
  const segments = text.split(/\|\||&&|[|;\n]|(?<![<>])&(?!&|\d)/)
  return segments.some((segment) => riskySegment(words(segment.trim()), depth))
}
