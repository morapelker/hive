import { useProjectStore } from '@/stores/useProjectStore'
import { toast } from '@/lib/toast'
import { autoPinBaseWorktree } from '@/lib/auto-pin'
import { launchTicketWithModel, type LaunchModelConfig } from '@/lib/ticket-launch'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'

type AutoLaunchMode = 'build' | 'plan' | 'super-plan'

interface AutoLaunchTicket {
  id: string
  project_id: string
  title: string
  pending_launch_config: string | null
}

/** One provider/model entry in a (multi-model) pending launch config. */
export interface PendingLaunchModelEntry {
  sdk: HandoffAgentSdk
  model: { providerID: string; modelID: string; variant?: string } | null
  codexFastMode: boolean
}

interface PendingLaunchConfig {
  worktree: { type: 'new'; sourceBranch: string } | { type: 'existing'; worktreeId: string }
  prompt: string
  mode: AutoLaunchMode
  model: { providerID: string; modelID: string; variant?: string } | null
  sdk: HandoffAgentSdk
  codexFastMode: boolean
  goalMode: boolean
  goalSuccessCriteria: string | null
  /** NEW (optional): multi-model launch entries; [0] applies to the original ticket. */
  models?: PendingLaunchModelEntry[]
}

/**
 * Normalize a pending launch config into the list of model entries to launch.
 * Legacy configs (no `models`) yield a single entry from the top-level fields.
 */
export function resolveModelEntries(config: PendingLaunchConfig): LaunchModelConfig[] {
  if (config.models?.length) return config.models
  return [{ sdk: config.sdk, model: config.model, codexFastMode: config.codexFastMode }]
}

export async function autoLaunchTicket(ticket: AutoLaunchTicket): Promise<void> {
  if (!ticket.pending_launch_config) return

  let config: PendingLaunchConfig
  try {
    config = JSON.parse(ticket.pending_launch_config) as PendingLaunchConfig
  } catch {
    console.error('Failed to parse pending_launch_config for ticket:', ticket.id)
    return
  }
  const configGoalMode = config.goalMode === true
  const configGoalSuccessCriteria = config.goalSuccessCriteria?.trim() || null

  const project = useProjectStore.getState().projects.find((p) => p.id === ticket.project_id)
  if (!project) {
    console.error('Project not found for auto-launch:', ticket.project_id)
    return
  }

  // Pin the base worktree once per batch (not per model — a future multi-launch
  // must not re-pin for every model it spawns).
  void autoPinBaseWorktree(ticket.project_id)

  const entries = resolveModelEntries(config)

  // TODO(task 5): route to runMultiModelLaunch when
  // `entries.length > 1 && config.worktree.type === 'new'` — one worktree +
  // duplicated ticket per model. Until then, launch only entries[0] so existing
  // single-model behavior is unchanged.
  const result = await launchTicketWithModel({
    ticketId: ticket.id,
    projectId: ticket.project_id,
    ticketTitle: ticket.title,
    worktree: config.worktree,
    prompt: config.prompt,
    mode: config.mode,
    modelConfig: entries[0],
    goalMode: configGoalMode,
    goalSuccessCriteria: configGoalSuccessCriteria,
    ticketUpdateExtras: { pending_launch_config: null }
  })

  if (result.success) {
    toast.success(`Auto-launched: ${ticket.title}`)
    return
  }

  // launchTicketWithModel funnels every failure (worktree/session/connect and
  // any thrown error) into a single result, so the two historical failure
  // toasts collapse to one. Keep the console.error for diagnostics.
  console.error('Auto-launch failed for ticket:', ticket.id, result.error)
  toast.error(`Auto-launch failed: ${result.error || 'Could not launch session'}`)
}
