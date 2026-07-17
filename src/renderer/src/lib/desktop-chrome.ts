import { computedColorToHex, resolveCssColor } from '@/lib/css-color'
import { isWindows } from '@/lib/platform'

const TRANSPARENT_TITLE_BAR_OVERLAY = '#00000000'

const HEADER_SELECTOR = '[data-testid="header"]'

export function syncTitleBarOverlay(): void {
  if (!isWindows()) return
  const bridge = window.desktopBridge
  if (typeof bridge?.setTitleBarOverlay !== 'function') return

  const header = document.querySelector(HEADER_SELECTOR)
  const symbolColor = computedColorToHex(header, resolveCssColor('--foreground', '#fafafa'))

  void bridge.setTitleBarOverlay({ color: TRANSPARENT_TITLE_BAR_OVERLAY, symbolColor })
}

/** Defer until after CSS/class updates have painted. */
export function scheduleTitleBarOverlaySync(): void {
  if (!isWindows()) return
  requestAnimationFrame(() => {
    syncTitleBarOverlay()
    requestAnimationFrame(syncTitleBarOverlay)
  })
}

/** Padding so header actions stay left of native caption buttons. */
export const windowsCaptionPaddingRight =
  'max(0px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))'
