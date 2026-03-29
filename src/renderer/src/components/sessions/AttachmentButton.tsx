import { useRef } from 'react'
import { Paperclip, FileUp, KanbanSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { isImageMime } from '@/lib/file-attachment-utils'
import type { Attachment } from './AttachmentPreview'

interface AttachmentButtonProps {
  onAttach: (file: Omit<Attachment, 'id'>) => void
  disabled?: boolean
  /** Current project ID — when non-null the "Board ticket" option is shown */
  projectId?: string | null
  /** Called when the user picks "Board ticket" from the dropdown */
  onPickTicket?: () => void
}

export function AttachmentButton({
  onAttach,
  disabled,
  projectId,
  onPickTicket
}: AttachmentButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = () => {
    inputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    for (const file of Array.from(files)) {
      if (isImageMime(file.type)) {
        const reader = new FileReader()
        reader.onload = () => {
          onAttach({
            kind: 'data',
            name: file.name,
            mime: file.type,
            dataUrl: reader.result as string
          })
        }
        reader.onerror = () => {
          console.error(`Failed to read file: ${file.name}`)
        }
        reader.readAsDataURL(file)
      } else {
        onAttach({
          kind: 'path',
          name: file.name,
          mime: file.type || 'application/octet-stream',
          filePath: window.fileOps.getPathForFile(file)
        })
      }
    }

    // Reset input so same file can be selected again
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
        data-testid="attachment-file-input"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={disabled}
            title="Attach file or ticket"
            aria-label="Attach file or ticket"
            data-testid="attachment-button"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[160px]">
          <DropdownMenuItem
            onSelect={handleFileSelect}
            data-testid="attach-file"
          >
            <FileUp className="h-4 w-4 mr-2" />
            File
          </DropdownMenuItem>
          {projectId && (
            <DropdownMenuItem
              onSelect={() => onPickTicket?.()}
              data-testid="attach-board-ticket"
            >
              <KanbanSquare className="h-4 w-4 mr-2" />
              Board ticket
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
