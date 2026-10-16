export type ErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'forbidden'
  | 'unauthorized'
  | 'unavailable'
  | 'failed'

const statusCodes: Record<ErrorCode, number> = {
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  forbidden: 403,
  unauthorized: 401,
  unavailable: 503,
  failed: 500,
}

/** An error whose message is safe to show to users and to the Agent. */
export class MushinError extends Error {
  name = 'MushinError'

  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message)
  }

  get status() {
    return statusCodes[this.code]
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export function toErrorPayload(error: unknown) {
  if (error instanceof MushinError) return error.toJSON()
  if (error instanceof Error) return { code: 'failed' as const, message: error.message }
  return { code: 'failed' as const, message: String(error) }
}
