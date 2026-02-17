import type { ToolViewProps } from './types'
import { MarkdownRenderer } from '../MarkdownRenderer'

export function ExitPlanModeToolView({ input }: ToolViewProps) {
  const plan = (input.plan || '') as string

  if (!plan) {
    return (
      <div data-testid="exit-plan-mode-tool-view">
        <p className="text-xs text-muted-foreground italic">No plan content available.</p>
      </div>
    )
  }

  return (
    <div data-testid="exit-plan-mode-tool-view">
      <div className="text-sm text-foreground leading-relaxed">
        <MarkdownRenderer content={plan} />
      </div>
    </div>
  )
}
