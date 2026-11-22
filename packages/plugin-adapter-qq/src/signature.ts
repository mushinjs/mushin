import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto'

/** The DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/**
 * QQ signs webhook requests with Ed25519. The key's seed is the AppSecret, repeated until it is
 * 32 bytes long and cut there.
 */
export function webhookKey(secret: string): KeyObject {
  if (!secret) throw new Error('the AppSecret is required to sign webhook answers')
  let seed = secret
  while (seed.length < 32) seed += secret
  const bytes = Buffer.from(seed, 'utf8').subarray(0, 32)
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, bytes]), format: 'der', type: 'pkcs8' })
}

/** Answers QQ's callback address check (op 13): the hex signature of `event_ts + plain_token`. */
export function signChallenge(key: KeyObject, eventTs: string, plainToken: string) {
  return sign(null, Buffer.from(eventTs + plainToken), key).toString('hex')
}

/** Checks `X-Signature-Ed25519` against `X-Signature-Timestamp` and the raw body. */
export function verifyRequest(key: KeyObject, timestamp: string | null, body: string, signature: string | null) {
  if (!timestamp || !signature || !/^[0-9a-f]{128}$/i.test(signature)) return false
  try {
    return verify(null, Buffer.from(timestamp + body), createPublicKey(key), Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
}
