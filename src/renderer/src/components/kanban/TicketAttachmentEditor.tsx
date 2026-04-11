import { useState, useCallback, useRef, useEffect } from 'react'
import { Plus, X, Ticket, Figma, Link as LinkIcon, FileUp, File as FileIcon, ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { parseAttachmentUrl } from '@/lib/attachment-utils'
import type { AttachmentInfo } from '@/lib/attachment-utils'
import { toast } from '@/lib/toast'

export interface TicketAttachment extends AttachmentInfo {
  url: string
}

export const MAX_ATTACHMENTS = 10

interface TicketAttachmentEditorProps {
  attachments: TicketAttachment[]
  onChange: (attachments: TicketAttachment[]) => void
  testIdPrefix?: string // e.g. 'ticket' or 'ticket-edit'
}

export function TicketAttachmentEditor({ attachments, onChange, testIdPrefix = 'ticket' }: TicketAttachmentEditorProps) {
  const [showAttachInput, setShowAttachInput] = useState(false)
  const [attachUrl, setAttachUrl] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const detectedAttachment = attachUrl.trim() ? parseAttachmentUrl(attachUrl.trim()) : null

  const handleAddAttachment = useCallback(() => {
    if (!detectedAttachment || !attachUrl.trim()) return
    onChange([...attachments, { ...detectedAttachment, url: attachUrl.trim() }])
    setAttachUrl('')
    setShowAttachInput(false)
  }, [detectedAttachment, attachUrl, attachments, onChange])

  const handleRemoveAttachment = useCallback(
    (index: number) => {
      const removed = attachments[index]
      // Delete image files from disk
      if (removed?.type === 'image' && removed.url) {
        window.attachmentOps.deleteImage(removed.url).catch(() => {})
      }
      onChange(attachments.filter((_, i) => i !== index))
    },
    [attachments, onChange]
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files) return
      const newAttachments = [...attachments]
      for (const file of Array.from(files)) {
        const filePath = window.fileOps.getPathForFile(file)
        newAttachments.push({ type: 'file' as const, url: filePath, label: file.name })
      }
      onChange(newAttachments)
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [attachments, onChange]
  )

  return (
    <div className="space-y-2">
      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((attachment, index) => (
            <AttachmentChip
              key={index}
              attachment={attachment}
              index={index}
              onRemove={handleRemoveAttachment}
              testIdPrefix={testIdPrefix}
            />
          ))}
        </div>
      )}

      {/* URL input or Add button */}
      {showAttachInput ? (
        <div className="flex items-center gap-2">
          <Input
            data-testid={`${testIdPrefix}-attachment-url-input`}
            placeholder="Paste a Jira or Figma URL"
            value={attachUrl}
            onChange={(e) => setAttachUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && detectedAttachment) {
                e.preventDefault()
                handleAddAttachment()
              }
              if (e.key === 'Escape') {
                setShowAttachInput(false)
                setAttachUrl('')
              }
            }}
            autoFocus
            className="flex-1"
          />
          <Button
            type="button"
            size="sm"
            data-testid={`${testIdPrefix}-attachment-confirm-btn`}
            disabled={!detectedAttachment}
            onClick={handleAddAttachment}
          >
            Add
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowAttachInput(false)
              setAttachUrl('')
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`${testIdPrefix}-add-attachment-btn`}
                className="gap-1 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                Add attachment
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setShowAttachInput(true)}>
                <LinkIcon className="h-4 w-4 mr-2" />
                URL
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                <FileUp className="h-4 w-4 mr-2" />
                File / Image
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  )
}

// ── Attachment Chip with Thumbnail ──────────────────────────────────

function AttachmentChip({
  attachment,
  index,
  onRemove,
  testIdPrefix
}: {
  attachment: TicketAttachment
  index: number
  onRemove: (index: number) => void
  testIdPrefix: string
}) {
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null)

  useEffect(() => {
    if (attachment.type !== 'image') return
    let cancelled = false

    window.fileOps.readImageAsBase64(attachment.url).then((result) => {
      if (cancelled || !result.success || !result.data || !result.mimeType) return
      setThumbnailSrc(`data:${result.mimeType};base64,${result.data}`)
    })

    return () => { cancelled = true }
  }, [attachment.type, attachment.url])

  return (
    <span
      data-testid={`${testIdPrefix}-attachment-chip-${index}`}
      className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
    >
      {attachment.type === 'image' && thumbnailSrc ? (
        <img
          src={thumbnailSrc}
          alt={attachment.label}
          className="h-6 w-6 rounded object-cover"
        />
      ) : attachment.type === 'image' ? (
        <ImageIcon className="h-3 w-3 text-emerald-500" />
      ) : attachment.type === 'jira' ? (
        <Ticket className="h-3 w-3 text-blue-500" />
      ) : attachment.type === 'figma' ? (
        <Figma className="h-3 w-3 text-purple-500" />
      ) : attachment.type === 'file' ? (
        <FileIcon className="h-3 w-3 text-green-500" />
      ) : (
        <LinkIcon className="h-3 w-3 text-muted-foreground" />
      )}
      <span className="max-w-[180px] truncate">{attachment.label}</span>
      <button
        data-testid={`${testIdPrefix}-attachment-remove-${index}`}
        onClick={() => onRemove(index)}
        className="ml-0.5 rounded-sm hover:bg-muted transition-colors"
      >
        <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
      </button>
    </span>
  )
}
