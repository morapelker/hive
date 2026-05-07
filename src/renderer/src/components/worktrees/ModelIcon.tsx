import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore, useSessionStore } from '@/stores'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'
import { useShallow } from 'zustand/react/shallow'

const MODEL_ICON_MATCHERS = [
  { pattern: /^claude/i, icon: claudeIcon, label: 'Claude' },
  { pattern: /^gpt/i, icon: openaiIcon, label: 'OpenAI' }
] as const

const CLAUDE_PROVIDER_IDS = new Set(['anthropic', 'claude-code'])
const OPENAI_PROVIDER_IDS = new Set(['codex', 'openai'])

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

  const lastModelInfo = useWorktreeStore(
    useShallow((s) => {
      for (const worktrees of s.worktreesByProject.values()) {
        const wt = worktrees.find((w) => w.id === worktreeId)
        if (wt) {
          return {
            providerId: wt.last_model_provider_id,
            modelId: wt.last_model_id
          }
        }
      }
      return null
    })
  )

  const latestAgentSdk = useSessionStore((s) => {
    const sessions = s.sessionsByWorktree.get(worktreeId)
    if (!sessions?.length) return null
    return sessions[0].agent_sdk ?? null
  })

  if (!showModelIcons) return null

  const matched = getModelIcon(lastModelInfo?.modelId)
  if (
    (lastModelInfo?.providerId && CLAUDE_PROVIDER_IDS.has(lastModelInfo.providerId)) ||
    matched?.label === 'Claude'
  ) {
    return <img src={claudeIcon} alt="Claude" className={cn(className)} draggable={false} />
  }

  if (
    (lastModelInfo?.providerId && OPENAI_PROVIDER_IDS.has(lastModelInfo.providerId)) ||
    matched?.label === 'OpenAI'
  ) {
    return <img src={openaiIcon} alt="OpenAI" className={cn(className)} draggable={false} />
  }

  if (!lastModelInfo?.providerId && !lastModelInfo?.modelId) {
    // No prompt has been sent yet, so infer from the newest session SDK.
    if (latestAgentSdk === 'claude-code') {
      return <img src={claudeIcon} alt="Claude" className={cn(className)} draggable={false} />
    }

    if (latestAgentSdk === 'codex') {
      return <img src={openaiIcon} alt="OpenAI" className={cn(className)} draggable={false} />
    }
  }

  return null
}
