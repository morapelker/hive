import { memo } from 'react'
import { X, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type Attachment =
  | { kind: 'data'; id: string; name: string; mime: string; dataUrl: string }
  | { kind: 'path'; id: string; name: string; mime: string; filePath: string }
  | {
      kind: 'ticket'
      id: string
      name: string
      ticketId: string
      title: string
      description: string
      attachments: string
    }

export type FileAttachment = Exclude<Attachment, { kind: 'ticket' }>
export type TicketAttachment = Extract<Attachment, { kind: 'ticket' }>
export type AttachmentInput = Attachment extends infer T
  ? T extends Attachment
    ? Omit<T, 'id'>
    : never
  : never

type AttachmentPreviewProps =
  | {
      attachments: Attachment[]
      fileAttachments?: never
      onRemove: (id: string) => void
    }
  | {
      attachments?: never
      fileAttachments: FileAttachment[]
      onRemove: (id: string) => void
    }

export const AttachmentPreview = memo(function AttachmentPreview(
  props: AttachmentPreviewProps
): React.JSX.Element | null {
  const { onRemove } = props
  const fileAttachments =
    props.fileAttachments ??
    props.attachments.filter(
      (attachment): attachment is FileAttachment => attachment.kind !== 'ticket'
    )

  if (fileAttachments.length === 0) return null

  return (
    <div className="flex gap-2 px-3 py-2 overflow-x-auto" data-testid="attachment-preview">
      {fileAttachments.map((attachment) => (
        <div
          key={attachment.id}
          className="relative flex-shrink-0 group"
          data-testid="attachment-item"
          title={attachment.kind === 'path' ? attachment.filePath : undefined}
        >
          {attachment.kind === 'data' && attachment.mime.startsWith('image/') ? (
            <img
              src={attachment.dataUrl}
              alt={attachment.name}
              className="h-16 w-16 object-cover rounded border border-border"
            />
          ) : (
            <div className="h-16 w-16 flex flex-col items-center justify-center gap-1 rounded border border-border bg-muted">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground truncate max-w-[56px] px-1">
                {attachment.name}
              </span>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="absolute -top-1.5 -right-1.5 h-5 w-5 p-0 rounded-full bg-background border border-border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => onRemove(attachment.id)}
            aria-label={`Remove ${attachment.name}`}
            data-testid="attachment-remove"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  )
})
