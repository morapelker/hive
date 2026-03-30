import { useState, useEffect } from 'react'
import { KanbanSquare, FileText, X } from 'lucide-react'
import { ProviderIcon } from '@/components/ui/provider-icon'
import type { ParsedTicket, ParsedPrComment, ParsedFile, ParsedDataAttachment } from '@/lib/parse-user-message-attachments'

interface UserMessageAttachmentCardsProps {
  tickets: ParsedTicket[]
  prComments: ParsedPrComment[]
  files: ParsedFile[]
  dataAttachments: ParsedDataAttachment[]
}

export function UserMessageAttachmentCards({
  tickets,
  prComments,
  files,
  dataAttachments
}: UserMessageAttachmentCardsProps): React.JSX.Element | null {
  const [expandedImage, setExpandedImage] = useState<{ dataUrl: string; name: string } | null>(null)

  // Handle Escape key to close lightbox
  useEffect(() => {
    if (!expandedImage) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpandedImage(null)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [expandedImage])

  if (tickets.length === 0 && prComments.length === 0 && files.length === 0 && dataAttachments.length === 0) return null

  return (
    <>
    <div className="flex flex-wrap gap-2 justify-end mb-2">
      {tickets.map((t, i) => (
        <div
          key={`ticket-${i}`}
          className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px] min-w-[220px]"
          data-testid="parsed-ticket-card"
        >
          <div className="flex items-center gap-2">
            <KanbanSquare className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            <span className="font-medium text-foreground truncate">{t.title}</span>
          </div>
          {t.description && (
            <span
              className="text-xs text-muted-foreground line-clamp-2"
              data-testid="parsed-ticket-description"
            >
              {t.description.length > 120 ? t.description.slice(0, 120) + '...' : t.description}
            </span>
          )}
        </div>
      ))}

      {prComments.map((c, i) => {
        const fileName = c.file.split('/').pop() ?? c.file
        const lineLabel = c.line === 'file-level' ? '' : `:${c.line}`
        return (
          <div
            key={`pr-${i}`}
            className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px] min-w-[220px]"
            data-testid="parsed-pr-comment-card"
          >
            <div className="flex items-center gap-2">
              <ProviderIcon provider="github" />
              <span className="font-medium text-foreground truncate">{c.author}</span>
            </div>
            <span className="text-xs text-muted-foreground truncate">
              {fileName}{lineLabel}
            </span>
            {c.body && (
              <span
                className="text-xs text-muted-foreground line-clamp-2"
                data-testid="parsed-pr-comment-body"
              >
                {c.body.length > 80 ? c.body.slice(0, 80) + '...' : c.body}
              </span>
            )}
          </div>
        )
      })}

      {files.map((f, i) => (
        <div
          key={`file-${i}`}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px]"
          data-testid="parsed-file-card"
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs text-foreground truncate">{f.name}</span>
        </div>
      ))}

      {dataAttachments.map((d, i) =>
        d.mime.startsWith('image/') ? (
          <div
            key={`data-${i}`}
            className="relative rounded-lg border border-border overflow-hidden max-w-[200px] cursor-pointer hover:opacity-90 transition-opacity"
            data-testid="parsed-image-attachment"
            onClick={() => setExpandedImage({ dataUrl: d.dataUrl, name: d.name })}
          >
            <img
              src={d.dataUrl}
              alt={d.name}
              className="w-full h-auto max-h-[150px] object-contain bg-muted"
            />
            <div className="absolute bottom-0 left-0 right-0 bg-background/90 backdrop-blur-sm px-2 py-1 text-xs text-muted-foreground truncate">
              {d.name}
            </div>
          </div>
        ) : (
          <div
            key={`data-${i}`}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px]"
            data-testid="parsed-data-attachment"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs text-foreground truncate">{d.name}</span>
          </div>
        )
      )}
    </div>

    {expandedImage && (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
        onClick={() => setExpandedImage(null)}
        data-testid="image-lightbox"
      >
        <div className="relative max-w-[90vw] max-h-[90vh] p-4">
          <button
            className="absolute -top-2 -right-2 p-2 rounded-full bg-background/90 hover:bg-background text-foreground shadow-lg transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              setExpandedImage(null)
            }}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
          <img
            src={expandedImage.dataUrl}
            alt={expandedImage.name}
            className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="mt-2 text-center text-sm text-white/90">{expandedImage.name}</div>
        </div>
      </div>
    )}
  </>
  )
}
