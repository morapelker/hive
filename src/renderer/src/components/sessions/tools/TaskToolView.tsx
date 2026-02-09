import { useState } from 'react'
import { Bot, ChevronDown, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_LINES = 20
const MAX_PROMPT_LENGTH = 300

/** Parse task output: strip task_id line and <task_result> tags */
function parseTaskOutput(output: string): string {
  let text = output
  // Remove task_id line at the start
  text = text.replace(/^task_id:\s*\S+.*\n\n?/, '')
  // Remove <task_result> / </task_result> tags
  text = text.replace(/<\/?task_result>\n?/g, '')
  return text.trim()
}

export function TaskToolView({ input, output, error }: ToolViewProps) {
  const [showAllOutput, setShowAllOutput] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)

  const description = (input.description || '') as string
  const prompt = (input.prompt || '') as string
  const subagentType = (input.subagent_type || input.subagentType || '') as string

  const cleanOutput = output ? parseTaskOutput(output) : ''
  const outputLines = cleanOutput ? cleanOutput.split('\n') : []
  const needsTruncation = outputLines.length > MAX_PREVIEW_LINES
  const displayedOutput = showAllOutput
    ? cleanOutput
    : outputLines.slice(0, MAX_PREVIEW_LINES).join('\n')

  const truncatedPrompt = prompt.length > MAX_PROMPT_LENGTH
    ? prompt.slice(0, MAX_PROMPT_LENGTH) + '...'
    : prompt

  return (
    <div data-testid="task-tool-view">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground">{description || 'Agent Task'}</span>
        {subagentType && (
          <span className="text-[10px] bg-blue-500/15 text-blue-500 dark:text-blue-400 rounded px-1.5 py-0.5 font-medium">
            {subagentType}
          </span>
        )}
      </div>

      {/* Prompt (collapsible) */}
      {prompt && (
        <div className="mb-2">
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors font-medium"
          >
            <FileText className="h-3 w-3" />
            <span>Prompt</span>
            <ChevronDown className={cn(
              'h-2.5 w-2.5 transition-transform duration-150',
              !showPrompt && '-rotate-90'
            )} />
          </button>
          {showPrompt && (
            <pre className="mt-1 text-xs font-mono text-muted-foreground bg-muted/50 rounded p-2 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {truncatedPrompt}
            </pre>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-2">
          <div className="text-red-400 font-mono text-xs whitespace-pre-wrap break-all bg-red-500/10 rounded p-2">
            {error}
          </div>
        </div>
      )}

      {/* Output */}
      {cleanOutput && (
        <div>
          <pre className="text-xs font-mono text-muted-foreground bg-muted/50 rounded p-2 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
            {displayedOutput}
          </pre>
          {needsTruncation && (
            <button
              onClick={() => setShowAllOutput(!showAllOutput)}
              className="flex items-center gap-1 mt-1.5 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
              data-testid="show-all-button"
            >
              <ChevronDown className={cn(
                'h-3 w-3 transition-transform duration-150',
                showAllOutput && 'rotate-180'
              )} />
              {showAllOutput
                ? 'Show less'
                : `Show all ${outputLines.length} lines`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
