import type {
  ClaudeTokenTally,
  FetchForAccountResult,
  OpenAIUsageResult,
  OpenAIResetCredits,
  OpenAIResetResult,
  RefreshAllResultItem,
  UsageResult,
  UsageProvider
} from '@shared/types/usage'
import {
  CLAUDE_CODE_MODE_USAGE_UNAVAILABLE_CHANNEL,
  CLAUDE_LIVE_USAGE_CHANNEL,
  CLAUDE_LIVE_USAGE_HEALTH_CHANNEL,
  isClaudeCodeModeUsageUnavailablePayload,
  isClaudeLiveUsageHealthPayload,
  isClaudeLiveUsagePayload,
  type ClaudeCodeModeUsageUnavailablePayload,
  type ClaudeLiveUsageHealthPayload,
  type ClaudeLiveUsagePayload
} from '@shared/types/claude-live-usage'
import type { ServerEvent } from '@shared/rpc/protocol'
import { getRendererRpcClient } from './rpc-client'

export const usageApi = {
  /**
   * Real-time Claude usage from the local API proxy: one event per observed
   * API response, already attributed to the account that made the request.
   */
  onClaudeLiveUsage: (callback: (payload: ClaudeLiveUsagePayload) => void): (() => void) =>
    getRendererRpcClient().subscribe(CLAUDE_LIVE_USAGE_CHANNEL, (event: ServerEvent) => {
      if (isClaudeLiveUsagePayload(event.payload)) callback(event.payload)
    }),
  /**
   * The debug log of a Code Mode session stopped giving usage readings, or
   * gives them again: its usage comes from the poll meanwhile.
   */
  onClaudeLiveUsageHealth: (
    callback: (payload: ClaudeLiveUsageHealthPayload) => void
  ): (() => void) =>
    getRendererRpcClient().subscribe(CLAUDE_LIVE_USAGE_HEALTH_CHANNEL, (event: ServerEvent) => {
      if (isClaudeLiveUsageHealthPayload(event.payload)) callback(event.payload)
    }),
  /**
   * Live usage in Code Mode was switched off for the installed version of the Claude CLI.
   * The cue to tell the person; it can come more than once, so claim the notice first.
   */
  onClaudeCodeModeUsageUnavailable: (
    callback: (payload: ClaudeCodeModeUsageUnavailablePayload) => void
  ): (() => void) =>
    getRendererRpcClient().subscribe(
      CLAUDE_CODE_MODE_USAGE_UNAVAILABLE_CHANNEL,
      (event: ServerEvent) => {
        if (isClaudeCodeModeUsageUnavailablePayload(event.payload)) callback(event.payload)
      }
    ),
  /**
   * The notice of that switch-off, for the one window that asks first: null to every other,
   * and when there is nothing to tell.
   */
  claimClaudeCodeModeUsageUnavailableNotice:
    async (): Promise<ClaudeCodeModeUsageUnavailablePayload | null> => {
      const notice = await getRendererRpcClient().request<unknown>(
        'usageOps.claimCodeModeUsageUnavailableNotice',
        {}
      )
      return isClaudeCodeModeUsageUnavailablePayload(notice) ? notice : null
    },
  listOpenaiResets: (accountId: string): Promise<OpenAIResetCredits> =>
    getRendererRpcClient().request('usageOps.listOpenaiResets', { accountId }),
  consumeOpenaiReset: (
    accountId: string,
    redeemRequestId: string,
    creditId?: string
  ): Promise<OpenAIResetResult> =>
    getRendererRpcClient().request('usageOps.consumeOpenaiReset', {
      accountId,
      redeemRequestId,
      ...(creditId ? { creditId } : {})
    }),
  fetch: async (): Promise<UsageResult> =>
    getRendererRpcClient().request<UsageResult>('usageOps.fetch', {}),
  fetchOpenai: async (): Promise<OpenAIUsageResult> =>
    getRendererRpcClient().request<OpenAIUsageResult>('usageOps.fetchOpenai', {}),
  refreshAllForProvider: async (
    provider: UsageProvider,
    excludeAccountIds?: string[],
    maxAgeMs?: number
  ): Promise<RefreshAllResultItem[]> =>
    getRendererRpcClient().request<RefreshAllResultItem[]>('usageOps.refreshAllForProvider', {
      provider,
      ...(excludeAccountIds ? { excludeAccountIds } : {}),
      ...(maxAgeMs !== undefined ? { maxAgeMs } : {})
    }),
  getClaudeTokenTally: async (): Promise<ClaudeTokenTally> =>
    getRendererRpcClient().request<ClaudeTokenTally>('usageOps.getClaudeTokenTally', {}),
  fetchForAccount: async (
    accountId: string,
    userInitiated?: boolean
  ): Promise<FetchForAccountResult> =>
    getRendererRpcClient().request<FetchForAccountResult>('usageOps.fetchForAccount', {
      accountId,
      userInitiated
    })
}
