import { useProjectStore } from '@/stores/useProjectStore'
import { toast } from '@/lib/toast'
import { launchTicketWithModel, type LaunchModelConfig } from '@/lib/ticket-launch'
import { runMultiModelLaunch } from '@/lib/multi-model-launch'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'

type AutoLaunchMode = 'build' | 'plan' | 'super-plan' | 'super-build'

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
  /** claude-code-cli only: launch through this custom provider's command. */
  customProviderId?: string | null
}

interface PendingLaunchConfig {
  worktree:
    | { type: 'new'; sourceBranch: string }
    | { type: 'existing'; worktreeId: string }
    | { type: 'connection-new' }
    | { type: 'connection-existing'; connectionId: string }
    | { type: 'connection-worktrees'; worktreeIds: string[] }
  prompt: string
  mode: AutoLaunchMode
  model: { providerID: string; modelID: string; variant?: string } | null
  sdk: HandoffAgentSdk
  codexFastMode: boolean
  goalMode: boolean
  goalSuccessCriteria: string | null
  customProviderId?: string | null
  /** NEW (optional): multi-model launch entries; [0] applies to the original ticket. */
  models?: PendingLaunchModelEntry[]
}

/**
 * Normalize a pending launch config into the list of model entries to launch.
 * Legacy configs (no `models`) yield a single entry from the top-level fields.
 */
export function resolveModelEntries(config: PendingLaunchConfig): LaunchModelConfig[] {
  if (config.models?.length) return config.models
  return [
    {
      sdk: config.sdk,
      model: config.model,
      codexFastMode: config.codexFastMode,
      customProviderId: config.customProviderId ?? null
    }
  ]
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

  // Connection-project tickets launch into a connection instance (new
  // worktrees, a specific worktree set, or a live instance) — the connection
  // pipeline owns everything.
  if (
    config.worktree.type === 'connection-new' ||
    config.worktree.type === 'connection-existing' ||
    config.worktree.type === 'connection-worktrees'
  ) {
    const { quickLaunchTicketOnConnectionProject } = await import(
      '@/lib/connection-project-launch'
    )
    const target =
      config.worktree.type === 'connection-existing'
        ? ({ type: 'existing-connection', connectionId: config.worktree.connectionId } as const)
        : config.worktree.type === 'connection-worktrees'
          ? ({ type: 'worktree-set', worktreeIds: config.worktree.worktreeIds } as const)
          : ({ type: 'new' } as const)
    const ok = await quickLaunchTicketOnConnectionProject(
      { id: ticket.id, project_id: ticket.project_id, title: ticket.title },
      {
        mode: config.mode,
        sdk: config.sdk,
        model: config.model,
        codexFastMode: config.codexFastMode,
        promptText: config.prompt,
        goalMode: configGoalMode,
        goalSuccessCriteria: configGoalSuccessCriteria
      },
      target
    )
    // quickLaunchTicketOnConnectionProject reports its own success/failure toasts.
    void ok
    return
  }

  // Auto-pin happens inside launchTicketWithModel once each worktree exists
  // ('current-branch' mode pins the launched worktree, not the base).
  const entries = resolveModelEntries(config)

  // Multiple models + a brand-new worktree: one worktree + duplicated ticket
  // per model, all launched by the background orchestrator. An EXISTING
  // worktree can only host one session, so multi-entry + existing worktree
  // keeps the single-path entries[0] behavior below.
  if (entries.length > 1 && config.worktree.type === 'new') {
    await runMultiModelLaunch({
      ticket: { id: ticket.id, title: ticket.title },
      projectId: ticket.project_id,
      prompt: config.prompt,
      mode: config.mode,
      sourceBranch: config.worktree.sourceBranch,
      goalMode: configGoalMode,
      goalSuccessCriteria: configGoalSuccessCriteria,
      entries
    })
    return
  }

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
