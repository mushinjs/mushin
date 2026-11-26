import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type InstanceConfig, readJson, upgradeTag as coreUpgradeTag, writeJsonAtomic } from '@mushinjs/core'
import { defaultConfig } from './start'

/** The version of the CLI, which every `@mushinjs/*` package shares. */
export const CLI_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,40}$/

/** `my-plugin` → `myPlugin`, for action names. */
function camel(name: string) {
  return name.replace(/-+([a-z0-9])/g, (_, char: string) => char.toUpperCase()).replace(/-/g, '')
}

function title(name: string) {
  return name.split('-').filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ')
}

/** The files of a new local plugin, by path relative to its folder. */
export function pluginFiles(name: string): Record<string, string> {
  const action = `${camel(name)}.hello`
  return {
    'package.json': JSON.stringify({
      name: `mushin-plugin-${name}`,
      version: '0.1.0',
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      keywords: ['mushin-plugin'],
      mushin: {
        kind: 'app',
        category: 'feature',
        displayName: { en: title(name) },
        description: { en: `Adds the ${action} action. Replace this with what the plugin does.` },
      },
      peerDependencies: { '@mushinjs/core': '*' },
    }, null, 2) + '\n',
    'src/index.ts': `import { type Context, field, z } from '@mushinjs/core'

export const name = '${name}'

/** Services this plugin uses. It starts once they are all there. */
export const inject = ['actions']

/** Settings, shown as a form on the dashboard's Plugins page and saved in mushin.config.json. */
export const Config = z.object({
  greeting: z.string().default('Hello').meta(field('Greeting', 'The word the hello action starts with')),
})

export function apply(ctx: Context, raw: z.input<typeof Config>) {
  const config = Config.parse(raw ?? {})
  const logger = ctx.logger('${name}')

  // An action can be called from the dashboard, flows, Fairy and the HTTP API.
  ctx.actions.define({
    name: '${action}',
    description: 'Greets someone by name. Returns the greeting as text.',
    risk: 'read',
    input: z.object({
      name: z.string().min(1).describe('Who to greet'),
    }),
    handler: ({ name }) => {
      logger.info('greeting %s', name)
      return { text: \`\${config.greeting}, \${name}!\` }
    },
  })
}
`,
  }
}

/** Writes a new plugin folder `<parent>/<name>/` from the template. Returns the folder and the package name. */
export async function createPluginFolder(parent: string, name: string) {
  if (!PLUGIN_NAME.test(name)) throw new Error(`"${name}" is not a plugin name: use lowercase letters, digits and dashes, starting with a letter`)
  const dir = join(parent, name)
  if (existsSync(dir)) throw new Error(`${dir} already exists`)
  const files = pluginFiles(name)
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content)
  }
  return { dir, package: `mushin-plugin-${name}`, files: Object.keys(files) }
}

/**
 * Creates `plugins/<name>/` in an instance and adds the plugin to `mushin.config.json`, so it runs on the next start.
 * Returns the folder and the package name.
 */
export async function newPlugin(baseDir: string, name: string) {
  if (PLUGIN_NAME.test(name) && existsSync(join(baseDir, 'plugins', name))) throw new Error(`plugins/${name} already exists`)
  const { dir, package: pkg } = await createPluginFolder(join(baseDir, 'plugins'), name)
  const configPath = join(baseDir, 'mushin.config.json')
  // A new app has no config until its first start: begin with the default one.
  const config = await readJson<InstanceConfig>(configPath) ?? defaultConfig()
  let added = false
  if (!config.plugins.some((entry) => entry.package === pkg)) {
    const ids = new Set(config.plugins.map((entry) => entry.id))
    let id = name
    for (let n = 2; ids.has(id); n++) id = `${name}-${n}`
    config.plugins.push({ id, package: pkg, enabled: true, config: {} })
    await writeJsonAtomic(configPath, config)
    added = true
  }
  return { dir, package: pkg, added }
}

// Installing and upgrading live in core, where the supervisor and the update actions use them too.
export { appPackageManager, appPackages, type PackageManager, run, upgradeCommand } from '@mushinjs/core'

/** The dist-tag an upgrade follows: `next` for a preview, `latest` for a release. */
export function upgradeTag(version = CLI_VERSION) {
  return coreUpgradeTag(version)
}
