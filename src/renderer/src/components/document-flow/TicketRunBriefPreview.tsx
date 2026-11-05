import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { isConnectionProject } from '@/lib/connection-project'
import { useProjectStore } from '@/stores/useProjectStore'
import { resolvePreferredAgentSdk } from '@/stores/useSettingsStore'
import { workspaceOfMembers } from '@shared/document-flow/prompts'
import type { DocumentRun, DocumentRunConfig, DocumentRunItem } from '@shared/types/document-flow'
import { effectiveLaunchConfig } from './document-flow-launch'
import { ticketRunPromptParts } from './ticket-run-ui'
import { useBoardTicket } from './useTicketRunBoard'

const PRE_CLASS = 'whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed'

interface TicketRunBriefPreviewProps {
  run: Pick<DocumentRun, 'project_id' | 'config' | 'members'>
  item: DocumentRunItem
  /**
   * The run settings as they stand in the preview (the draft being edited); the run's stored
   * config otherwise. Asking and verification change the rules the run adds.
   */
  config?: Pick<DocumentRunConfig, 'interactive' | 'verificationDisabled' | 'defaultLaunch'>
}

/**
 * "What the agent receives": the launch prompt of a ticket in a run made from board tickets,
 * collapsed until asked for. The user's ticket comes first, word for word as the board would
 * launch it; the rules the run adds (verification, asking, commits, follow-ups) follow in a
 * block of their own, labelled as the run's, so it is plain which words are whose. Read from
 * the board ticket as it is now: the agent gets the ticket as it reads at launch.
 */
export function TicketRunBriefPreview({
  run,
  item,
  config = run.config
}: TicketRunBriefPreviewProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ticket = useBoardTicket(run.project_id, item.ticket_id)
  const hasMembers = !!run.members && run.members.length > 0
  // A connection project's run learns its member folders when it launches (they are the
  // integration instance's), and every agent is told which folder holds which repository.
  const membersAtLaunch = useProjectStore(
    (state) =>
      !hasMembers &&
      isConnectionProject(state.projects.find((project) => project.id === run.project_id))
  )
  const parts = open
    ? ticketRunPromptParts(
        {
          title: ticket?.title ?? item.title,
          description: ticket?.description ?? item.description,
          attachments: ticket?.attachments ?? []
        },
        {
          interactive: config.interactive,
          sdk: effectiveLaunchConfig(item, config.defaultLaunch)?.sdk ?? resolvePreferredAgentSdk(),
          verification: config.verificationDisabled ? [] : item.verification,
          workspace: hasMembers && run.members ? workspaceOfMembers(run.members) : null
        }
      )
    : null

  return (
    <div className="space-y-1.5" data-testid={`docflow-brief-preview-${item.key}`}>
      <button
        type="button"
        aria-expanded={open}
        data-testid={`docflow-brief-preview-toggle-${item.key}`}
        className="flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        What the agent receives
      </button>
      {parts && (
        <div className="max-h-[360px] overflow-y-auto rounded-md border border-border bg-muted/30">
          <pre
            className={`${PRE_CLASS} text-foreground`}
            data-testid={`docflow-brief-preview-brief-${item.key}`}
          >
            {parts.brief}
          </pre>
          <p className="border-t border-dashed border-border px-3 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Added by the run
          </p>
          <pre
            className={`${PRE_CLASS} text-muted-foreground`}
            data-testid={`docflow-brief-preview-rules-${item.key}`}
          >
            {parts.rules}
          </pre>
          {membersAtLaunch && (
            <p
              className="px-3 pb-2 text-[11px] italic leading-snug text-muted-foreground"
              data-testid={`docflow-brief-preview-workspace-note-${item.key}`}
            >
              At launch the run also tells the agent which folder of the connection holds each
              repository.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
