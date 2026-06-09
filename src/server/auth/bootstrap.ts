import { timingSafeEqual } from 'node:crypto'
import { Effect } from 'effect'
import { z } from 'zod'
import type { AuthSession, AuthSessionManager } from './session'

export interface AuthBootstrapResponse {
  readonly session: AuthSession
}

export interface AuthBootstrapFailure {
  readonly statusCode: 400 | 401
  readonly body: {
    readonly error: string
  }
}

const authBootstrapRequestSchema = z
  .object({
    bootstrapToken: z.string().min(1)
  })
  .strict()

export const exchangeDesktopBootstrapToken = (
  body: unknown,
  desktopBootstrapToken: string | null,
  sessions: AuthSessionManager
): Effect.Effect<AuthBootstrapResponse, AuthBootstrapFailure> =>
  Effect.gen(function* () {
    const parsed = authBootstrapRequestSchema.safeParse(body)
    if (!parsed.success) {
      return yield* Effect.fail({
        statusCode: 400 as const,
        body: { error: 'Invalid bootstrap request' }
      })
    }

    if (
      !desktopBootstrapToken ||
      !constantTimeEqual(parsed.data.bootstrapToken, desktopBootstrapToken)
    ) {
      return yield* Effect.fail({
        statusCode: 401 as const,
        body: { error: 'Unauthorized' }
      })
    }

    return {
      session: sessions.createSession()
    }
  })

const constantTimeEqual = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  )
}
