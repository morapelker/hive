import { randomBytes } from 'node:crypto'

export interface AuthSession {
  readonly accessToken: string
  readonly tokenType: 'Bearer'
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface WebSocketAuthToken {
  readonly token: string
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface AuthSessionManager {
  readonly createSession: () => AuthSession
  readonly getSession: (accessToken: string) => AuthSession | null
  readonly createWebSocketToken: (accessToken: string) => WebSocketAuthToken | null
  readonly getWebSocketToken: (token: string) => WebSocketAuthToken | null
}

export interface AuthSessionStatus {
  readonly authenticated: boolean
  readonly session?: AuthSession
}

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000
const DEFAULT_WS_TOKEN_TTL_MS = 60 * 1000

export const makeAuthSessionManager = (
  now: () => Date = () => new Date(),
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  webSocketTokenTtlMs = DEFAULT_WS_TOKEN_TTL_MS
): AuthSessionManager => {
  const sessions = new Map<string, AuthSession>()
  const webSocketTokens = new Map<string, WebSocketAuthToken>()

  return {
    createSession: () => {
      const issuedAtDate = now()
      const expiresAtDate = new Date(issuedAtDate.getTime() + sessionTtlMs)
      const session = {
        accessToken: randomBytes(32).toString('base64url'),
        tokenType: 'Bearer' as const,
        issuedAt: issuedAtDate.toISOString(),
        expiresAt: expiresAtDate.toISOString()
      }
      sessions.set(session.accessToken, session)
      return session
    },
    getSession: (accessToken) => {
      const session = sessions.get(accessToken)
      if (!session) return null

      if (Date.parse(session.expiresAt) <= now().getTime()) {
        sessions.delete(accessToken)
        return null
      }

      return session
    },
    createWebSocketToken: (accessToken) => {
      const session = sessions.get(accessToken)
      if (!session) return null

      const issuedAtDate = now()
      if (Date.parse(session.expiresAt) <= issuedAtDate.getTime()) {
        sessions.delete(accessToken)
        return null
      }

      const token = {
        token: randomBytes(32).toString('base64url'),
        issuedAt: issuedAtDate.toISOString(),
        expiresAt: new Date(issuedAtDate.getTime() + webSocketTokenTtlMs).toISOString()
      }
      webSocketTokens.set(token.token, token)
      return token
    },
    getWebSocketToken: (tokenValue) => {
      const token = webSocketTokens.get(tokenValue)
      if (!token) return null

      if (Date.parse(token.expiresAt) <= now().getTime()) {
        webSocketTokens.delete(tokenValue)
        return null
      }

      return token
    }
  }
}

export const getBearerToken = (authorization: string | undefined): string | null => {
  if (!authorization) return null
  const [scheme, token, ...extra] = authorization.trim().split(/\s+/)
  if (scheme !== 'Bearer' || !token || extra.length > 0) return null
  return token
}

export const getAuthSessionStatus = (
  authorization: string | undefined,
  sessions: AuthSessionManager
): AuthSessionStatus => {
  const token = getBearerToken(authorization)
  if (!token) return { authenticated: false }

  const session = sessions.getSession(token)
  return session ? { authenticated: true, session } : { authenticated: false }
}
