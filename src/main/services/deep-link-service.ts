/**
 * hive:// deep link handling. Currently the only route is
 * `hive://share-account?...` (see account-share-service.ts).
 *
 * `open-url` can fire before the app (and the local backend) is ready, so
 * links are queued until index.ts calls `markDeepLinksReady()`.
 */
import { app, Notification } from 'electron'
import { resolve } from 'path'
import {
  importAccountShareFromLink,
  isShareAccountLink
} from './account-share-service'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import { SHARED_ACCOUNT_IMPORTED_CHANNEL } from '../../shared/app-events'
import { createLogger } from './logger'

const log = createLogger({ component: 'DeepLinkService' })

let ready = false
const pendingUrls: string[] = []

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
export function markDeepLinksReady(): void {
  ready = true
  const queued = pendingUrls.splice(0, pendingUrls.length)
  for (const url of queued) {
    void handleDeepLink(url)
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

async function handleDeepLink(url: string): Promise<void> {
  if (!isShareAccountLink(url)) {
    log.warn('Ignoring unrecognized deep link', { url: url.slice(0, 64) })
    return
  }

  log.info('Handling account share deep link')
  try {
    const result = await importAccountShareFromLink(url)
    const providerLabel = result.provider === 'anthropic' ? 'Claude' : 'OpenAI'
    notify('Account imported', `${result.email} (${providerLabel}) was added to Hive.`)
    void publishDesktopBackendEvent(SHARED_ACCOUNT_IMPORTED_CHANNEL, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      'Failed to import shared account from deep link',
      error instanceof Error ? error : new Error(message)
    )
    notify('Account import failed', message)
  }
}
