import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'

const MODEL_ICON_MATCHERS = [
  { pattern: /^claude/i, icon: claudeIcon, label: 'Claude' },
  { pattern: /^gpt/i, icon: openaiIcon, label: 'OpenAI' }
] as const

function getModelIcon(
  modelId: string | null | undefined
): (typeof MODEL_ICON_MATCHERS)[number] | null {
  if (!modelId) return null
  for (const matcher of MODEL_ICON_MATCHERS) {
    if (matcher.pattern.test(modelId)) return matcher
  }
  return null
}

interface ModelIconProps {
  worktreeId: string
  className?: string
}

export function ModelIcon({ worktreeId, className }: ModelIconProps): React.JSX.Element | null {
  const showModelIcons = useSettingsStore((s) => s.showModelIcons)

  const lastModelId = useWorktreeStore((s) => {
    for (const worktrees of s.worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === worktreeId)
      if (wt) return wt.last_model_id
    }
    return null
  })

  if (!showModelIcons) return null

  const matched = getModelIcon(lastModelId)
  if (!matched) return null

  return <img src={matched.icon} alt={matched.label} className={cn(className)} draggable={false} />
}
