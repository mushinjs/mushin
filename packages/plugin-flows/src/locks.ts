import { FlowError } from './engine'

/** Runs that may wait for one resource at a time; more fail at once. */
export const MAX_QUEUE = 20
/** The longest a run waits for a resource. */
export const QUEUE_WAIT = 6 * 3_600_000

interface Waiting {
  owner: string
  grant(): void
}

/**
 * Resources nodes use one run at a time, such as a game client a tool drives. A run holds a
 * resource until it releases everything it holds (when it ends); runs waiting for it get it in order.
 */
export class ResourceLocks {
  private holders = new Map<string, string>()
  private queues = new Map<string, Waiting[]>()

  /** Who holds the resource now. */
  holder(name: string) {
    return this.holders.get(name)
  }

  /** Runs waiting for the resource, in order. */
  waiting(name: string) {
    return (this.queues.get(name) ?? []).map((item) => item.owner)
  }

  /**
   * Resolves once `owner` holds the resource; at once when it is free or already held by `owner`.
   * `onQueue` is told when the owner starts and stops waiting. Rejects when stopped, when it waits
   * too long, or when too many runs wait already.
   */
  acquire(name: string, owner: string, options: { signal?: AbortSignal; onQueue?(waiting: boolean): void; wait?: number } = {}) {
    const holder = this.holders.get(name)
    if (holder === undefined || holder === owner) {
      this.holders.set(name, owner)
      return Promise.resolve()
    }
    const queue = this.queues.get(name) ?? []
    if (queue.length >= MAX_QUEUE) return Promise.reject(new FlowError(`"${name}" is busy and ${MAX_QUEUE} runs already wait for it`))
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    return new Promise<void>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        const list = this.queues.get(name) ?? []
        const index = list.indexOf(entry)
        if (index >= 0) list.splice(index, 1)
        if (!list.length) this.queues.delete(name)
        options.onQueue?.(false)
      }
      const entry: Waiting = {
        owner,
        grant: () => {
          leave()
          resolve()
        },
      }
      const abort = () => {
        leave()
        reject(options.signal!.reason)
      }
      const minutes = Math.round((options.wait ?? QUEUE_WAIT) / 60_000)
      const timer = setTimeout(() => {
        leave()
        reject(new FlowError(`Waited ${minutes} minutes for "${name}" and gave up`))
      }, options.wait ?? QUEUE_WAIT)
      options.signal?.addEventListener('abort', abort, { once: true })
      queue.push(entry)
      this.queues.set(name, queue)
      options.onQueue?.(true)
    })
  }

  /** Lets go of every resource `owner` holds, handing each to the next run waiting for it. */
  releaseAll(owner: string) {
    for (const [name, holder] of [...this.holders]) {
      if (holder !== owner) continue
      const next = this.queues.get(name)?.[0]
      if (next) {
        this.holders.set(name, next.owner)
        next.grant()
      } else {
        this.holders.delete(name)
      }
    }
  }
}
