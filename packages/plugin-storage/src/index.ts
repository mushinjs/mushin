import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Context, EnvFile, field, readJson, Service, writeJsonAtomic, z } from '@mushinjs/core'
import { childrenOf, type LayoutDirs, pathOf } from './layout'

export * from './layout'

declare module '@mushinjs/core' {
  interface Context {
    storage: Storage
  }
}

const keyPattern = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/

/**
 * JSON documents under the instance directory. Plugins name documents by key, such as `flows/abc`;
 * `layout.ts` decides the file (`data/plugins/flows/documents/abc.json`). Logs use `.jsonl` files
 * through `append` and `tail`.
 */
export class Storage extends Service {
  static Config = z.object({
    dir: z.string().default('data').meta(field('Data directory', 'Relative to the instance directory', {
      'zh-CN': { title: '数据目录', description: '相对于实例目录' },
    })),
    logs: z.string().default('logs').meta(field('Log directory', 'Relative to the instance directory; safe to delete', {
      'zh-CN': { title: '日志目录', description: '相对于实例目录，可以随时删除' },
    })),
    cache: z.string().default('cache').meta(field('Cache directory', 'Relative to the instance directory; safe to delete', {
      'zh-CN': { title: '缓存目录', description: '相对于实例目录，可以随时删除' },
    })),
  })

  /** The data directory: the one folder to back up. */
  readonly dir: string
  readonly dirs: LayoutDirs
  /** The instance's `.env` file, where secrets live. Documents hold `${NAME}` references to them. */
  readonly secrets: EnvFile
  private readonly baseDir: string

  constructor(ctx: Context, config: z.infer<typeof Storage.Config>) {
    super(ctx, 'storage')
    this.baseDir = ctx.baseDir ?? process.cwd()
    this.dirs = resolveDirs(this.baseDir, config)
    this.dir = this.dirs.data
    this.secrets = new EnvFile(join(this.baseDir, '.env')).loadSync()
  }

  private file(key: string, ext: '.json' | '.jsonl') {
    return this.path(key) + ext
  }

  /** Absolute path of a key without extension; also the folder for files a plugin keeps under that key. */
  path(key: string) {
    if (!keyPattern.test(key) || key.split('/').includes('..')) {
      throw new Error(`invalid storage key "${key}"`)
    }
    return pathOf(this.dirs, key)
  }

  /** Names directly under a key prefix, documents or folders, such as the bots under `messages`. */
  children(prefix: string) {
    return childrenOf(this.dirs, prefix)
  }

  async get<T>(key: string): Promise<T | undefined> {
    return readJson<T>(this.file(key, '.json'))
  }

  async set(key: string, value: unknown) {
    return writeJsonAtomic(this.file(key, '.json'), value)
  }

  async delete(key: string) {
    await rm(this.file(key, '.json'), { force: true })
  }

  /** Keys of the JSON documents directly under a prefix, such as `agent`. */
  async list(prefix: string) {
    const dir = dirname(this.path(`${prefix}/_`))
    const names = await readdir(dir).catch(() => [] as string[])
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => `${prefix}/${name.slice(0, -'.json'.length)}`)
      .sort()
  }

  /** Appends one JSON line to `<key>.jsonl`. */
  async append(key: string, value: unknown) {
    const file = this.file(key, '.jsonl')
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify(value) + '\n', 'utf8')
  }

  /** The last `limit` entries of `<key>.jsonl`, oldest first. */
  async tail<T>(key: string, limit: number): Promise<T[]> {
    let text: string
    try {
      text = await readFile(this.file(key, '.jsonl'), 'utf8')
    } catch (error: any) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const lines = text.split('\n').filter(Boolean)
    return lines.slice(-limit).flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
  }

  /** Path of a storage key relative to the instance directory, for display. */
  describe(key: string) {
    return relative(this.baseDir, this.file(key, '.json')).split(sep).join('/')
  }
}

/** The data, log and cache directories of an instance, from the storage plugin's config. */
export function resolveDirs(baseDir: string, config: { dir?: string; logs?: string; cache?: string } = {}): LayoutDirs {
  return {
    data: resolve(baseDir, config.dir ?? 'data'),
    logs: resolve(baseDir, config.logs ?? 'logs'),
    cache: resolve(baseDir, config.cache ?? 'cache'),
  }
}

export default Storage
