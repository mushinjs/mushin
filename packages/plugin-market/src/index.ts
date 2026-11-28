import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appLockFile, checkUpdates, type Context, type Fetch, MUSHIN_VERSION, MushinError, readJsonFile, supervisor, UPDATE_CHECK_INTERVAL,
  type UpdateChannel, type UpdateReport, upgradeDir, type UpgradePlan, type UpgradeResult, writeJsonFile, z,
} from '@mushinjs/core'
import type {} from '@mushinjs/plugin-storage'
import { defineMarket } from './market'

export const name = 'market'
export const inject = ['actions', 'storage']

/** What the person chose: follow the channel of the running version, or one of them. */
export type ChannelSetting = 'auto' | UpdateChannel

interface Settings {
  channel: ChannelSetting
}

const NO_SUPERVISOR = 'Restarting and updating from the dashboard need Mushin.js started with "mushin start" (without --no-supervisor), which keeps a small supervisor that installs while the app is stopped. Stop Mushin.js and start it again with "mushin start", or update by hand: stop it and run "mushin upgrade".'

/** The start of a release's notes on GitHub, for the update banner. */
async function releaseNotes(version: string) {
  const response = await fetch(`https://api.github.com/repos/mushinjs/mushin/releases/tags/v${version}`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) return undefined
  const body = String(((await response.json()) as { body?: string }).body ?? '').trim()
  return body.length > 1200 ? `${body.slice(0, 1200)}…` : body || undefined
}

export interface MarketOptions {
  /** For tests: the registry check, instead of asking npm. */
  check?: typeof checkUpdates
  /** For tests: the supervisor link. */
  link?: () => ReturnType<typeof supervisor>
  /** For tests: the app folder whose package.json is backed up. */
  baseDir?: string
  /** For tests: requests to the registry and the market index. */
  fetch?: Fetch
}

