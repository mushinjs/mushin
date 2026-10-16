import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '@mushin/core'

/**
 * The admin token, stored in plain text next to the provider keys it protects, so it can be
 * shown again on every start. Anyone who can read the data directory already holds those keys.
 */
export interface AuthRecord {
  token: string
  createdAt: number
}

/** Storage key of the auth record: `data/auth.json`. */
export const AUTH_KEY = 'auth'

export function generateToken() {
  return randomBytes(24).toString('base64url')
}

/** Older builds stored only a hash, which cannot be shown again; those records are replaced. */
export function isAuthRecord(value: unknown): value is AuthRecord {
  return typeof (value as AuthRecord | undefined)?.token === 'string' && (value as AuthRecord).token.length >= 16
}

export function tokensEqual(supplied: string | null | undefined, expected: string | undefined) {
  if (!supplied || !expected) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Replaces the admin token in a data directory and returns it. A running instance picks it up on the next sign-in. */
export async function resetAdminToken(dataDir: string) {
  const token = generateToken()
  await writeJsonAtomic(join(dataDir, `${AUTH_KEY}.json`), { token, createdAt: Date.now() } satisfies AuthRecord)
  return token
}

export async function readAdminToken(dataDir: string) {
  const record = await readJson<unknown>(join(dataDir, `${AUTH_KEY}.json`))
  return isAuthRecord(record) ? record.token : undefined
}
