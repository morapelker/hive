import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  useUsageStore,
  useAccountStore,
  useSessionStore,
  useLoginStore,
  resolveUsageProvider,
  resolveDefaultUsageProvider,
  normalizeUsage
} from '@/stores'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { reportActiveAccountsSnapshot } from '@/lib/hive-account-report'
import { fetchHiveAccountMembers, isHiveTelemetryEnabled } from '@/api/hive-enterprise/client'
import { MemberAvatarStack, type AccountMemberInfo } from './MemberAvatarStack'
import { cn } from '@/lib/utils'
import { Loader2, RefreshCw } from 'lucide-react'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'
import type {
  OpenAIUsageData,
  SavedAccountDTO,
  SavedUsageStatus,
  AnthropicRateLimitState,
  AnthropicRateLimitWindow,
  UsageData,
  UsageProvider
} from '@shared/types/usage'

function getBarColor(percent: number, rateLimitStatus?: string): string {
  if (rateLimitStatus === 'rejected') return 'bg-red-500'
  if (rateLimitStatus === 'allowed_warning') return 'bg-orange-500'
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 80) return 'bg-orange-500'
  if (percent >= 60) return 'bg-yellow-500'
  return 'bg-green-500'
}

function formatResetTime(
  isoString: string | null | undefined,
  type: 'five_hour' | 'seven_day'
): string {
  // null = window with no active session (idle 5h window); without this guard
  // new Date(null) silently renders the 1970 epoch as a real time.
  if (!isoString) return 'N/A'
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return ''

  const hours = date.getHours()
  const minutes = date.getMinutes()
  const ampm = hours >= 12 ? 'pm' : 'am'
  const hour12 = hours % 12 || 12
  const timeStr =
    minutes === 0 ? `${hour12}${ampm}` : `${hour12}:${String(minutes).padStart(2, '0')}${ampm}`

  if (type === 'five_hour') {
    return timeStr
  }

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]
  const month = months[date.getMonth()]
  const day = date.getDate()
  return `${month} ${day}, ${timeStr}`
}

// A reset time already in the past means the snapshot predates the window's
// reset — the utilization no longer reflects reality, so callers show N/A and
// an empty bar instead of a confidently-wrong percentage. null is NOT stale:
// it means "no active window" (see formatResetTime).
function isResetInPast(isoString: string | null | undefined): boolean {
  if (!isoString) return false
  const time = new Date(isoString).getTime()
  return !isNaN(time) && time < Date.now()
}

function usageWindowDisplay(
  window: { utilization: number; resets_at: string | null } | undefined,
  type: 'five_hour' | 'seven_day'
): { percent: number; resetTime: string } {
  if (!window || isResetInPast(window.resets_at)) return { percent: 0, resetTime: 'N/A' }
  return {
    percent: Math.round(window.utilization),
    resetTime: formatResetTime(window.resets_at, type)
  }
}

function formatRelativeReset(resetsAt: number): string {
  const seconds = Math.max(0, Math.ceil(resetsAt - Date.now() / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.ceil((seconds % 3600) / 60)

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return '<1m'
}

function getStatusLabel(status?: string): string | null {
  if (status === 'rejected') return 'blocked'
  if (status === 'allowed_warning') return 'warning'
  return null
}

function getRateLimitWindow(
  rateLimit: AnthropicRateLimitState | null,
  type: 'five_hour' | 'seven_day'
): AnthropicRateLimitWindow | undefined {
  if (!rateLimit) return undefined
  return type === 'five_hour' ? rateLimit.fiveHour : rateLimit.sevenDay
}

interface UsageRowProps {
  label: string
  percent: number
  resetTime: string
  rateLimit?: AnthropicRateLimitWindow
  labelClassName?: string
}

function UsageRow({
  label,
  percent,
  resetTime,
  rateLimit,
  labelClassName
}: UsageRowProps): React.JSX.Element {
  const statusLabel = getStatusLabel(rateLimit?.status)
  const displayedPercent = rateLimit?.status === 'rejected' ? 100 : percent
  const percentLabel = rateLimit?.status === 'rejected' ? 'limit' : `${Math.round(percent)}%`
  const statusTitle =
    statusLabel && rateLimit
      ? `${statusLabel} - resets in ${formatRelativeReset(rateLimit.resetsAt)}`
      : undefined

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          'text-[10px] text-muted-foreground shrink-0 truncate',
          labelClassName ?? 'w-5'
        )}
        title={label}
      >
        {label}
      </span>
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            getBarColor(displayedPercent, rateLimit?.status)
          )}
          style={{ width: `${Math.min(100, Math.max(0, displayedPercent))}%`, minWidth: 2 }}
        />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-7 text-right shrink-0">
        {percentLabel}
      </span>
      <span className="text-[10px] text-muted-foreground/60 shrink-0">{resetTime}</span>
      {statusLabel && (
        <span
          className={cn(
            'rounded-sm px-1 py-0.5 text-[9px] leading-none shrink-0',
            rateLimit?.status === 'rejected'
              ? 'bg-red-500/15 text-red-400'
              : 'bg-orange-500/15 text-orange-400'
          )}
          title={statusTitle}
        >
          {rateLimit?.status === 'rejected' ? 'limit' : 'warn'}
        </span>
      )}
    </div>
  )
}

