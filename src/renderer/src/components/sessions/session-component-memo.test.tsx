import { describe, expect, it } from 'vitest'
import { AttachmentButton } from './AttachmentButton'
import { AttachmentPreview } from './AttachmentPreview'
import { CodexFastToggle } from './CodexFastToggle'
import { ContextIndicator } from './ContextIndicator'
import { DiffCommentAttachments } from './DiffCommentAttachments'
import { ModeToggle } from './ModeToggle'
import { ModelSelector } from './ModelSelector'
import { SuperToggle } from './SuperToggle'
import { TicketAttachments } from './TicketAttachments'

function expectReactMemoComponent(component: unknown): void {
  expect(component).toEqual(
    expect.objectContaining({
      $$typeof: Symbol.for('react.memo')
    })
  )
}

describe('session composer render boundaries', () => {
  it('exports stable memoized leaf components used by the composer chrome', () => {
    ;[
      ModeToggle,
      SuperToggle,
      AttachmentButton,
      AttachmentPreview,
      TicketAttachments,
      CodexFastToggle,
      ContextIndicator,
      DiffCommentAttachments,
      ModelSelector
    ].forEach(expectReactMemoComponent)
  })
})
