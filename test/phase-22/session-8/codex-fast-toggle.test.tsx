import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { CodexFastToggle } from '../../../src/renderer/src/components/sessions/CodexFastToggle'

describe('CodexFastToggle', () => {
  it('renders a toggleable Fast pill', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()

    render(<CodexFastToggle enabled={false} onToggle={onToggle} />)

    const toggle = screen.getByTestId('codex-fast-toggle')
    expect(toggle).toHaveTextContent('Fast')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await user.click(toggle)

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('SessionView places the Fast toggle between the model selector and attachment button', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/components/sessions/SessionView.tsx'),
      'utf8'
    )

    const modelIndex = source.indexOf('<ModelSelector sessionId={sessionId} />')
    const fastIndex = source.indexOf('<CodexFastToggle')
    const attachmentIndex = source.indexOf('<AttachmentButton onAttach={handleAttach} />')

    expect(modelIndex).toBeGreaterThan(-1)
    expect(fastIndex).toBeGreaterThan(modelIndex)
    expect(attachmentIndex).toBeGreaterThan(fastIndex)
  })
})
