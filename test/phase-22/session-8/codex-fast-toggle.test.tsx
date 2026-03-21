import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { CodexFastToggle } from '../../../src/renderer/src/components/sessions/CodexFastToggle'

describe('CodexFastToggle', () => {
  it('renders a toggleable Fast pill', () => {
    render(
      <CodexFastToggle
        enabled={false}
        accepted={true}
        onToggle={vi.fn()}
        onAccept={vi.fn()}
      />
    )

    const toggle = screen.getByTestId('codex-fast-toggle')
    expect(toggle).toHaveTextContent('Fast')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggles directly when already accepted', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()

    render(
      <CodexFastToggle
        enabled={false}
        accepted={true}
        onToggle={onToggle}
        onAccept={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('codex-fast-toggle'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('shows confirmation dialog when enabling and not yet accepted', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const onAccept = vi.fn()

    render(
      <CodexFastToggle
        enabled={false}
        accepted={false}
        onToggle={onToggle}
        onAccept={onAccept}
      />
    )

    await user.click(screen.getByTestId('codex-fast-toggle'))

    // Dialog should appear, toggle should NOT have fired
    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByText('Fast Mode')).toBeInTheDocument()
    expect(
      screen.getByText('Fast mode consumes 2X the usage from your plan.')
    ).toBeInTheDocument()
  })

  it('activates fast mode when user accepts the dialog', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const onAccept = vi.fn()

    render(
      <CodexFastToggle
        enabled={false}
        accepted={false}
        onToggle={onToggle}
        onAccept={onAccept}
      />
    )

    await user.click(screen.getByTestId('codex-fast-toggle'))
    await user.click(screen.getByRole('button', { name: 'Accept' }))

    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('does not activate fast mode when user cancels the dialog', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const onAccept = vi.fn()

    render(
      <CodexFastToggle
        enabled={false}
        accepted={false}
        onToggle={onToggle}
        onAccept={onAccept}
      />
    )

    await user.click(screen.getByTestId('codex-fast-toggle'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onAccept).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('toggles off directly without showing dialog', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()

    render(
      <CodexFastToggle
        enabled={true}
        accepted={false}
        onToggle={onToggle}
        onAccept={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('codex-fast-toggle'))
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
