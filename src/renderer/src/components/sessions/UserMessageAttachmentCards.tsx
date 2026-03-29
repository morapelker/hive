import { KanbanSquare, Github, FileText } from 'lucide-react'
import type { ParsedTicket, ParsedPrComment, ParsedFile } from '@/lib/parse-user-message-attachments'

interface UserMessageAttachmentCardsProps {
  tickets: ParsedTicket[]
  prComments: ParsedPrComment[]
  files: ParsedFile[]
}

export function UserMessageAttachmentCards({
  tickets,
  prComments,
  files
}: UserMessageAttachmentCardsProps): React.JSX.Element | null {
  if (tickets.length === 0 && prComments.length === 0 && files.length === 0) return null

  return (
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
              <Github className="h-3.5 w-3.5 shrink-0 text-foreground" />
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
    </div>
  )
}