export function apply(ctx: Context, _config: unknown, options: MarketOptions = {}) {
  const logger = ctx.logger('market')
  const baseDir = options.baseDir ?? ctx.baseDir ?? process.cwd()
  const dirs = ctx.storage.dirs
  const dir = upgradeDir(dirs.data)
  const cacheFile = join(dirs.data, 'updates.json')
  const settingsFile = join(dirs.data, 'update-settings.json')
  const check = options.check ?? checkUpdates
  const link = options.link ?? supervisor

  let report: UpdateReport | undefined
  let checking: Promise<UpdateReport> | undefined

  const settings = async () => ({ channel: 'auto' as ChannelSetting, ...await readJsonFile<Settings>(settingsFile) })

  /** Third-party plugins in the config, besides the app's own dependencies. */
  const configured = () => (ctx.get('manager')?.entries ?? []).map((entry) => entry.package).filter((pkg) => !pkg.startsWith('@mushinjs/'))

  async function refresh() {
    checking ??= (async () => {
      const { channel } = await settings()
      const next = await check({
        baseDir,
        version: MUSHIN_VERSION,
        channel: channel === 'auto' ? undefined : channel,
        extraPackages: configured(),
        notes: releaseNotes,
      })
      report = next
      await writeJsonFile(cacheFile, next).catch(() => {})
      if (next.error) logger.warn('could not check for updates: %s', next.error)
      return next
    })().finally(() => (checking = undefined))
    return checking
  }

  /** The last report when it is recent enough, else a new one. */
  async function current(force = false) {
    report ??= await readJsonFile<UpdateReport>(cacheFile)
    if (!force && report && Date.now() - report.checkedAt < UPDATE_CHECK_INTERVAL) return report
    return refresh()
  }

  /**
   * Hands an install, update or uninstall to the supervisor: writes the plan, backs up package.json and the lock
   * file for going back, and asks it to stop the app and do it.
   */
  async function startPlan(input: Pick<UpgradePlan, 'kind' | 'packages' | 'remove' | 'to'>) {
    const line = link()
    if (!line) throw new MushinError('unavailable', NO_SUPERVISOR)
    const plan: UpgradePlan = { ...input, from: MUSHIN_VERSION, to: input.to ?? MUSHIN_VERSION, time: Date.now(), dataDir: dirs.data, logsDir: dirs.logs }
    await mkdir(join(dir, 'backup'), { recursive: true })
    await copyFile(join(baseDir, 'package.json'), join(dir, 'backup', 'package.json'))
    const lock = appLockFile(baseDir)
    if (lock) await copyFile(lock, join(dir, 'backup', lock.endsWith('pnpm-lock.yaml') ? 'pnpm-lock.yaml' : 'package-lock.json'))
    await writeJsonFile(join(dir, 'plan.json'), plan)
    logger.info('%s: %s', plan.kind ?? 'update', [...plan.packages, ...(plan.remove ?? []).map((name) => `-${name}`)].join(' '))
    // Answer first, so the dashboard hears it before the app stops.
    setTimeout(() => line.send({ type: 'update', packages: plan.packages, dir }).catch((error) => logger.error('could not reach the supervisor: %s', error)), 300)
    return plan
  }

  defineMarket(ctx, { baseDir, dataDir: dirs.data, logsDir: dirs.logs, link, startPlan, afterChange: () => refresh().catch(() => {}), fetch: options.fetch })

  // At start (after the plugins settle) and every six hours.
  ctx.effect(() => {
    const first = setTimeout(() => current().catch((error) => logger.warn('update check failed: %s', error)), 15_000)
    const timer = setInterval(() => refresh().catch((error) => logger.warn('update check failed: %s', error)), UPDATE_CHECK_INTERVAL)
    first.unref?.()
    timer.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  })

  ctx.actions.define({
    name: 'plugins.updates',
    description: 'Newer versions of Mushin.js (all official packages update together) and of the third-party plugins installed from npm, with whether each runs on this version. Checked every six hours; refresh asks the registry now. mode "development" means this copy runs from source and updates with git instead.',
    risk: 'read',
    input: z.object({ refresh: z.boolean().optional().describe('Ask the registry now instead of using the last check') }),
    handler: async ({ refresh: force }) => {
      const value = await current(!!force)
      const { channel } = await settings()
      return { ...value, version: MUSHIN_VERSION, supervised: !!link(), channel }
    },
  })

  ctx.actions.define({
    name: 'system.updateChannel',
    description: 'Read or set which versions updates follow: auto (previews for a preview version, releases otherwise), latest (releases) or next (previews).',
    risk: 'write',
    input: z.object({ channel: z.enum(['auto', 'latest', 'next']).optional() }),
    handler: async ({ channel }) => {
      if (channel) {
        await writeJsonFile(settingsFile, { ...await settings(), channel })
        await refresh().catch(() => {})
      }
      return settings()
    },
  })

  ctx.actions.define({
    name: 'plugins.applyUpdates',
    description: 'Install updates and restart Mushin.js. Naming any @mushinjs package updates all of them together to the newest version; third-party plugins update to their newest version. The app stops while it installs (bots go offline); if the new version does not start, everything goes back to how it was. system.updateResult says how it went.',
    risk: 'dangerous',
    input: z.object({ packages: z.array(z.string()).min(1).describe('Package names from plugins.updates') }),
    handler: async ({ packages }) => {
      const line = link()
      if (!line) throw new MushinError('unavailable', NO_SUPERVISOR)
      const value = await current()
      if (value.mode !== 'app') throw new MushinError('conflict', 'This copy of Mushin.js runs from source: update it with git pull, not from here.')
      const specs: string[] = []
      let to = MUSHIN_VERSION
      if (packages.some((pkg) => pkg.startsWith('@mushinjs/'))) {
        const available = value.mushin?.available
        if (!available) throw new MushinError('conflict', `Mushin.js ${MUSHIN_VERSION} is the newest version on its channel`)
        specs.push(...value.mushin!.packages.map((pkg) => `${pkg}@${available}`))
        to = available
      }
      for (const pkg of packages.filter((item) => !item.startsWith('@mushinjs/'))) {
        const plugin = value.plugins.find((item) => item.package === pkg)
        if (!plugin?.available) throw new MushinError('invalid_input', `${pkg} has no update`)
        specs.push(`${pkg}@${plugin.available}`)
      }
      const plan = await startPlan({ kind: 'update', packages: specs, to })
      return { started: true, time: plan.time, packages: specs, from: plan.from, to }
    },
  })

  ctx.actions.define({
    name: 'system.restart',
    description: 'Restart Mushin.js: every plugin and bot stops and starts again, on the same version. Bots are offline for a moment.',
    risk: 'dangerous',
    input: z.object({}),
    handler: async () => {
      const line = link()
      if (!line) throw new MushinError('unavailable', NO_SUPERVISOR)
      logger.info('restarting')
      setTimeout(() => line.send({ type: 'restart' }).catch((error) => logger.error('could not reach the supervisor: %s', error)), 300)
      return { restarting: true, time: Date.now() }
    },
  })

  ctx.actions.define({
    name: 'system.updateResult',
    description: 'How the last update went: whether it worked, the versions, the error and the log file. seen marks it as shown.',
    risk: 'read',
    input: z.object({ seen: z.boolean().optional() }),
    handler: async ({ seen }) => {
      const file = join(dir, 'result.json')
      const result = await readJsonFile<UpgradeResult>(file)
      if (result && seen && !result.seen) await writeJsonFile(file, { ...result, seen: true })
      return { result: result ?? null, version: MUSHIN_VERSION, startedAt: Date.now() - Math.round(process.uptime() * 1000) }
    },
  })
}
