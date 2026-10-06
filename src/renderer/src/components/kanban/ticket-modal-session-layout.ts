/**
 * Layout for the ticket modal's session layouts — the two variants that host a
 * live terminal (full-width session, and ticket + session dual pane).
 *
 * Why this is not just a size: the shared DialogContent centers itself with
 * `left-[50%] top-[50%]` plus a -50% translate. This modal is sized in viewport
 * units, so that translate is a fractional number of pixels at almost every
 * window size. Chromium snaps laid-out boxes to device pixels but never snaps
 * transforms, so the terminal's WebGL canvas ended up between pixels and was
 * resampled — visibly blurry text on low-density (1x) screens, while the very
 * same terminal rendered in a tab was sharp.
 *
 * Centering with `inset-0 m-auto` produces the identical footprint through
 * layout alone, which the engine pixel-snaps at every device scale factor.
 *
 * Constraints to keep when editing:
 * - The translate must be reset with `translate-x-0 translate-y-0`.
 *   tailwind-merge only drops DialogContent's `translate-x-[-50%]` /
 *   `translate-y-[-50%]` for a class from the same group; `translate-none`
 *   would leave both in place and the result would depend on stylesheet order.
 * - Width AND height must stay explicit. With `inset-0`, an auto-height dialog
 *   stretches to the full viewport instead of hugging its content (this is why
 *   the content-sized ticket layouts keep the default centering).
 * - dialog.tsx also lists tailwindcss-animate slide classes that assume the
 *   translate centering. That plugin is not loaded, so they emit no CSS today;
 *   if it is ever enabled, this layout needs its own enter/exit classes.
 */
export const TICKET_SESSION_DIALOG_CLASS =
  'w-[96vw] max-w-[1920px] h-[90vh] p-0 gap-0 overflow-hidden flex flex-col inset-0 m-auto translate-x-0 translate-y-0'

export interface TicketModalTerminalGeometry {
  devicePixelRatio: number
  viewport: [number, number]
  /** 'none' when no xterm terminal is mounted in the slot (yet) */
  renderer: 'webgl' | 'dom' | 'none'
  /** Computed `translate` / `transform` of the dialog; anything but a zero/none value means the terminal is not pixel-snapped */
  dialogTranslate: string | null
  dialogTransform: string | null
}

/**
 * Raw facts for the support log about how the modal-hosted terminal is placed
 * on screen. Deliberately reports computed styles rather than a measured
 * offset: getBoundingClientRect returns pre-snapping layout coordinates, so it
 * reads fractional even when the pixels on screen are perfectly aligned.
 */
export function readTicketModalTerminalGeometry(slot: HTMLElement): TicketModalTerminalGeometry {
  const dialog = slot.closest<HTMLElement>('[role="dialog"]')
  const style = dialog ? getComputedStyle(dialog) : null
  const xterm = slot.querySelector('.xterm')
  return {
    devicePixelRatio: window.devicePixelRatio,
    viewport: [window.innerWidth, window.innerHeight],
    renderer: !xterm ? 'none' : xterm.querySelector('canvas') ? 'webgl' : 'dom',
    dialogTranslate: style?.translate || null,
    dialogTransform: style?.transform || null
  }
}
