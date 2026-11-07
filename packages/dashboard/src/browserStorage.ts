/**
 * Reading and changing what the dashboard keeps in this browser: localStorage, sessionStorage and
 * IndexedDB. The database page shows these next to the server's tables.
 */

export type WebStorageKind = 'local' | 'session'

export interface WebStorageItem {
  key: string
  value: string
}

function webStorage(kind: WebStorageKind) {
  return kind === 'local' ? window.localStorage : window.sessionStorage
}

export function listWebStorage(kind: WebStorageKind): WebStorageItem[] {
  const storage = webStorage(kind)
  const items: WebStorageItem[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key !== null) items.push({ key, value: storage.getItem(key) ?? '' })
  }
  return items.sort((a, b) => a.key.localeCompare(b.key))
}

export function setWebStorage(kind: WebStorageKind, key: string, value: string) {
  webStorage(kind).setItem(key, value)
}

export function removeWebStorage(kind: WebStorageKind, key: string) {
  webStorage(kind).removeItem(key)
}

export function clearWebStorage(kind: WebStorageKind) {
  webStorage(kind).clear()
}

/** Characters of keys and values, times two as browsers count UTF-16. */
export function webStorageSize(items: WebStorageItem[]) {
  return items.reduce((sum, item) => sum + (item.key.length + item.value.length) * 2, 0)
}

// ---- IndexedDB ----

export interface IdbStoreInfo {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  count: number
}

export interface IdbDatabaseInfo {
  name: string
  version: number
  stores: IdbStoreInfo[]
}

export interface IdbRecord {
  key: IDBValidKey
  value: unknown
}

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Opens a database at its current version, never creating or upgrading it. */
function open(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name)
    let created = false
    req.onupgradeneeded = (event) => {
      // Opening a name that no longer exists would create it; undo that.
      if (event.oldVersion === 0) {
        created = true
        req.transaction?.abort()
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(created ? new Error(`IndexedDB "${name}" does not exist`) : req.error)
    req.onblocked = () => reject(new Error(`IndexedDB "${name}" is blocked by another tab`))
  })
}

async function withStore<T>(db: string, store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>) {
  const conn = await open(db)
  try {
    const tx = conn.transaction(store, mode)
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'))
    })
    const result = await run(tx.objectStore(store))
    await done
    return result
  } finally {
    conn.close()
  }
}

export const idbSupported = () => typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function'

export async function listIdb(): Promise<IdbDatabaseInfo[]> {
  if (!idbSupported()) return []
  const found = await indexedDB.databases()
  const result: IdbDatabaseInfo[] = []
  for (const item of found) {
    if (!item.name) continue
    const conn = await open(item.name).catch(() => undefined)
    if (!conn) continue
    try {
      const names = [...conn.objectStoreNames]
      const stores: IdbStoreInfo[] = []
      if (names.length) {
        const tx = conn.transaction(names, 'readonly')
        for (const name of names) {
          const store = tx.objectStore(name)
          stores.push({ name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, count: await request(store.count()) })
        }
      }
      result.push({ name: conn.name, version: conn.version, stores })
    } finally {
      conn.close()
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** One page of a store's records, in key order. */
export function readIdb(db: string, store: string, offset: number, limit: number) {
  return withStore(db, store, 'readonly', (os) => new Promise<IdbRecord[]>((resolve, reject) => {
    const records: IdbRecord[] = []
    const req = os.openCursor()
    let skipped = offset === 0
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return resolve(records)
      if (!skipped) {
        skipped = true
        cursor.advance(offset)
        return
      }
      records.push({ key: cursor.primaryKey, value: cursor.value })
      if (records.length >= limit) resolve(records)
      else cursor.continue()
    }
  }))
}

/** Writes a record. `key` is used only for stores whose keys live outside the value. */
export function putIdb(db: string, store: string, value: unknown, key?: IDBValidKey) {
  return withStore(db, store, 'readwrite', (os) => request(os.keyPath === null ? os.put(value, key) : os.put(value)))
}

export function removeIdb(db: string, store: string, key: IDBValidKey) {
  return withStore(db, store, 'readwrite', (os) => request(os.delete(key)))
}

export function clearIdb(db: string, store: string) {
  return withStore(db, store, 'readwrite', (os) => request(os.clear()))
}

export function deleteIdb(db: string) {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(db)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error(`IndexedDB "${db}" is open in another tab`))
  })
}

// ---- showing and editing values as JSON ----

/** Whether a value comes back unchanged from JSON, so it can be edited as text. */
export function jsonSafe(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonSafe)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value as object).every(jsonSafe)
  return false
}

/** A short label for values JSON cannot hold, such as Date, Blob or Map. */
export function describe(value: unknown): string {
  if (value instanceof Date) return `Date(${value.toISOString()})`
  if (value instanceof Blob) return `${value.constructor.name}(${value.size} B${value.type ? `, ${value.type}` : ''})`
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength} B)`
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength} B)`
  if (value instanceof Map) return `Map(${value.size})`
  if (value instanceof Set) return `Set(${value.size})`
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(labelled(value))
  } catch {
    return String(value)
  }
}

/** The value with whatever JSON cannot hold swapped for its label, so it can be shown. */
function labelled(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(labelled)
  if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) return describe(value)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, labelled(item)]))
  }
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value)) || typeof value === 'bigint') return String(value)
  return value
}

export function keyText(key: IDBValidKey) {
  return typeof key === 'string' ? key : describe(key)
}
