import { useKanbanStore } from '@/stores/useKanbanStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { resolveModelForSdk } from '@/stores/useSettingsStore'
import { toast } from '@/lib/toast'
import { launchTicketWithModel, type LaunchModelConfig } from '@/lib/ticket-launch'
import { canonicalizeModelSlug, canonicalizeTicketTitle } from '@shared/types/branch-utils'
import { FALLBACK_MODELS } from '@shared/model-resolution'
import type { KanbanTicket } from '../../../main/db/types'

type LaunchMode = 'build' | 'plan' | 'super-plan'

export interface MultiModelLaunchPlan {
  /** The original ticket — becomes entries[0]'s ticket. */
  ticket: { id: string; title: string }
  projectId: string
  prompt: string
  mode: LaunchMode
  sourceBranch: string
  goalMode: boolean
  goalSuccessCriteria: string | null
  /** N >= 2; entries[0] applies to the original ticket, entries[1..] to duplicates. */
  entries: LaunchModelConfig[]
  /** True when invoked from the auto-launch seam (clears pending_launch_config on the original ticket). */
  clearPendingConfig?: boolean
}

interface EffectiveModel {
  providerID: string
  modelID: string
  variant: string | null
}

/**
 * Resolve the provider/model/variant to launch and stamp on the ticket badge,
 * same chain launchTicketWithModel falls back to when no session row exists
 * yet: explicit config model -> per-SDK resolution -> hard SDK fallback.
 */