interface AccountRowData {
  id: string
  email: string | null
  usage: UsageData | null
  status: SavedUsageStatus
  lastError: string | null
  isActive: boolean
  isRefreshing: boolean
}

function usageFromSavedAccount(
  provider: UsageProvider,
  account: SavedAccountDTO
): UsageData | null {
  if (!account.last_usage) return null
  if (provider === 'anthropic') {
    return normalizeUsage(provider, account.last_usage as UsageData, null)
  }
  return normalizeUsage(provider, null, account.last_usage as OpenAIUsageData)
}

export interface UsageAccountRowProps {
  row: AccountRowData
  isSwitching?: boolean
  isLoginActive?: boolean
  highlightActive?: boolean
  onSwitch?: () => void
  onRefresh?: () => void
  onSignInAgain?: () => void
  members?: AccountMemberInfo[]
  membersLoading?: boolean
}

export function UsageAccountRow({
  row,
  isSwitching = false,
  isLoginActive = false,
  highlightActive = false,
  onSwitch,
  onRefresh,
  onSignInAgain,
  members,
  membersLoading = false
}: UsageAccountRowProps): React.JSX.Element {
  const fiveHour = usageWindowDisplay(row.usage?.five_hour, 'five_hour')
  const sevenDay = usageWindowDisplay(row.usage?.seven_day, 'seven_day')
  const scoped = row.usage?.scoped ?? []

  return (
    <div
      className={cn(
        'relative rounded-md border border-border/50 bg-background/40 px-2 py-1.5',
        highlightActive && row.isActive && 'border-2 border-purple-500'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div
          className={cn(
            'min-w-0 truncate text-[11px] text-foreground',
            row.isActive && 'font-semibold'
          )}
        >
          {row.email ?? 'Active account'}
        </div>
        <MemberAvatarStack members={members} loading={membersLoading} />
        {row.isActive && (
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
            Active
          </span>
        )}
      </div>

      {row.status === 'stale' && (
        <div className="mt-1 text-[10px] text-destructive">expired - sign in again</div>
      )}
      {row.status === 'error' && row.lastError && (
        <div className="mt-1 truncate text-[10px] text-destructive/90">{row.lastError}</div>
      )}

      <div className={cn('mt-1 space-y-0.5', row.status === 'stale' && 'opacity-50')}>
        <UsageRow label="5h" percent={fiveHour.percent} resetTime={fiveHour.resetTime} />
        <UsageRow label="7d" percent={sevenDay.percent} resetTime={sevenDay.resetTime} />
        {scoped.map((entry) => {
          const display = usageWindowDisplay(
            { utilization: entry.used_percent, resets_at: entry.resets_at },
            'seven_day'
          )
          return (
            <UsageRow
              key={entry.label}
              label={entry.label}
              percent={display.percent}
              resetTime={display.resetTime}
              labelClassName="w-10"
            />
          )
        })}
      </div>

      {(onSwitch || onRefresh || onSignInAgain) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {!row.isActive && onSwitch && (
            <button
              type="button"
              onClick={onSwitch}
              disabled={isSwitching}
              aria-label={`Switch to ${row.email ?? 'this account'}`}
              className="inline-flex items-center gap-1 rounded-sm border border-border/60 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSwitching && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
              Switch
            </button>
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={row.isRefreshing}
              aria-label={`Refresh usage for ${row.email ?? 'this account'}`}
              className="inline-flex items-center gap-1 rounded-sm border border-border/60 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {row.isRefreshing ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <RefreshCw className="h-2.5 w-2.5" />
              )}
              Refresh
            </button>
          )}
          {row.status === 'stale' && onSignInAgain && (
            <button
              type="button"
              onClick={onSignInAgain}
              disabled={isLoginActive}
              aria-label={`Sign in again as ${row.email ?? 'this account'}`}
              className="inline-flex items-center gap-1 rounded-sm border border-destructive/40 px-1.5 py-0.5 text-[9px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Sign in again
            </button>
          )}
        </div>
      )}

      {row.isRefreshing && (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-background/60">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  )
}

function findSessionById(sessionId: string): {
  agent_sdk?: string | null
  model_provider_id?: string | null
  model_id?: string | null
} | null {
  const state = useSessionStore.getState()
  for (const sessions of state.sessionsByWorktree.values()) {
    const session = sessions.find((s) => s.id === sessionId)
    if (session) return session
  }
  for (const sessions of state.sessionsByConnection.values()) {
    const session = sessions.find((s) => s.id === sessionId)
    if (session) return session
  }
  return null
}

const PROVIDER_ORDER: UsageProvider[] = ['anthropic', 'openai']

function getVisibleProviders(
  mode: 'current-agent' | 'specific-providers',
  selectedProviders: UsageProvider[],
  activeProvider: UsageProvider
): UsageProvider[] {
  if (mode === 'current-agent') return [activeProvider]
  return PROVIDER_ORDER.filter((p) => selectedProviders.includes(p))
}

interface AccountMembersMapState {
  membersByAccount: Map<string, AccountMemberInfo[]> | null
  loading: boolean
  refresh: () => void
}

/**
 * Fresh-fetch-on-hover for the popover's member avatar stack. Every hover
 * (mouseenter/focus on either HoverCard trigger) calls `refresh()`, which
 * re-fetches the full org mapping and rebuilds a `provider:email` (lowercase)
 * -> members lookup. No launch fetch, no TTL cache — intentionally always
 * fresh per the product decision that staleness here is confusing (a member
 * could have switched accounts seconds ago).
 */
function useAccountMembersMap(): AccountMembersMapState {
  const [membersByAccount, setMembersByAccount] = useState<Map<
    string,
    AccountMemberInfo[]
  > | null>(null)
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback((): void => {
    if (loadingRef.current) return
    if (!isHiveTelemetryEnabled(useSettingsStore.getState())) return

    loadingRef.current = true
    setLoading(true)
    void fetchHiveAccountMembers()
      .then((entries) => {
        const map = new Map<string, AccountMemberInfo[]>()
        for (const entry of entries ?? []) {
          const key = `${entry.provider}:${entry.accountEmail.toLowerCase()}`
          const info: AccountMemberInfo = {
            id: entry.member.id,
            email: entry.member.email,
            name: entry.member.name ?? null,
            picture: entry.member.picture ?? null
          }
          const existing = map.get(key)
          if (existing) existing.push(info)
          else map.set(key, [info])
        }
        if (mountedRef.current) setMembersByAccount(map)
      })
      .finally(() => {
        loadingRef.current = false
        if (mountedRef.current) setLoading(false)
      })
  }, [])

  return { membersByAccount, loading, refresh }
}

function ProviderUsageBlock({
  provider,
  isExplicitlySelected
}: {
  provider: UsageProvider
  isExplicitlySelected: boolean
}): React.JSX.Element | null {
  const anthropicUsage = useUsageStore((s) => s.anthropicUsage)
  const anthropicRateLimit = useUsageStore((s) => s.anthropicRateLimit)
  const openaiUsage = useUsageStore((s) => s.openaiUsage)
  const forceRefreshProvider = useUsageStore((s) => s.forceRefreshProvider)
  const refreshAllForProvider = useUsageStore((s) => s.refreshAllForProvider)
  const loadSavedAccounts = useUsageStore((s) => s.loadSavedAccounts)
  const switchAccount = useUsageStore((s) => s.switchAccount)
  const refreshSavedAccount = useUsageStore((s) => s.refreshSavedAccount)
  const switchingAccountIds = useUsageStore((s) => s.switchingAccountIds)
  const savedAccounts = useUsageStore((s) => s.savedAccounts[provider])
  const savedAccountLoadError = useUsageStore((s) => s.savedAccountLoadErrors[provider])
  const refreshingProvider = useUsageStore((s) => s.refreshingProviders[provider])
  const refreshingAccountIds = useUsageStore((s) => s.refreshingAccountIds)
  const isLoading = useUsageStore((s) =>
    provider === 'anthropic' ? s.anthropicIsLoading : s.openaiIsLoading
  )
  const lastError = useUsageStore((s) =>
    provider === 'anthropic' ? s.anthropicLastError : s.openaiLastError
  )
  const retryAfter = useUsageStore((s) =>
    provider === 'anthropic' ? s.anthropicLastRetryAfter : null
  )
  const email = useAccountStore((s) =>
    provider === 'anthropic' ? s.anthropicEmail : s.openaiEmail
  )
  const fetchEmail = useAccountStore((s) => s.fetchEmail)
  const startLogin = useLoginStore((s) => s.startLogin)
  const isLoginActive = useLoginStore((s) => s.activeLogin !== null)
  const telemetryEnabled = useSettingsStore((s) => isHiveTelemetryEnabled(s))
  const {
    membersByAccount,
    loading: membersLoading,
    refresh: refreshMembers
  } = useAccountMembersMap()

  const usage = normalizeUsage(provider, anthropicUsage, openaiUsage)

  const providerIcon = provider === 'anthropic' ? claudeIcon : openaiIcon
  const providerLabel = provider === 'anthropic' ? 'Claude' : 'OpenAI'
  const tooltipTitle = provider === 'anthropic' ? 'Claude API Usage' : 'OpenAI API Usage'
  const iconIsRefreshing = isLoading || refreshingProvider

  const accountRows: AccountRowData[] =
    savedAccounts.length > 0
      ? savedAccounts.map((account) => ({
          id: account.id,
          email: account.email,
          usage: usageFromSavedAccount(provider, account),
          status: account.status,
          lastError: account.last_error,
          isActive: email !== null && account.email === email,
          isRefreshing: refreshingAccountIds.has(account.id)
        }))
      : [
          {
            id: `${provider}-active`,
            email,
            usage,
            status: 'ok',
            lastError: null,
            isActive: !!email,
            isRefreshing: false
          }
        ]

  // With multiple accounts, the active one goes last and gets a purple border
  // so it reads as "currently active" at a glance.
  const orderedRows = [...accountRows].sort((a, b) => Number(a.isActive) - Number(b.isActive))
  const highlightActive = accountRows.length > 1

  const handleRefreshActive = (): void => {
    forceRefreshProvider(provider)
    void fetchEmail(provider).then(() => reportActiveAccountsSnapshot())
  }

  const handleRefreshAll = (event: React.MouseEvent): void => {
    event.preventDefault()
    refreshAllForProvider(provider)
  }

  const handleLoadSavedAccounts = (): void => {
    loadSavedAccounts(provider).catch(() => {})
    refreshMembers()
  }

  const membersFor = (rowEmail: string | null): AccountMemberInfo[] | undefined => {
    if (!telemetryEnabled) return undefined
    return membersByAccount?.get(`${provider}:${rowEmail?.toLowerCase() ?? ''}`) ?? []
  }

  // The active account sorts last, so open the popover scrolled to the bottom
  // to keep it in view when many accounts overflow the max height.
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const scrollPopoverToBottom = useCallback((node: HTMLDivElement | null): void => {
    popoverRef.current = node
    if (node) node.scrollTop = node.scrollHeight
  }, [])

  // Saved accounts load async on hover and can land after the popover mounts,
  // growing the content past the initial scroll position.
  useEffect(() => {
    const node = popoverRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [savedAccounts.length])

  useEffect(() => {
    loadSavedAccounts(provider).catch(() => {})
  }, [loadSavedAccounts, provider])

  // No credentials state — show muted N/A bars when explicitly selected
  if (!usage) {
    if (!isExplicitlySelected) return null
    return (
      <HoverCard>
        <HoverCardTrigger asChild>
          <div
            className="px-3 py-1.5 space-y-0.5 cursor-default opacity-40"
            onMouseEnter={handleLoadSavedAccounts}
            onFocus={handleLoadSavedAccounts}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="shrink-0 cursor-pointer bg-transparent border-none p-0"
                onClick={handleRefreshActive}
                onContextMenu={handleRefreshAll}
                aria-label={`Refresh ${providerLabel} usage`}
              >
                <img
                  src={providerIcon}
                  alt={providerLabel}
                  className={cn(
                    'h-3 w-3 opacity-50 hover:opacity-80 transition-opacity',
                    iconIsRefreshing && 'animate-spin'
                  )}
                />
              </button>
              <div className="flex-1 space-y-0.5">
                <UsageRow label="5h" percent={0} resetTime="N/A" />
                <UsageRow label="7d" percent={0} resetTime="N/A" />
              </div>
            </div>
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          sideOffset={8}
          className="w-72 max-w-[min(18rem,calc(100vw-2rem))]"
        >
          <div className="space-y-2">
            <div className="font-medium">{tooltipTitle}</div>
            {savedAccountLoadError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
                Saved accounts unavailable: {savedAccountLoadError}
              </div>
            )}
            {accountRows.some((row) => row.email || row.usage) ? (
              orderedRows.map((row) => (
                <UsageAccountRow
                  key={row.id}
                  row={row}
                  isSwitching={switchingAccountIds.has(row.id)}
                  isLoginActive={isLoginActive}
                  highlightActive={highlightActive}
                  onSwitch={() => switchAccount(row.id)}
                  onRefresh={
                    savedAccounts.length > 0
                      ? () => refreshSavedAccount(row.id, { userInitiated: true })
                      : undefined
                  }
                  onSignInAgain={() => startLogin(provider, row.email ?? undefined)}
                  members={membersFor(row.email)}
                  membersLoading={membersLoading}
                />
              ))
            ) : (
              <div className="text-[10px]">No credentials configured</div>
            )}
            {lastError && (
              <div className="text-[10px] text-red-400 border-t border-background/20 pt-1">
                {retryAfter !== null
                  ? `Rate limited - retry in ${retryAfter}s`
                  : `Refresh failed: ${lastError}`}
              </div>
            )}
          </div>
        </HoverCardContent>
      </HoverCard>
    )
  }

  const fiveHour = usageWindowDisplay(usage.five_hour, 'five_hour')
  const sevenDay = usageWindowDisplay(usage.seven_day, 'seven_day')
  const extra = usage.extra_usage
  const fiveHourRateLimit =
    provider === 'anthropic' ? getRateLimitWindow(anthropicRateLimit, 'five_hour') : undefined
  const sevenDayRateLimit =
    provider === 'anthropic' ? getRateLimitWindow(anthropicRateLimit, 'seven_day') : undefined

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <div
          className="px-3 py-1.5 space-y-0.5 cursor-default"
          onMouseEnter={handleLoadSavedAccounts}
          onFocus={handleLoadSavedAccounts}
        >
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="shrink-0 cursor-pointer bg-transparent border-none p-0"
              onClick={handleRefreshActive}
              onContextMenu={handleRefreshAll}
              aria-label={`Refresh ${providerLabel} usage`}
            >
              <img
                src={providerIcon}
                alt={providerLabel}
                className={cn(
                  'h-3 w-3 opacity-50 hover:opacity-80 transition-opacity',
                  iconIsRefreshing && 'animate-spin'
                )}
              />
            </button>
            <div className="flex-1 space-y-0.5">
              <UsageRow
                label="5h"
                percent={fiveHour.percent}
                resetTime={fiveHour.resetTime}
                rateLimit={fiveHourRateLimit}
              />
              <UsageRow
                label="7d"
                percent={sevenDay.percent}
                resetTime={sevenDay.resetTime}
                rateLimit={sevenDayRateLimit}
              />
            </div>
          </div>
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        ref={scrollPopoverToBottom}
        side="top"
        sideOffset={8}
        collisionPadding={8}
        className="w-72 max-w-[min(18rem,calc(100vw-2rem))] max-h-(--radix-hover-card-content-available-height) overflow-y-auto"
      >
        <div className="space-y-2">
          <div className="font-medium">{tooltipTitle}</div>
          {savedAccountLoadError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
              Saved accounts unavailable: {savedAccountLoadError}
            </div>
          )}
          {orderedRows.map((row) => (
            <UsageAccountRow
              key={row.id}
              row={row}
              isSwitching={switchingAccountIds.has(row.id)}
              isLoginActive={isLoginActive}
              highlightActive={highlightActive}
              onSwitch={() => switchAccount(row.id)}
              onRefresh={
                savedAccounts.length > 0
                  ? () => refreshSavedAccount(row.id, { userInitiated: true })
                  : undefined
              }
              onSignInAgain={() => startLogin(provider, row.email ?? undefined)}
              members={membersFor(row.email)}
              membersLoading={membersLoading}
            />
          ))}
          {provider === 'anthropic' && extra?.is_enabled && (
            <div className="border-t border-background/20 pt-1 text-[10px]">
              Extra: ${(extra.used_credits ?? 0).toFixed(2)} / $
              {(extra.monthly_limit ?? 0).toFixed(2)} used ({Math.round(extra.utilization ?? 0)}%)
            </div>
          )}
          {provider === 'anthropic' && (fiveHourRateLimit || sevenDayRateLimit) && (
            <div className="border-t border-background/20 pt-1 text-[10px] text-muted-foreground">
              {fiveHourRateLimit && (
                <div>
                  5h: {fiveHourRateLimit.status} - resets in{' '}
                  {formatRelativeReset(fiveHourRateLimit.resetsAt)}
                </div>
              )}
              {sevenDayRateLimit && (
                <div>
                  7d: {sevenDayRateLimit.status} - resets in{' '}
                  {formatRelativeReset(sevenDayRateLimit.resetsAt)}
                </div>
              )}
            </div>
          )}
          {lastError && (
            <div className="text-[10px] text-red-400 border-t border-background/20 pt-1">
              {retryAfter !== null
                ? `Rate limited - retry in ${retryAfter}s`
                : `Refresh failed: ${lastError}`}
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

export function UsageIndicator(): React.JSX.Element | null {
  const usageIndicatorMode = useSettingsStore((s) => s.usageIndicatorMode)
  const usageIndicatorProviders = useSettingsStore((s) => s.usageIndicatorProviders)

  const activeProvider = useUsageStore((s) => s.activeProvider)
  const fetchUsageForProvider = useUsageStore((s) => s.fetchUsageForProvider)
  const loadSavedAccounts = useUsageStore((s) => s.loadSavedAccounts)
  const setActiveProvider = useUsageStore((s) => s.setActiveProvider)
  const fetchEmail = useAccountStore((s) => s.fetchEmail)

  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  // Detect provider from active session and fetch all visible providers on worktree switch.
  // setActiveProvider fetches the detected provider internally (if stale).
  // We additionally fetch every visible provider so pinned bars stay fresh.
  // fetchUsageForProvider is debounce-safe, so overlapping calls are no-ops.
  useEffect(() => {
    if (activeSessionId) {
      const session = findSessionById(activeSessionId)
      if (session) {
        const provider = resolveUsageProvider(session)
        setActiveProvider(provider)
      } else {
        // BOARD_TAB_ID or stale session — fall back to default SDK
        const { defaultAgentSdk } = useSettingsStore.getState()
        setActiveProvider(resolveDefaultUsageProvider(defaultAgentSdk))
      }
    } else {
      // No session at all — resolve from defaultAgentSdk setting
      const { defaultAgentSdk } = useSettingsStore.getState()
      setActiveProvider(resolveDefaultUsageProvider(defaultAgentSdk))
    }

    // Read settings via getState() to avoid array-ref dep churn
    const { usageIndicatorMode: mode, usageIndicatorProviders: selected } =
      useSettingsStore.getState()
    const current = useUsageStore.getState().activeProvider
    getVisibleProviders(mode, selected, current).forEach((p) => {
      loadSavedAccounts(p).catch(() => {})
      fetchUsageForProvider(p)
      fetchEmail(p)
    })
    // Deduped heartbeat carrier — reportActiveAccountsSnapshot itself owns the
    // change-detection and 1h-heartbeat gating, this is just another trigger.
    void reportActiveAccountsSnapshot()
  }, [activeSessionId, setActiveProvider, fetchUsageForProvider, fetchEmail, loadSavedAccounts])

  const visibleProviders = getVisibleProviders(
    usageIndicatorMode,
    usageIndicatorProviders,
    activeProvider
  )

  if (visibleProviders.length === 0) return null

  const isExplicitlySelected = usageIndicatorMode === 'specific-providers'

  return (
    <div className="border-t" data-testid="usage-indicator">
      {visibleProviders.map((provider, i) => (
        <React.Fragment key={provider}>
          {i > 0 && <div className="border-t border-border/50 mx-3" />}
          <ProviderUsageBlock provider={provider} isExplicitlySelected={isExplicitlySelected} />
        </React.Fragment>
      ))}
    </div>
  )
}
