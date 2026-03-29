import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore, useSessionStore } from '@/stores'
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

  const latestAgentSdk = useSessionStore((s) => {
    const sessions = s.sessionsByWorktree.get(worktreeId)
    if (!sessions?.length) return null
    return sessions[sessions.length - 1].agent_sdk ?? null
  })

  if (!showModelIcons) return null

  // Claude Agent SDK always uses Claude models
  if (latestAgentSdk === 'claude-code') {
    return <img src={claudeIcon} alt="Claude" className={cn(className)} draggable={false} />
  }

  // Codex SDK always uses OpenAI/GPT models
  if (latestAgentSdk === 'codex') {
    return <img src={openaiIcon} alt="OpenAI" className={cn(className)} draggable={false} />
  }

  const matched = getModelIcon(lastModelId)
  if (!matched) return null

  return <img src={matched.icon} alt={matched.label} className={cn(className)} draggable={false} />
}
