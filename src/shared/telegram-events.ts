export const TELEGRAM_STATUS_CHANGED_CHANNEL = 'telegram:statusChanged'
export const TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL = 'telegram:planImplementRequested'

export interface TelegramPlanImplementRequestedPayload {
  readonly sessionId: string
  readonly worktreeId: string | null
  readonly connectionId: string | null
  readonly requestId: string
  readonly plan: string
}
