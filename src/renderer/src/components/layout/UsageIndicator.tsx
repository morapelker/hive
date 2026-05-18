import React, { useEffect } from 'react'
import {
  useUsageStore,
  useAccountStore,
  useSessionStore,
  resolveUsageProvider,
  resolveDefaultUsageProvider,
  normalizeUsage
} from '@/stores'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'
import type {
  OpenAIUsageData,
  SavedAccountDTO,
  UsageData,
  UsageProvider
} from '@shared/types/usage'

function getBarColor(percent: number): string {
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 80) return 'bg-orange-500'
  if (percent >= 60) return 'bg-yellow-500'
  return 'bg-green-500'
}

function formatResetTime(isoString: string, type: 'five_hour' | 'seven_day'): string {
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

interface UsageRowProps {
  label: string
  percent: number
  resetTime: string
}

function UsageRow({ label, percent, resetTime }: UsageRowProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground w-5 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-300', getBarColor(percent))}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%`, minWidth: 2 }}
        />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-7 text-right shrink-0">
        {Math.round(percent)}%
      </span>
      <span className="text-[10px] text-muted-foreground/60 shrink-0">{resetTime}</span>
    </div>
  )
}

interface TooltipAccountRow {
  id: string
  email: string | null
  usage: UsageData | null
  status: 'ok' | 'stale' | 'error'
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

function UsageTooltipAccountRow({ row }: { row: TooltipAccountRow }): React.JSX.Element {
  const fiveHourPercent = row.usage ? Math.round(row.usage.five_hour.utilization) : 0
  const sevenDayPercent = row.usage ? Math.round(row.usage.seven_day.utilization) : 0
  const fiveHourReset = row.usage
    ? formatResetTime(row.usage.five_hour.resets_at, 'five_hour')
    : 'N/A'
  const sevenDayReset = row.usage
    ? formatResetTime(row.usage.seven_day.resets_at, 'seven_day')
    : 'N/A'

  return (
    <div className="relative rounded-md border border-border/50 bg-background/40 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div
          className={cn(
            'min-w-0 truncate text-[11px] text-foreground',
            row.isActive && 'font-semibold'
          )}
        >
          {row.email ?? 'Active account'}
        </div>
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
        <UsageRow label="5h" percent={fiveHourPercent} resetTime={fiveHourReset} />
        <UsageRow label="7d" percent={sevenDayPercent} resetTime={sevenDayReset} />
      </div>

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

function ProviderUsageBlock({
  provider,
  isExplicitlySelected
}: {
  provider: UsageProvider
  isExplicitlySelected: boolean
}): React.JSX.Element | null {
  const anthropicUsage = useUsageStore((s) => s.anthropicUsage)
  const openaiUsage = useUsageStore((s) => s.openaiUsage)
  const forceRefreshProvider = useUsageStore((s) => s.forceRefreshProvider)
  const refreshAllForProvider = useUsageStore((s) => s.refreshAllForProvider)
  const loadSavedAccounts = useUsageStore((s) => s.loadSavedAccounts)
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

  const usage = normalizeUsage(provider, anthropicUsage, openaiUsage)

  const providerIcon = provider === 'anthropic' ? claudeIcon : openaiIcon
  const providerLabel = provider === 'anthropic' ? 'Claude' : 'OpenAI'
  const tooltipTitle = provider === 'anthropic' ? 'Claude API Usage' : 'OpenAI API Usage'
  const iconIsRefreshing = isLoading || refreshingProvider

  const tooltipRows: TooltipAccountRow[] =
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

  const handleRefreshActive = (): void => {
    forceRefreshProvider(provider)
    fetchEmail(provider)
  }

  const handleRefreshAll = (event: React.MouseEvent): void => {
    event.preventDefault()
    refreshAllForProvider(provider)
  }

  const handleLoadSavedAccounts = (): void => {
    loadSavedAccounts(provider).catch(() => {})
  }

  useEffect(() => {
    loadSavedAccounts(provider).catch(() => {})
  }, [loadSavedAccounts, provider])

  // No credentials state — show muted N/A bars when explicitly selected
  if (!usage) {
    if (!isExplicitlySelected) return null
    return (
      <Tooltip>
        <TooltipTrigger asChild>
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
        </TooltipTrigger>
        <TooltipContent
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
            {tooltipRows.some((row) => row.email || row.usage) ? (
              tooltipRows.map((row) => <UsageTooltipAccountRow key={row.id} row={row} />)
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
        </TooltipContent>
      </Tooltip>
    )
  }

  const fiveHourPercent = Math.round(usage.five_hour.utilization)
  const sevenDayPercent = Math.round(usage.seven_day.utilization)
  const fiveHourReset = formatResetTime(usage.five_hour.resets_at, 'five_hour')
  const sevenDayReset = formatResetTime(usage.seven_day.resets_at, 'seven_day')
  const extra = usage.extra_usage

  return (
    <Tooltip>
      <TooltipTrigger asChild>
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
              <UsageRow label="5h" percent={fiveHourPercent} resetTime={fiveHourReset} />
              <UsageRow label="7d" percent={sevenDayPercent} resetTime={sevenDayReset} />
            </div>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent
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
          {tooltipRows.map((row) => (
            <UsageTooltipAccountRow key={row.id} row={row} />
          ))}
          {provider === 'anthropic' && extra?.is_enabled && (
            <div className="border-t border-background/20 pt-1 text-[10px]">
              Extra: ${(extra.used_credits ?? 0).toFixed(2)} / $
              {(extra.monthly_limit ?? 0).toFixed(2)} used ({Math.round(extra.utilization ?? 0)}%)
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
      </TooltipContent>
    </Tooltip>
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
