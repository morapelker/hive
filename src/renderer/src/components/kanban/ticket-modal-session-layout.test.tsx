import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  TICKET_SESSION_DIALOG_CLASS,
  readTicketModalTerminalGeometry
} from './ticket-modal-session-layout'

function renderDialog(className?: string): string[] {
  render(
    <Dialog open>
      <DialogContent className={className}>
        <DialogTitle>Ticket</DialogTitle>
        <DialogDescription>Layout test</DialogDescription>
      </DialogContent>
    </Dialog>
  )
  return screen.getByRole('dialog').className.split(/\s+/)
}

describe('ticket modal session layout', () => {
  // The terminal is only pixel-sharp on 1x screens when no translate is left on
  // the dialog. This guards the class merge itself: a tailwind-merge upgrade or
  // an edit to DialogContent's base classes must not bring the transform back.
  test('replaces the transform centering of DialogContent with layout centering', () => {
    const classes = renderDialog(TICKET_SESSION_DIALOG_CLASS)

    expect(classes).not.toContain('translate-x-[-50%]')
    expect(classes).not.toContain('translate-y-[-50%]')
    expect(classes).not.toContain('left-[50%]')
    expect(classes).not.toContain('top-[50%]')
    expect(classes.filter((c) => c.startsWith('translate-'))).toEqual([
      'translate-x-0',
      'translate-y-0'
    ])
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'inset-0', 'm-auto']))
  })

  test('keeps an explicit width and height (inset-0 would stretch an auto-sized dialog)', () => {
    const classes = renderDialog(TICKET_SESSION_DIALOG_CLASS)

    expect(classes).toEqual(expect.arrayContaining(['w-[96vw]', 'max-w-[1920px]', 'h-[90vh]']))
    expect(classes).not.toContain('w-full')
    expect(classes).not.toContain('max-w-lg')
  })

  test('leaves every other dialog on the default centering', () => {
    const classes = renderDialog('sm:max-w-lg')

    expect(classes).toEqual(
      expect.arrayContaining([
        'left-[50%]',
        'top-[50%]',
        'translate-x-[-50%]',
        'translate-y-[-50%]'
      ])
    )
    expect(classes).not.toContain('inset-0')
    expect(classes).not.toContain('m-auto')
  })
})

describe('readTicketModalTerminalGeometry', () => {
  function mountSlot(terminalHtml: string, dialogStyle = ''): HTMLElement {
    document.body.innerHTML = `<div role="dialog" style="${dialogStyle}"><div id="slot">${terminalHtml}</div></div>`
    return document.getElementById('slot') as HTMLElement
  }

  test('reports the screen scale and viewport', () => {
    const geometry = readTicketModalTerminalGeometry(mountSlot(''))

    expect(geometry.devicePixelRatio).toBe(window.devicePixelRatio)
    expect(geometry.viewport).toEqual([window.innerWidth, window.innerHeight])
  })

  test('distinguishes no terminal, the DOM renderer and the WebGL renderer', () => {
    expect(readTicketModalTerminalGeometry(mountSlot('')).renderer).toBe('none')
    expect(
      readTicketModalTerminalGeometry(
        mountSlot(
          '<div class="xterm"><div class="xterm-screen"><div class="xterm-rows"></div></div></div>'
        )
      ).renderer
    ).toBe('dom')
    expect(
      readTicketModalTerminalGeometry(
        mountSlot('<div class="xterm"><div class="xterm-screen"><canvas></canvas></div></div>')
      ).renderer
    ).toBe('webgl')
  })

  test('reports a transform left on the dialog', () => {
    const geometry = readTicketModalTerminalGeometry(
      mountSlot('', 'transform: translate(-10.5px, 0px)')
    )

    expect(geometry.dialogTransform).toBe('translate(-10.5px, 0px)')
  })

  test('does not throw when the slot is outside a dialog', () => {
    const slot = document.createElement('div')

    expect(readTicketModalTerminalGeometry(slot)).toMatchObject({
      renderer: 'none',
      dialogTranslate: null,
      dialogTransform: null
    })
  })
})
