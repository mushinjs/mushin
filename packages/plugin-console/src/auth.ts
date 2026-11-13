import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { EnvFile } from '@mushinjs/core'

/**
 * The admin token lives in the instance's `.env` as `MUSHIN_ADMIN_TOKEN`, next to the keys it protects,
 * so it can be shown again on every start. Set in the shell instead, it overrides the file and stays fixed.
 */
export const ADMIN_TOKEN_ENV = 'MUSHIN_ADMIN_TOKEN'

/** What older versions stored in `data/core/auth.json` (before that, `data/auth.json`). */
export interface AuthRecord {
  token: string
  createdAt: number
}

/** Storage key of the auth record of older versions. */
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

/** Replaces the admin token in an instance's `.env` and returns it. A running instance picks it up on the next sign-in. */
export async function resetAdminToken(baseDir: string) {
  const token = generateToken()
  await new EnvFile(join(baseDir, '.env')).set(ADMIN_TOKEN_ENV, token)
  return token
}

/** The admin token in an instance's `.env`, if there is one. */
export function readAdminToken(baseDir: string) {
  return new EnvFile(join(baseDir, '.env')).loadSync().get(ADMIN_TOKEN_ENV) || undefined
}
