import { useState } from 'react'
import { Terminal, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_LINES = 20

/** Strip basic ANSI escape codes from text */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

export function BashToolView({ input, output, error }: ToolViewProps) {
  const [showAll, setShowAll] = useState(false)

  const command = (input.command || input.cmd || '') as string
  const description = (input.description || '') as string

  const cleanOutput = output ? stripAnsi(output) : ''
  const lines = cleanOutput ? cleanOutput.split('\n') : []
  const needsTruncation = lines.length > MAX_PREVIEW_LINES
  const displayedOutput = showAll ? cleanOutput : lines.slice(0, MAX_PREVIEW_LINES).join('\n')

  return (
    <div data-testid="bash-tool-view">
      {/* Command header with terminal styling */}
      <div className="bg-zinc-900 rounded-t-md px-3 py-2 font-mono text-xs">
        {description && <div className="text-zinc-500 mb-1 text-[10px]"># {description}</div>}
        <div className="flex items-start gap-1.5">
          <Terminal className="h-3.5 w-3.5 text-zinc-500 mt-0.5 shrink-0" />
          <span className="text-green-400 select-none shrink-0">$</span>
          <span className="text-zinc-200 whitespace-pre-wrap break-all">{command}</span>
        </div>
      </div>

      {/* Output area */}
      {(cleanOutput || error) && (
        <div className="bg-zinc-950 rounded-b-md px-3 py-2 font-mono text-xs border-t border-zinc-800">
          {error && <div className="text-red-400 whitespace-pre-wrap break-all mb-1">{error}</div>}
          {cleanOutput && (
            <>
              <pre className="text-zinc-400 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                {displayedOutput}
              </pre>
              {needsTruncation && (
                <button
                  onClick={() => setShowAll(!showAll)}
                  className="flex items-center gap-1 mt-2 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
                  data-testid="show-all-button"
                >
                  <ChevronDown
                    className={cn(
                      'h-3 w-3 transition-transform duration-150',
                      showAll && 'rotate-180'
                    )}
                  />
                  {showAll ? 'Show less' : `Show all ${lines.length} lines`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