function resolveEffectiveModel(entry: LaunchModelConfig): EffectiveModel {
  const resolved = entry.model ?? resolveModelForSdk(entry.sdk) ?? FALLBACK_MODELS[entry.sdk]
  return {
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    variant: resolved.variant ?? null
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Background orchestrator for launching one ticket per model. Makes all N
 * tickets appear in In Progress immediately (original + duplicates), then
 * launches each model sequentially — a plain awaited for-loop, never
 * parallel, since worktree creation serializes anyway. A single model's
 * failure (duplicate or launch) is toasted and does not block the rest.
 *
 * The whole body is wrapped in try/catch: `updateTicket`/`duplicateTicket`
 * rethrow on RPC failure (useKanbanStore), and this function is fired with
 * `void` at the call site (no `.catch`), so an unguarded throw here would be
 * an unhandled rejection that silently kills the rest of the batch. Every
 * throw is toasted instead — this function never rethrows.
 */
export async function runMultiModelLaunch(plan: MultiModelLaunchPlan): Promise<void> {
  try {
    const variantGroupId = crypto.randomUUID()
    const effectiveModels = plan.entries.map(resolveEffectiveModel)
    const goalSuccessCriteria = plan.goalMode ? plan.goalSuccessCriteria : null

    // All N sort orders land adjacent above the current top of In Progress,
    // in row order (entry 0 topmost): base is one below today's top, and each
    // subsequent entry gets a fraction of a step below that.
    const inProgressTickets = useKanbanStore
      .getState()
      .getTicketsByColumn(plan.projectId, 'in_progress')
    const base = useKanbanStore.getState().computeSortOrder(inProgressTickets, 0)
    const sortOrders = plan.entries.map((_, i) => base + i / plan.entries.length)

    // Original ticket appears immediately as entry 0. Also detaches any stale
    // session/worktree link from a previous launch of this ticket — otherwise
    // a late event for that old session (e.g. it completes mid-batch) could
    // yank this ticket around while the new launch is still in flight.
    await useKanbanStore.getState().updateTicket(plan.ticket.id, plan.projectId, {
      column: 'in_progress',
      sort_order: sortOrders[0],
      mode: plan.mode,
      plan_ready: false,
      current_session_id: null,
      worktree_id: null,
      model_provider_id: effectiveModels[0].providerID,
      model_id: effectiveModels[0].modelID,
      model_variant: effectiveModels[0].variant,
      variant_group_id: variantGroupId,
      goal_mode: plan.goalMode,
      goal_success_criteria: goalSuccessCriteria,
      ...(plan.clearPendingConfig ? { pending_launch_config: null } : {})
    })

    // Duplicates appear immediately as entries 1..N-1. A failed duplicate
    // (either a `null` return or a thrown RPC error) skips that model's
    // launch (ticketIds[i] stays null) but doesn't block the rest.
    const ticketIds: (string | null)[] = [plan.ticket.id]
    for (let i = 1; i < plan.entries.length; i++) {
      const model = effectiveModels[i]
      let duplicate: KanbanTicket | null = null
      try {
        duplicate = await useKanbanStore
          .getState()
          .duplicateTicket(plan.projectId, plan.ticket.id, {
            column: 'in_progress',
            sort_order: sortOrders[i],
            model_provider_id: model.providerID,
            model_id: model.modelID,
            model_variant: model.variant,
            variant_group_id: variantGroupId
          })
      } catch (err) {
        console.error(`Failed to duplicate ticket for ${model.modelID}`, err)
      }
      if (!duplicate) {
        toast.error(`Failed to duplicate ticket for ${model.modelID}`)
        ticketIds.push(null)
        continue
      }
      ticketIds.push(duplicate.id)
    }

    // Sequential launches — never parallel, git worktree creation serializes anyway.
    const titleSlug = canonicalizeTicketTitle(plan.ticket.title)
    for (let i = 0; i < plan.entries.length; i++) {
      const ticketId = ticketIds[i]
      if (!ticketId) continue

      const model = effectiveModels[i]
      const modelSlug = canonicalizeModelSlug(model.modelID)
      const nameHint = titleSlug ? `${titleSlug}-${modelSlug}` : modelSlug

      const result = await launchTicketWithModel({
        ticketId,
        projectId: plan.projectId,
        ticketTitle: plan.ticket.title,
        worktree: { type: 'new', sourceBranch: plan.sourceBranch, nameHint },
        prompt: plan.prompt,
        mode: plan.mode,
        modelConfig: plan.entries[i],
        goalMode: plan.goalMode,
        goalSuccessCriteria: plan.goalSuccessCriteria,
        // The pipeline's success update nulls variant_group_id by default
        // (single-launch hygiene) — re-stamp it here so multi-launched
        // tickets keep their shared group id.
        ticketUpdateExtras: { variant_group_id: variantGroupId }
      })

      if (!result.success) {
        toast.error(`Failed to launch ${model.modelID}: ${result.error}`)
        // The recovery update gets its own try/catch so a board-update
        // failure here never aborts the loop — the next entry must still launch.
        try {
          // Re-read To Do from the store — an earlier failure in this same loop
          // may have already moved a ticket there.
          const todoTickets = useKanbanStore.getState().getTicketsByColumn(plan.projectId, 'todo')
          const todoSortOrder = useKanbanStore.getState().computeSortOrder(todoTickets, 0)
          await useKanbanStore.getState().updateTicket(ticketId, plan.projectId, {
            column: 'todo',
            sort_order: todoSortOrder,
            current_session_id: null,
            worktree_id: null,
            plan_ready: false,
            mode: null,
            goal_mode: false,
            goal_success_criteria: null,
            model_provider_id: null,
            model_id: null,
            model_variant: null
            // variant_group_id intentionally kept — inert in v1.
          })
        } catch (err) {
          console.error(`Failed to move ${model.modelID} back to To Do after launch failure`, err)
          toast.error(`Failed to reset ${model.modelID} after launch failure: ${errorMessage(err)}`)
        }
      }
    }

    // Usage refresh once per distinct SDK among entries.
    const distinctSdks = new Set(plan.entries.map((entry) => entry.sdk))
    for (const sdk of distinctSdks) {
      useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(sdk))
    }
  } catch (err) {
    console.error(`Multi-model launch failed for "${plan.ticket.title}"`, err)
    toast.error(`Failed to launch "${plan.ticket.title}": ${errorMessage(err)}`)
  }
}
