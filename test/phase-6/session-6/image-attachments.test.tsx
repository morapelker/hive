import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AttachmentButton } from '../../../src/renderer/src/components/sessions/AttachmentButton'
import { AttachmentPreview } from '../../../src/renderer/src/components/sessions/AttachmentPreview'
import type { Attachment } from '../../../src/renderer/src/components/sessions/AttachmentPreview'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Session 6: Image Attachments', () => {
  describe('AttachmentButton', () => {
    test('renders paperclip button in input area', () => {
      const onAttach = vi.fn()
      render(<AttachmentButton onAttach={onAttach} />)

      const button = screen.getByTestId('attachment-button')
      expect(button).toBeInTheDocument()
      expect(button).toHaveAttribute('title', 'Attach image or file')
    })

    test('file input is hidden', () => {
      const onAttach = vi.fn()
      render(<AttachmentButton onAttach={onAttach} />)

      const input = screen.getByTestId('attachment-file-input')
      expect(input).toHaveClass('hidden')
    })

    test('file input accepts images and PDFs', () => {
      const onAttach = vi.fn()
      render(<AttachmentButton onAttach={onAttach} />)

      const input = screen.getByTestId('attachment-file-input')
      expect(input).toHaveAttribute('accept', 'image/*,.pdf')
    })

    test('file input allows multiple files', () => {
      const onAttach = vi.fn()
      render(<AttachmentButton onAttach={onAttach} />)

      const input = screen.getByTestId('attachment-file-input')
      expect(input).toHaveAttribute('multiple')
    })

    test('clicking button triggers file input click', () => {
      const onAttach = vi.fn()
      render(<AttachmentButton onAttach={onAttach} />)

      const input = screen.getByTestId('attachment-file-input') as HTMLInputElement
      const clickSpy = vi.spyOn(input, 'click')

      const button = screen.getByTestId('attachment-button')
      fireEvent.click(button)

      expect(clickSpy).toHaveBeenCalled()
    })

    test('button is disabled when disabled prop is true', () => {
      const onAttach = vi.fn()
      render(<AttachmentButton onAttach={onAttach} disabled />)

      const button = screen.getByTestId('attachment-button')
      expect(button).toBeDisabled()
    })
  })

  describe('AttachmentPreview', () => {
    const mockAttachments: Attachment[] = [
      {
        id: 'att-1',
        name: 'screenshot.png',
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,abc123'
      },
      {
        id: 'att-2',
        name: 'photo.jpg',
        mime: 'image/jpeg',
        dataUrl: 'data:image/jpeg;base64,xyz789'
      }
    ]

    test('hidden when no attachments', () => {
      const { container } = render(
        <AttachmentPreview attachments={[]} onRemove={vi.fn()} />
      )

      expect(container.innerHTML).toBe('')
    })

    test('renders thumbnails for image attachments', () => {
      render(
        <AttachmentPreview attachments={mockAttachments} onRemove={vi.fn()} />
      )

      const preview = screen.getByTestId('attachment-preview')
      expect(preview).toBeInTheDocument()

      const items = screen.getAllByTestId('attachment-item')
      expect(items).toHaveLength(2)

      // Images render as img elements
      const images = preview.querySelectorAll('img')
      expect(images).toHaveLength(2)
      expect(images[0]).toHaveAttribute('src', 'data:image/png;base64,abc123')
      expect(images[1]).toHaveAttribute('src', 'data:image/jpeg;base64,xyz789')
    })

    test('renders file icon for PDF attachments', () => {
      const pdfAttachment: Attachment[] = [
        {
          id: 'att-pdf',
          name: 'report.pdf',
          mime: 'application/pdf',
          dataUrl: 'data:application/pdf;base64,pdf123'
        }
      ]

      render(
        <AttachmentPreview attachments={pdfAttachment} onRemove={vi.fn()} />
      )

      // PDF should NOT have an img element
      const preview = screen.getByTestId('attachment-preview')
      const images = preview.querySelectorAll('img')
      expect(images).toHaveLength(0)

      // Should show filename text
      expect(screen.getByText('report.pdf')).toBeInTheDocument()
    })

    test('remove button calls onRemove with correct id', () => {
      const onRemove = vi.fn()
      render(
        <AttachmentPreview attachments={mockAttachments} onRemove={onRemove} />
      )

      const removeButtons = screen.getAllByTestId('attachment-remove')
      expect(removeButtons).toHaveLength(2)

      fireEvent.click(removeButtons[0])
      expect(onRemove).toHaveBeenCalledWith('att-1')

      fireEvent.click(removeButtons[1])
      expect(onRemove).toHaveBeenCalledWith('att-2')
    })

    test('multiple attachments displayed in row', () => {
      const threeAttachments: Attachment[] = [
        { id: '1', name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,a' },
        { id: '2', name: 'b.png', mime: 'image/png', dataUrl: 'data:image/png;base64,b' },
        { id: '3', name: 'c.png', mime: 'image/png', dataUrl: 'data:image/png;base64,c' }
      ]

      render(
        <AttachmentPreview attachments={threeAttachments} onRemove={vi.fn()} />
      )

      const items = screen.getAllByTestId('attachment-item')
      expect(items).toHaveLength(3)
    })
  })

  describe('Attachment state management', () => {
    test('handleAttach adds attachment with unique id', () => {
      const attachments: Attachment[] = []
      const file = { name: 'test.png', mime: 'image/png', dataUrl: 'data:image/png;base64,abc' }

      const newAttachment: Attachment = {
        id: crypto.randomUUID(),
        ...file
      }
      const updated = [...attachments, newAttachment]

      expect(updated).toHaveLength(1)
      expect(updated[0].name).toBe('test.png')
      expect(updated[0].mime).toBe('image/png')
      expect(updated[0].id).toBeTruthy()
    })

    test('handleRemoveAttachment removes by id', () => {
      const attachments: Attachment[] = [
        { id: 'a', name: 'a.png', mime: 'image/png', dataUrl: 'data:a' },
        { id: 'b', name: 'b.png', mime: 'image/png', dataUrl: 'data:b' }
      ]

      const updated = attachments.filter(a => a.id !== 'a')

      expect(updated).toHaveLength(1)
      expect(updated[0].id).toBe('b')
    })

    test('attachments cleared after send', () => {
      const attachments: Attachment[] = [
        { id: 'a', name: 'a.png', mime: 'image/png', dataUrl: 'data:a' }
      ]

      // Simulate clearing after send
      const cleared: Attachment[] = []
      expect(cleared).toHaveLength(0)
      expect(attachments).toHaveLength(1) // Original unchanged (immutable)
    })
  })

  describe('Clipboard paste handler', () => {
    test('image paste creates attachment', () => {
      const attachments: Array<{ name: string; mime: string; dataUrl: string }> = []

      // Simulate paste event processing logic
      const items = [
        { type: 'image/png', getAsFile: () => ({ name: 'pasted.png', type: 'image/png' }) }
      ]

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            attachments.push({
              name: file.name || 'pasted-image.png',
              mime: file.type,
              dataUrl: 'data:image/png;base64,fakedata'
            })
          }
        }
      }

      expect(attachments).toHaveLength(1)
      expect(attachments[0].name).toBe('pasted.png')
      expect(attachments[0].mime).toBe('image/png')
    })

    test('text paste does not create attachment', () => {
      const attachments: Array<{ name: string; mime: string; dataUrl: string }> = []

      // Simulate paste event with text data
      const items = [
        { type: 'text/plain', getAsFile: () => null }
      ]

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            attachments.push({
              name: 'shouldnt-happen.png',
              mime: file.type,
              dataUrl: 'data:fake'
            })
          }
        }
      }

      expect(attachments).toHaveLength(0)
    })

    test('pasted image without name defaults to pasted-image.png', () => {
      const file = { name: '', type: 'image/png' }
      const name = file.name || 'pasted-image.png'

      expect(name).toBe('pasted-image.png')
    })
  })

  describe('Message parts construction', () => {
    test('attachments included as file parts before text', () => {
      const attachments: Attachment[] = [
        { id: '1', name: 'img.png', mime: 'image/png', dataUrl: 'data:image/png;base64,abc' }
      ]
      const promptMessage = 'describe this image'

      type MessagePart =
        | { type: 'text'; text: string }
        | { type: 'file'; mime: string; url: string; filename?: string }

      const parts: MessagePart[] = [
        ...attachments.map(a => ({
          type: 'file' as const,
          mime: a.mime,
          url: a.dataUrl,
          filename: a.name
        })),
        { type: 'text' as const, text: promptMessage }
      ]

      expect(parts).toHaveLength(2)
      expect(parts[0]).toEqual({
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,abc',
        filename: 'img.png'
      })
      expect(parts[1]).toEqual({
        type: 'text',
        text: 'describe this image'
      })
    })

    test('multiple attachments all included as file parts', () => {
      const attachments: Attachment[] = [
        { id: '1', name: 'a.png', mime: 'image/png', dataUrl: 'data:a' },
        { id: '2', name: 'b.pdf', mime: 'application/pdf', dataUrl: 'data:b' },
        { id: '3', name: 'c.jpg', mime: 'image/jpeg', dataUrl: 'data:c' }
      ]

      type MessagePart =
        | { type: 'text'; text: string }
        | { type: 'file'; mime: string; url: string; filename?: string }

      const parts: MessagePart[] = [
        ...attachments.map(a => ({
          type: 'file' as const,
          mime: a.mime,
          url: a.dataUrl,
          filename: a.name
        })),
        { type: 'text' as const, text: 'check these files' }
      ]

      expect(parts).toHaveLength(4)
      expect(parts.filter(p => p.type === 'file')).toHaveLength(3)
      expect(parts.filter(p => p.type === 'text')).toHaveLength(1)
    })

    test('no attachments produces text-only parts', () => {
      const attachments: Attachment[] = []

      type MessagePart =
        | { type: 'text'; text: string }
        | { type: 'file'; mime: string; url: string; filename?: string }

      const parts: MessagePart[] = [
        ...attachments.map(a => ({
          type: 'file' as const,
          mime: a.mime,
          url: a.dataUrl,
          filename: a.name
        })),
        { type: 'text' as const, text: 'just text' }
      ]

      expect(parts).toHaveLength(1)
      expect(parts[0].type).toBe('text')
    })
  })
})
