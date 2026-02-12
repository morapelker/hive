import { useMemo } from 'react'
import { MarkdownRenderer } from '../MarkdownRenderer'
import type { ToolViewProps } from './types'

export function SkillToolView({ output }: ToolViewProps): React.JSX.Element {
  const markdownContent = useMemo(() => {
    if (!output) return ''
    const match = output.match(/<skill_content[^>]*>([\s\S]*?)<\/skill_content>/)
    if (match) return match[1].trim()
    return output
  }, [output])

  return (
    <div className="text-xs" data-testid="skill-tool-view">
      {markdownContent ? (
        <div className="p-3 max-h-[400px] overflow-y-auto">
          <MarkdownRenderer content={markdownContent} />
        </div>
      ) : (
        <div className="p-3 text-muted-foreground">Loading skill...</div>
      )}
    </div>
  )
}
