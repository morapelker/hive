/**
 * Cmd/Ctrl+click on an attachment chip (create and edit ticket modals) opens it: links in the
 * browser, local files and images in their default app. A plain click does nothing, and a
 * modifier-click on the chip's X only removes it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TicketAttachmentEditor } from './TicketAttachmentEditor'
import type { TicketAttachment } from './TicketAttachmentEditor'
import { projectApi } from '@/api/project-api'
import { toast } from '@/lib/toast'

vi.mock('@/api/project-api', () => ({
  projectApi: { openPath: vi.fn(async () => '') }
}))

vi.mock('@/api/attachment-api', () => ({
  attachmentApi: { deleteImage: vi.fn(async () => ({ success: true })) }
}))

vi.mock('@/api/file-api', () => ({
  fileApi: {
    getPathForFile: vi.fn(),
    readImageAsBase64: vi.fn(async () => ({ success: false }))
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: { info: vi.fn(), error: vi.fn() }
}))

const figma: TicketAttachment = {
  type: 'figma',
  label: 'Checkout',
  url: 'https://www.figma.com/design/abc/Checkout'
}
const file: TicketAttachment = { type: 'file', label: 'spec.pdf', url: '/tmp/spec.pdf' }

let windowOpen: ReturnType<typeof vi.fn>

beforeEach(() => {
  windowOpen = vi.fn()
  vi.stubGlobal('open', windowOpen)
  vi.mocked(projectApi.openPath).mockClear()
  vi.mocked(projectApi.openPath).mockResolvedValue('')
  vi.mocked(toast.info).mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderEditor(onChange = vi.fn()) {
  render(<TicketAttachmentEditor attachments={[figma, file]} onChange={onChange} />)
  return onChange
}

describe('TicketAttachmentEditor cmd+click to open', () => {
  it('opens a link attachment in the browser on cmd+click', () => {
    renderEditor()
    fireEvent.click(screen.getByTestId('ticket-attachment-chip-0'), { metaKey: true })
    expect(windowOpen).toHaveBeenCalledWith(figma.url, '_blank')
    expect(projectApi.openPath).not.toHaveBeenCalled()
  })

  it('opens a local file in its default app on ctrl+click', () => {
    renderEditor()
    fireEvent.click(screen.getByTestId('ticket-attachment-chip-1'), { ctrlKey: true })
    expect(projectApi.openPath).toHaveBeenCalledWith(file.url)
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('tells the person when the file is gone', async () => {
    vi.mocked(projectApi.openPath).mockResolvedValue('Failed to open path')
    renderEditor()
    fireEvent.click(screen.getByTestId('ticket-attachment-chip-1'), { metaKey: true })
    await waitFor(() => expect(toast.info).toHaveBeenCalled())
  })

  it('does nothing on a plain click', () => {
    renderEditor()
    fireEvent.click(screen.getByTestId('ticket-attachment-chip-0'))
    fireEvent.click(screen.getByTestId('ticket-attachment-chip-1'))
    expect(windowOpen).not.toHaveBeenCalled()
    expect(projectApi.openPath).not.toHaveBeenCalled()
  })

  it('only removes on cmd+click of the X', () => {
    const onChange = renderEditor()
    fireEvent.click(screen.getByTestId('ticket-attachment-remove-0'), { metaKey: true })
    expect(onChange).toHaveBeenCalledWith([file])
    expect(windowOpen).not.toHaveBeenCalled()
  })
})
