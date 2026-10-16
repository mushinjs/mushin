import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Context, field, readJson, Service, writeJsonAtomic, z } from '@mushin/core'

declare module '@mushin/core' {
  interface Context {
    storage: Storage
  }
}

const keyPattern = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/

/**
 * JSON documents under the data directory. A key such as `agent/abc` maps to `data/agent/abc.json`;
 * logs use `.jsonl` files through `append` and `tail`.
 */
export class Storage extends Service {
  static Config = z.object({
    dir: z.string().default('data').meta(field('Data directory', 'Relative to the instance directory', {
      'zh-CN': { title: '数据目录', description: '相对于实例目录' },
    })),
  })

  readonly dir: string

  constructor(ctx: Context, config: z.infer<typeof Storage.Config>) {
    super(ctx, 'storage')
    this.dir = resolve(ctx.baseDir ?? process.cwd(), config.dir)
  }

  private file(key: string, ext: '.json' | '.jsonl') {
    if (!keyPattern.test(key) || key.split('/').includes('..')) {
      throw new Error(`invalid storage key "${key}"`)
    }
    return join(this.dir, ...key.split('/')) + ext
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
    const dir = join(this.dir, ...prefix.split('/'))
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

  /** Path of a storage key relative to the data directory, for display. */
  describe(key: string) {
    return relative(this.dir, this.file(key, '.json')).split(sep).join('/')
  }
}

export default Storage
