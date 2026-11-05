import { useCallback, useState } from 'react'
import { Eye, EyeOff, Paperclip } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { DocumentRun, DocumentRunItem } from '@shared/types/document-flow'
import { pluralize } from './document-flow-ui'
import { TICKET_BRIEF_HELP } from './ticket-run-ui'
import { useDebouncedText } from './useDebouncedText'
import { useBoardTicket } from './useTicketRunBoard'

const LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

interface TicketBriefEditorProps {
  run: Pick<DocumentRun, 'project_id'>
  item: DocumentRunItem
  /** The ticket launched (or the run no longer takes edits): shown, not editable. */
  disabled?: boolean
}

/**
 * The brief of a ticket in a run made from board tickets: its title and description, edited
 * in place and written to the BOARD ticket (debounced, like every field of the preview). The
 * ticket is the brief, so there is one text and one place it lives; the run's own copy of the
 * title and description follows the board. Attachments are sent too, and only counted here.
 */
export function TicketBriefEditor({
  run,
  item,
  disabled = false
}: TicketBriefEditorProps): React.JSX.Element {
  const ticket = useBoardTicket(run.project_id, item.ticket_id)
  const projectId = ticket?.project_id ?? run.project_id
  const ticketId = item.ticket_id
  const [showPreview, setShowPreview] = useState(false)

  const save = useCallback(
    (data: { title?: string; description?: string }): Promise<void> =>
      ticketId
        ? useKanbanStore.getState().updateTicket(ticketId, projectId, data)
        : Promise.reject(new Error('The ticket is no longer on the board.')),
    [ticketId, projectId]
  )
  // A cleared title is the user mid-retype; the field falls back to the stored title when left.
  const saveTitle = useCallback(
    (value: string) => (value.trim() ? save({ title: value }) : Promise.resolve()),
    [save]
  )
  const saveDescription = useCallback((value: string) => save({ description: value }), [save])
  const title = useDebouncedText(ticket?.title ?? item.title, saveTitle)
  const description = useDebouncedText(ticket?.description ?? item.description, saveDescription)
  const attachmentCount = Array.isArray(ticket?.attachments) ? ticket.attachments.length : 0

  return (
    <div className="space-y-3" data-testid={`docflow-ticket-brief-${item.key}`}>
      <div className="space-y-1.5">
        <label htmlFor={`docflow-ticket-title-${item.id}`} className={LABEL_CLASS}>
          Title
        </label>
        <Input
          id={`docflow-ticket-title-${item.id}`}
          data-testid={`docflow-ticket-title-${item.key}`}
          value={title.value}
          disabled={disabled}
          onChange={(event) => title.setValue(event.target.value)}
          onFocus={title.onFocus}
          onBlur={title.onBlur}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor={`docflow-ticket-description-${item.id}`} className={LABEL_CLASS}>
            Description
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            tabIndex={-1}
            data-testid={`docflow-ticket-preview-toggle-${item.key}`}
            className="h-6 gap-1 text-xs text-muted-foreground"
            onClick={() => setShowPreview((previous) => !previous)}
          >
            {showPreview ? (
              <>
                <EyeOff className="h-3.5 w-3.5" /> Edit
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5" /> Preview
              </>
            )}
          </Button>
        </div>
        {showPreview ? (
          <div
            data-testid={`docflow-ticket-description-preview-${item.key}`}
            className="prose prose-sm dark:prose-invert max-h-[320px] min-h-[120px] max-w-none overflow-y-auto rounded-md border border-input bg-muted/30 px-3 py-2 text-sm"
          >
            {description.value.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{description.value}</ReactMarkdown>
            ) : (
              <p className="italic text-muted-foreground/60">No description</p>
            )}
          </div>
        ) : (
          <Textarea
            id={`docflow-ticket-description-${item.id}`}
            data-testid={`docflow-ticket-description-${item.key}`}
            placeholder="What the agent should do (supports markdown)"
            rows={8}
            disabled={disabled}
            className="resize-y font-mono text-[12px]"
            value={description.value}
            onChange={(event) => description.setValue(event.target.value)}
            onFocus={description.onFocus}
            onBlur={description.onBlur}
          />
        )}
        <p className="text-[11px] leading-snug text-muted-foreground">
          {disabled
            ? 'The ticket has launched: its brief is what the agent got.'
            : TICKET_BRIEF_HELP}
          {attachmentCount > 0 && (
            <span
              className="ml-1 inline-flex items-center gap-0.5"
              data-testid={`docflow-ticket-attachments-${item.key}`}
            >
              <Paperclip className="h-3 w-3" />
              {pluralize(attachmentCount, 'attachment')} {attachmentCount === 1 ? 'goes' : 'go'}{' '}
              with it.
            </span>
          )}
        </p>
      </div>
    </div>
  )
}
