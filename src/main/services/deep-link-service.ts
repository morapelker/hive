/**
 * hive:// deep link handling. Routes:
 * - `hive://share-account?...` (see account-share-service.ts)
 * - `hive://worktree/<id>` and `hive://connection/<id>` focus Hive on that item
 * - `hive://connection/new?projects=...` picks projects in the switcher (Enter connects them)
 *   (see shared/deep-link-events.ts)
 *
 * `open-url` can fire before the app (and the local backend) is ready, so
 * links are queued until index.ts calls `markDeepLinksReady()`.
 */
import { app, Notification, type BrowserWindow } from 'electron'
import { resolve } from 'path'
import { randomUUID } from 'crypto'
import { importAccountShareFromLink, isShareAccountLink } from './account-share-service'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import { SHARED_ACCOUNT_IMPORTED_CHANNEL } from '../../shared/app-events'
import {
  DEEP_LINK_NAVIGATE_CHANNEL,
  parseNavigateDeepLink,
  type DeepLinkNavigatePayload,
  type NavigateDeepLink
} from '../../shared/deep-link-events'
import { getDatabase } from '../db'
import { createLogger } from './logger'

const log = createLogger({ component: 'DeepLinkService' })

let ready = false
const pendingUrls: string[] = []
let getMainWindow: () => BrowserWindow | null = () => null

// A link that cold-starts Hive, or arrives in the first seconds after launch, can reach
// the renderer before it has subscribed to events, and there is no renderer-ready signal.
// Such links are re-published a few times after the page loads; selecting the same item
// again is a no-op.
const COLD_START_REPUBLISH_DELAYS_MS = [1_500, 4_000, 8_000]
const STARTUP_WINDOW_MS = 20_000
let readyAt = 0

/** Must run before app 'ready' so a cold-start open-url is not missed. */
export function registerDeepLinkHandling(): void {
  // In dev (`electron .`) the protocol must be bound to the electron binary
  // plus the app path, otherwise macOS routes hive:// to nothing.
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('hive', process.execPath, [resolve(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient('hive')
  }

  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (!ready) {
      pendingUrls.push(url)
      return
    }
    void handleDeepLink(url)
  })
}

/** Flush links that arrived before the backend was up. */
export function markDeepLinksReady(mainWindowGetter?: () => BrowserWindow | null): void {
  if (mainWindowGetter) getMainWindow = mainWindowGetter
  ready = true
  readyAt = Date.now()
  const queued = pendingUrls.splice(0, pendingUrls.length)
  for (const url of queued) {
    void handleDeepLink(url, { coldStart: true })
  }
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show()
    }
  } catch (error) {
    log.warn('Failed to show deep-link notification', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function describeLink(link: NavigateDeepLink): Record<string, unknown> {
  return link.kind === 'new-connection'
    ? { kind: link.kind, projects: link.members.map((m) => m.projectId), pull: link.pull }
    : { kind: link.kind, id: link.id }
}

function resolveNavigatePayload(link: NavigateDeepLink): DeepLinkNavigatePayload | null {
  const db = getDatabase()
  // One per link; every re-published copy carries the same one.
  const requestId = randomUUID()
  if (link.kind === 'new-connection') {
    // Only git projects can join a connection, as in the switcher.
    const allGit = link.members.every((member) => {
      const project = db.getProject(member.projectId)
      return project !== null && project.kind !== 'connection'
    })
    if (!allGit) return null
    return {
      kind: 'new-connection',
      requestId,
      members: link.members,
      ...(link.pull === undefined ? {} : { pull: link.pull })
    }
  }
  if (link.kind === 'worktree') {
    const worktree = db.getWorktree(link.id)
    if (!worktree || worktree.status !== 'active') return null
    return { kind: 'worktree', requestId, projectId: worktree.project_id, worktreeId: worktree.id }
  }
  const connection = db.getConnection(link.id)
  if (!connection || connection.status !== 'active') return null
  return { kind: 'connection', requestId, connectionId: connection.id }
}

function focusMainWindow(): BrowserWindow | null {
  const window = getMainWindow()
  if (!window || window.isDestroyed()) return null
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return window
}

async function handleNavigateDeepLink(link: NavigateDeepLink, coldStart: boolean): Promise<void> {
  const payload = resolveNavigatePayload(link)
  if (!payload) {
    log.warn('Deep link target not found', describeLink(link))
    notify(
      'Not found in Hive',
      link.kind === 'new-connection'
        ? 'One of the projects no longer exists or cannot join a connection.'
        : `That ${link.kind} no longer exists or was archived.`
    )
    focusMainWindow()
    return
  }

  log.info('Handling navigate deep link', describeLink(link))
  const window = focusMainWindow()
  const publish = (): void => {
    void publishDesktopBackendEvent(DEEP_LINK_NAVIGATE_CHANNEL, payload)
  }

  const justLaunched = Date.now() - readyAt < STARTUP_WINDOW_MS
  if (!coldStart && !justLaunched) {
    publish()
    return
  }
  if (window?.webContents.isLoading()) {
    await new Promise<void>((done) => window.webContents.once('did-finish-load', () => done()))
  }
  publish()
  for (const delay of COLD_START_REPUBLISH_DELAYS_MS) setTimeout(publish, delay)
}

async function handleDeepLink(url: string, opts: { coldStart?: boolean } = {}): Promise<void> {
  const navigateLink = parseNavigateDeepLink(url)
  if (navigateLink) {
    try {
      await handleNavigateDeepLink(navigateLink, opts.coldStart ?? false)
    } catch (error) {
      log.error(
        'Failed to handle navigate deep link',
        error instanceof Error ? error : new Error(String(error))
      )
    }
    return
  }

  if (!isShareAccountLink(url)) {
    log.warn('Ignoring unrecognized deep link', { url: url.slice(0, 64) })
    return
  }

  log.info('Handling account share deep link')
  try {
    const result = await importAccountShareFromLink(url)
    const providerLabel = result.provider === 'anthropic' ? 'Claude' : 'OpenAI'
    notify('Account imported', `${result.email} (${providerLabel}) was added to Hive.`)
    // Only provider/email — the result may also carry a rotated auth token.
    void publishDesktopBackendEvent(SHARED_ACCOUNT_IMPORTED_CHANNEL, {
      provider: result.provider,
      email: result.email
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      'Failed to import shared account from deep link',
      error instanceof Error ? error : new Error(message)
    )
    notify('Account import failed', message)
  }
}
