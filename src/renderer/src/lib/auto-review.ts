import { useSettingsStore } from '@/stores/useSettingsStore'

export interface AutoReviewPreferences {
  autoReview?: boolean
  autoReviewProjects?: Record<string, boolean>
  autoReviewTasks?: Record<string, boolean>
}

export function autoReviewTaskKey(projectId: string, ticketId: string): string {
  return JSON.stringify([projectId, ticketId])
}

export function resolveAutoReview(
  settings: AutoReviewPreferences,
  projectId?: string,
  ticketId?: string
): boolean {
  return (
    (projectId && ticketId
      ? settings.autoReviewTasks?.[autoReviewTaskKey(projectId, ticketId)]
      : undefined) ??
    (projectId ? settings.autoReviewProjects?.[projectId] : undefined) ??
    settings.autoReview ??
    true
  )
}

export function shouldAutoReview(projectId: string, ticketId: string): boolean {
  return resolveAutoReview(useSettingsStore.getState(), projectId, ticketId)
}
