import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { createRef } from 'react'
import { TipTapMessageInput, type TipTapMessageInputHandle } from './TipTapMessageInput'

// jsdom layout/hit-testing stubs (elementFromPoint, Range rects) live in
// test/setup.ts so any component rendering this editor works in tests.

describe('TipTapMessageInput smoke', () => {
  it('mounts and renders the editor element', async () => {
    const ref = createRef<TipTapMessageInputHandle>()
    const { container, findByTestId } = render(
      <TipTapMessageInput
        ref={ref}
        value=""
        onChange={vi.fn()}
        onSend={vi.fn()}
        onHistoryPrev={() => false}
        onHistoryNext={() => false}
        onImagePaste={vi.fn()}
        onMentionStateChange={vi.fn()}
        placeholder="Type your message..."
        disabled={false}
      />
    )
    const el = await findByTestId('message-input')
    expect(el).toBeTruthy()
    expect(container.querySelector('.tiptap-message-input')).toBeTruthy()
  })

  it('loads markdown value and exposes getMarkdown', async () => {
    const ref = createRef<TipTapMessageInputHandle>()
    render(
      <TipTapMessageInput
        ref={ref}
        value={'# Hello\n\n**bold**'}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onHistoryPrev={() => false}
        onHistoryNext={() => false}
        onImagePaste={vi.fn()}
        onMentionStateChange={vi.fn()}
        placeholder="x"
        disabled={false}
      />
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(ref.current?.getMarkdown()).toContain('Hello')
  })
})
