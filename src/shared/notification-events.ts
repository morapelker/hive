export const NOTIFICATION_NAVIGATE_CHANNEL = 'notification:navigate'

export interface NotificationNavigatePayload {
  readonly projectId: string
  readonly worktreeId: string
  readonly sessionId: string
}
