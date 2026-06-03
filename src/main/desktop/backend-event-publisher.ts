import { makeDesktopBackendEventMessage } from '../../shared/desktop-command'
import type { StartedDesktopBackend } from './backend-manager'

interface DesktopBackendAuthSession {
  readonly accessToken: string
}

let currentBackend: StartedDesktopBackend | null = null
let desktopBackendAuthSessionPromise: Promise<DesktopBackendAuthSession> | null = null

export const getCurrentBackend = (): StartedDesktopBackend | null => currentBackend

export const setCurrentBackend = (backend: StartedDesktopBackend | null): void => {
  currentBackend = backend
  if (!backend) desktopBackendAuthSessionPromise = null
}

export const publishDesktopBackendEvent = async (
  channel: string,
  payload: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> => {
  const backend = getCurrentBackend()
  if (!backend) return false

  // Fast path: push the event over the existing Node IPC channel to the server
  // child, which forwards it into its event bus. This avoids a loopback HTTP
  // POST per flush - important for high-frequency channels like terminal output.
  // High volume is already bounded upstream by setImmediate coalescing.
  const child = backend.getChild()
  if (child?.connected && typeof child.send === 'function') {
    return new Promise<boolean>((resolve) => {
      child.send(makeDesktopBackendEventMessage(channel, payload), (error) => {
        resolve(!error)
      })
    })
  }

  // Fallback (e.g. a remote backend with no IPC channel): publish over HTTP.
  try {
    const session = await getDesktopBackendAuthSession(backend, fetchImpl)
    const response = await fetchImpl(`${backend.bootstrap.httpBaseUrl}/api/events/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessToken}`
      },
      body: JSON.stringify({ channel, payload })
    })
    if (response.status === 401) desktopBackendAuthSessionPromise = null
    return response.ok
  } catch {
    return false
  }
}

const getDesktopBackendAuthSession = (
  backend: StartedDesktopBackend,
  fetchImpl: typeof fetch
): Promise<DesktopBackendAuthSession> => {
  desktopBackendAuthSessionPromise ??= fetchImpl(`${backend.bootstrap.httpBaseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: backend.bootstrap.bootstrapToken })
  }).then(async (response) => {
    if (!response.ok) {
      desktopBackendAuthSessionPromise = null
      throw new Error('Failed to authenticate desktop backend session')
    }

    const body = (await response.json()) as { readonly session?: DesktopBackendAuthSession }
    if (!body.session?.accessToken) {
      desktopBackendAuthSessionPromise = null
      throw new Error('Invalid desktop backend auth response')
    }
    return body.session
  })
  return desktopBackendAuthSessionPromise
}
