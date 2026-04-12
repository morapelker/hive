import type { KanbanTicket } from '../../../../main/db/types'
import type { PendingLaunchConfig } from '../../../../main/db/types'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { PLAN_MODE_PREFIX, SUPER_PLAN_MODE_PREFIX, isPlanLike } from '@/lib/constants'
import { toast } from '@/lib/toast'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'

export async function autoLaunchTicket(ticket: KanbanTicket): Promise<void> {
  if (!ticket.pending_launch_config) return

  let config: PendingLaunchConfig
  try {
    config = JSON.parse(ticket.pending_launch_config) as PendingLaunchConfig
  } catch {
    console.error('Failed to parse pending_launch_config for ticket:', ticket.id)
    return
  }

  const project = useProjectStore.getState().projects.find(p => p.id === ticket.project_id)
  if (!project) {
    console.error('Project not found for auto-launch:', ticket.project_id)
    return
  }

  try {
    // 1. Resolve worktree
    let worktreeId: string
    if (config.worktree.type === 'new') {
      const nameHint = canonicalizeTicketTitle(ticket.title)
      const result = await useWorktreeStore.getState().createWorktreeFromBranch(
        ticket.project_id,
        project.path,
        project.name,
        config.worktree.sourceBranch,
        nameHint || undefined
      )
      if (!result.success || !result.worktree?.id) {
        toast.error(`Auto-launch failed: ${result.error || 'Could not create worktree'}`)
        return
      }
      worktreeId = result.worktree.id
    } else {
      worktreeId = config.worktree.worktreeId
    }

    // 2. Create session
    const sessionResult = await useSessionStore.getState().createSession(
      worktreeId,
      ticket.project_id,
      config.sdk,
      config.mode,
      { autoFocus: false }
    )
    if (!sessionResult.success || !sessionResult.session) {
      toast.error(`Auto-launch failed: ${sessionResult.error || 'Could not create session'}`)
      return
    }

    const sessionId = sessionResult.session.id
    const sessionAgentSdk = sessionResult.session.agent_sdk

    // 3. Set status tracking
    messageSendTimes.set(sessionId, Date.now())
    userExplicitSendTimes.set(sessionId, Date.now())
    snapshotTokenBaseline(sessionId)
    lastSendMode.set(sessionId, config.mode)
    useWorktreeStatusStore.getState().setSessionStatus(
      sessionId,
      isPlanLike(config.mode) ? 'planning' : 'working'
    )

    // 4. Apply model override
    const effectiveModel = config.model ?? undefined
    if (config.model) {
      await useSessionStore.getState().setSessionModel(sessionId, config.model)
    }

    // 5. Update ticket: clear pending config, set session + worktree
    await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, {
      pending_launch_config: null,
      current_session_id: sessionId,
      worktree_id: worktreeId,
      mode: config.mode
    })

    // 6. Trigger usage refresh
    useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(config.sdk))

    // 7. Toast notification
    toast.success(`Auto-launched: ${ticket.title}`)

    // 8. Connect to OpenCode and send prompt
    const allWorktrees = Array.from(useWorktreeStore.getState().worktreesByProject.values()).flat()
    const worktree = allWorktrees.find(w => w.id === worktreeId)
    if (!worktree?.path) return

    const connectResult = await window.opencodeOps.connect(worktree.path, sessionId)
    if (!connectResult.success || !connectResult.sessionId) return

    useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
    await window.db.session.update(sessionId, { opencode_session_id: connectResult.sessionId })

    // 9. Send prompt
    if (config.prompt.trim()) {
      const skipPrefix = sessionAgentSdk === 'claude-code' || sessionAgentSdk === 'codex'
      const modePrefix =
        config.mode === 'super-plan' ? SUPER_PLAN_MODE_PREFIX
        : config.mode === 'plan' && !skipPrefix ? PLAN_MODE_PREFIX
        : ''
      const fullPrompt = modePrefix + config.prompt.trim()
      const promptOptions =
        sessionAgentSdk === 'codex' ? { codexFastMode: config.codexFastMode } : undefined

      if (config.mode === 'super-plan') {
        useSessionStore.getState().setSessionMode(sessionId, 'plan')
      }

      await window.opencodeOps.prompt(worktree.path, connectResult.sessionId, [
        { type: 'text', text: fullPrompt }
      ], effectiveModel, promptOptions)
    }
  } catch (err) {
    console.error('Auto-launch failed for ticket:', ticket.id, err)
    toast.error(`Auto-launch failed for: ${ticket.title}`)
  }
}
