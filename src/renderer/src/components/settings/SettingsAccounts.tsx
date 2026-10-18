import { useEffect, useState } from 'react'
import {
  Check,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Repeat,
  Share2,
  Timer,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import { useAccountStore, useUsageStore } from '@/stores'
import { useLoginStore } from '@/stores/useLoginStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  AUTO_SIGN_IN_CODE_TIMEOUT_MAX_SECONDS,
  AUTO_SIGN_IN_CODE_TIMEOUT_MIN_SECONDS,
  isValidAutoSignInUrl,
  normalizeAutoSignInUrl,
  sanitizeAutoSignInSettings,
  type AutoSignInSettings
} from '@shared/types/settings'
import { Switch } from '@/components/ui/switch'
import { ShuffleOffIcon } from './ShuffleOffIcon'
import { isExcludedFromAutoSwitch, useAccountScheduleStore } from '@/stores/useAccountScheduleStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { accountApi } from '@/api/account-api'
import { createHiveAccountShare } from '@/api/hive-enterprise/client'
import { buildShareAccountLink } from '@shared/account-share-link'
import { toast, clipboardToast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  ScheduleSwitchForm,
  SchedulePendingSummary
} from '@/components/accounts/ScheduleSwitchControls'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { isMac } from '@/lib/platform'
import { sessionEndingSoonLabel, staleAccountNotice } from '@/lib/account-session'
import type { SavedAccountDTO, UsageProvider } from '@shared/types/usage'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'

const PROVIDERS: UsageProvider[] = ['anthropic', 'openai']

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Settings for the automated Claude sign-in: when enabled, "Sign in again" and
 * "Add account" drive a throwaway Chrome through claude.ai's email + code form,
 * fetching the code from the configured server (claude-code-extractor).
 */
function AutoSignInSettingsBlock(): React.JSX.Element {
  const autoSignIn = useSettingsStore((s) => s.autoSignIn)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const [url, setUrl] = useState(autoSignIn.codeServerUrl)
  const [token, setToken] = useState(autoSignIn.apiToken)
  const [timeout, setTimeoutSeconds] = useState(String(autoSignIn.codeTimeoutSeconds))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  const normalizedUrl = normalizeAutoSignInUrl(url)
  const urlValid = normalizedUrl.length === 0 || isValidAutoSignInUrl(normalizedUrl)

  const save = async (patch: Partial<AutoSignInSettings> = {}): Promise<void> => {
    const next = sanitizeAutoSignInSettings({
      ...autoSignIn,
      codeServerUrl: normalizedUrl,
      apiToken: token,
      codeTimeoutSeconds: Number(timeout),
      ...patch
    })
    // Sanitizing clamps the timeout and drops `enabled` without a usable URL;
    // reflect that in the inputs so what is shown is what was saved.
    setTimeoutSeconds(String(next.codeTimeoutSeconds))
    setUrl(next.codeServerUrl)
    await updateSetting('autoSignIn', next)
  }

  const testConnection = async (): Promise<void> => {
    if (!isValidAutoSignInUrl(normalizedUrl)) return
    setTesting(true)
    setTestResult(null)
    try {
      await save()
      const result = await accountApi.autoSignInTest({
        codeServerUrl: normalizedUrl,
        apiToken: token.trim()
      })
      setTestResult(result)
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Connection test failed'
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div
      className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3"
      data-testid="auto-sign-in-settings"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Wand2 className="h-3.5 w-3.5" />
            Auto sign-in
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Sign in to Claude without touching the browser: a fresh Chrome window types the email,
            fetches the sign-in code from the code server and authorizes the app. The account&apos;s
            mailbox must be one the code server watches.
          </p>
        </div>
        <Switch
          checked={autoSignIn.enabled}
          disabled={!isValidAutoSignInUrl(autoSignIn.codeServerUrl)}
          onCheckedChange={(enabled) => void save({ enabled })}
          aria-label="Auto sign-in"
          data-testid="auto-sign-in-enabled"
        />
      </div>

      <div className="space-y-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="auto-sign-in-url">
            Code server URL
          </label>
          <Input
            id="auto-sign-in-url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setTestResult(null)
            }}
            onBlur={() => void save()}
            placeholder="http://claudit-dashboard:3000"
            className={cn('h-8 font-mono text-xs', !urlValid && 'border-destructive')}
            data-testid="auto-sign-in-url"
          />
          {!urlValid && (
            <p className="text-[11px] text-destructive">
              Enter an http(s) URL, e.g. http://host:3000
            </p>
          )}
        </div>
        <div className="grid grid-cols-[1fr_140px] gap-2">
          <div className="space-y-1">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="auto-sign-in-token"
            >
              API token (optional)
            </label>
            <Input
              id="auto-sign-in-token"
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value)
                setTestResult(null)
              }}
              onBlur={() => void save()}
              placeholder="CODES_API_TOKEN"
              className="h-8 font-mono text-xs"
              data-testid="auto-sign-in-token"
            />
          </div>
          <div className="space-y-1">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="auto-sign-in-timeout"
            >
              Code wait (seconds)
            </label>
            <Input
              id="auto-sign-in-timeout"
              type="number"
              min={AUTO_SIGN_IN_CODE_TIMEOUT_MIN_SECONDS}
              max={AUTO_SIGN_IN_CODE_TIMEOUT_MAX_SECONDS}
              value={timeout}
              onChange={(event) => setTimeoutSeconds(event.target.value)}
              onBlur={() => void save()}
              className="h-8 text-xs"
              data-testid="auto-sign-in-timeout"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={testing || !isValidAutoSignInUrl(normalizedUrl)}
            onClick={() => void testConnection()}
            data-testid="auto-sign-in-test"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Test connection
          </Button>
          {testResult && (
            <span
              className={cn(
                'flex items-center gap-1 text-xs',
                testResult.ok ? 'text-emerald-500' : 'text-destructive'
              )}
              data-testid="auto-sign-in-test-result"
            >
              {testResult.ok ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
              {testResult.message}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Asks for the email before an automated "Add account": the flow needs it to type into claude.ai. */
function AddAccountEmailDialog({
  open,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (email: string) => void
}): React.JSX.Element {
  const [email, setEmail] = useState('')
  const normalized = email.trim().toLowerCase()
  const valid = EMAIL_PATTERN.test(normalized)

  const submit = (): void => {
    if (!valid) return
    onSubmit(normalized)
    onOpenChange(false)
    setEmail('')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setEmail('')
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a Claude account</DialogTitle>
          <DialogDescription>
            Auto sign-in is on: enter the account&apos;s email and the sign-in runs by itself. The
            code is fetched from the code server, so the mailbox must be one it watches.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          className="text-sm"
          data-testid="add-account-email"
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        <DialogFooter>
          <Button
            size="sm"
            onClick={submit}
            disabled={!valid}
            data-testid="add-account-email-submit"
          >
            Sign in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProviderAccountsCard({ provider }: { provider: UsageProvider }): React.JSX.Element {
  const accounts = useUsageStore((s) => s.savedAccounts[provider])
  const loadError = useUsageStore((s) => s.savedAccountLoadErrors[provider])
  const refreshingAccountIds = useUsageStore((s) => s.refreshingAccountIds)
  const switchingAccountIds = useUsageStore((s) => s.switchingAccountIds)
  const removingAccountIds = useUsageStore((s) => s.removingAccountIds)
  const refreshSavedAccount = useUsageStore((s) => s.refreshSavedAccount)
  const switchAccount = useUsageStore((s) => s.switchAccount)
  const removeSavedAccount = useUsageStore((s) => s.removeSavedAccount)
  const activeEmail = useAccountStore((s) =>
    provider === 'anthropic' ? s.anthropicEmail : s.openaiEmail
  )
  const startLogin = useLoginStore((s) => s.startLogin)
  const isLoginActive = useLoginStore((s) => s.activeLogin !== null)
  // With auto sign-in on, "Add account" needs the email up front (the driver types it).
  const autoSignInEnabled = useSettingsStore((s) => s.autoSignIn.enabled)
  const automateAddAccount = provider === 'anthropic' && autoSignInEnabled
  const [emailPromptOpen, setEmailPromptOpen] = useState(false)
  const schedule = useAccountScheduleStore((s) => s.schedules[provider])
  const cancelSchedule = useAccountScheduleStore((s) => s.cancelSchedule)
  const autoSwitchExcluded = useAccountScheduleStore((s) => s.autoSwitchExcluded)
  const setAccountAutoSwitchExcluded = useAccountScheduleStore(
    (s) => s.setAccountAutoSwitchExcluded
  )
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const hiveAuthToken = useSettingsStore((s) => s.hiveAuthToken)
  const [sharingAccountId, setSharingAccountId] = useState<string | null>(null)
  const [shareResult, setShareResult] = useState<{ email: string; link: string } | null>(null)

  // Sharing needs a connected Hive Enterprise server: the encrypted payload is
  // parked there behind the one-time token. The encryption key stays in the link.
  const canShare = isMac() && Boolean(hiveAuthToken)

  const handleShare = async (account: SavedAccountDTO): Promise<void> => {
    setSharingAccountId(account.id)
    try {
      const exported = await accountApi.exportShare(account.id)
      const created = await createHiveAccountShare(exported.provider, exported.encryptedPayload)
      const serverUrl = useSettingsStore.getState().hiveEnterpriseServerUrl
      const link = buildShareAccountLink({ serverUrl, token: created.token, key: exported.key })
      setShareResult({ email: account.email, link })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create share link')
    } finally {
      setSharingAccountId(null)
    }
  }

  const copyShareLink = async (): Promise<void> => {
    if (!shareResult) return
    try {
      await navigator.clipboard.writeText(shareResult.link)
      clipboardToast.copied('Share link')
    } catch {
      clipboardToast.failed()
    }
  }

  const icon = provider === 'anthropic' ? claudeIcon : openaiIcon
  const label = provider === 'anthropic' ? 'Claude' : 'OpenAI'
  const canAddAccount = isMac()
  const confirmAccount = accounts.find((a) => a.id === confirmRemoveId) ?? null

  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <img src={icon} alt={label} className="h-4 w-4" />
          {label}
        </div>
        {canAddAccount ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={isLoginActive}
            onClick={() => (automateAddAccount ? setEmailPromptOpen(true) : startLogin(provider))}
            data-testid={`add-account-${provider}`}
          >
            <Plus className="h-3.5 w-3.5" />
            Add account
          </Button>
        ) : (
          <span
            className="text-xs text-muted-foreground/70 italic"
            title="Signing in to add an account is only supported on macOS"
          >
            Add account requires macOS
          </span>
        )}
      </div>

      {loadError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          Failed to load saved accounts: {loadError}
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
          No saved accounts yet. Sign in to Claude or Codex to capture one.
        </div>
      ) : (
        <div className="space-y-1.5">
          {accounts.map((account) => {
            const isActive = activeEmail !== null && activeEmail === account.email
            const isRefreshing = refreshingAccountIds.has(account.id)
            const isSwitching = switchingAccountIds.has(account.id)
            const isRemoving = removingAccountIds.has(account.id)
            const isExpired = account.status === 'stale'
            const staleNotice = isExpired ? staleAccountNotice(account.last_error) : null
            const sessionEndingSoon =
              account.status === 'ok'
                ? sessionEndingSoonLabel(account.session_expires_at, Date.now())
                : null
            const isExcluded = isExcludedFromAutoSwitch(autoSwitchExcluded, provider, account.email)

            return (
              <div
                key={account.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                data-testid={`account-row-${account.id}`}
              >
                <div className="min-w-0">
                  <div className={cn('truncate text-sm', isActive && 'font-semibold')}>
                    {account.email}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {isActive && (
                      <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                        Active
                      </span>
                    )}
                    {account.plan && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {account.plan}
                      </span>
                    )}
                    {isExcluded && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500"
                        title="Removed from auto-switch: it never switches to this account"
                        data-testid={`account-auto-switch-excluded-${account.id}`}
                      >
                        <ShuffleOffIcon className="h-2.5 w-2.5" />
                        Not in auto-switch
                      </span>
                    )}
                    {!isExpired && account.status === 'ok' && !isActive && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        OK
                      </span>
                    )}
                    {staleNotice && (
                      <span
                        className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                        title={staleNotice.detail}
                      >
                        {staleNotice.label}
                      </span>
                    )}
                    {sessionEndingSoon && (
                      <span
                        className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500"
                        title="Claude sign-ins last about 30 days. Sign in again before then to keep this account usable."
                      >
                        {sessionEndingSoon}
                      </span>
                    )}
                    {account.status === 'error' && (
                      <span
                        className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                        title={account.last_error ?? undefined}
                      >
                        Error
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => refreshSavedAccount(account.id, { userInitiated: true })}
                    disabled={isRefreshing}
                    aria-label={`Refresh ${account.email}`}
                  >
                    {isRefreshing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'h-7 w-7',
                      isExcluded
                        ? 'text-amber-500 hover:text-amber-400'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() =>
                      setAccountAutoSwitchExcluded(provider, account.email, !isExcluded)
                    }
                    aria-pressed={isExcluded}
                    aria-label={
                      isExcluded
                        ? `Add ${account.email} back to auto-switch`
                        : `Remove ${account.email} from auto-switch`
                    }
                    title={
                      isExcluded
                        ? 'Removed from auto-switch: it never switches to this account. Click to add it back.'
                        : 'Remove from auto-switch: it will never switch to this account (for accounts also used elsewhere). Manual and scheduled switches still work.'
                    }
                  >
                    <ShuffleOffIcon className="h-3.5 w-3.5" />
                  </Button>
                  {canShare && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => void handleShare(account)}
                      disabled={sharingAccountId !== null}
                      aria-label={`Share ${account.email}`}
                      title="Share this account with another computer via a one-time link"
                    >
                      {sharingAccountId === account.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Share2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                  {!isActive && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => switchAccount(account.id)}
                      disabled={isSwitching}
                      aria-label={`Switch to ${account.email}`}
                    >
                      {isSwitching ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Repeat className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                  {!isActive && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            'h-7 w-7',
                            schedule?.accountId === account.id
                              ? 'text-amber-500 hover:text-amber-400'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                          aria-label={`Schedule switch to ${account.email}`}
                        >
                          <Timer className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-64 p-3">
                        {schedule?.accountId === account.id ? (
                          <SchedulePendingSummary
                            schedule={schedule}
                            onCancel={() => cancelSchedule(provider)}
                          />
                        ) : (
                          <ScheduleSwitchForm
                            provider={provider}
                            accountId={account.id}
                            email={account.email}
                          />
                        )}
                      </PopoverContent>
                    </Popover>
                  )}
                  {(isExpired || sessionEndingSoon) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => startLogin(provider, account.email)}
                      disabled={isLoginActive}
                    >
                      Sign in again
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmRemoveId(account.id)}
                    disabled={isRemoving}
                    aria-label={`Remove ${account.email}`}
                  >
                    {isRemoving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Dialog
        open={shareResult !== null}
        onOpenChange={(open) => {
          if (!open) setShareResult(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share account</DialogTitle>
            <DialogDescription>
              One-time link for <span className="font-semibold">{shareResult?.email}</span>. Open
              it in Hive on another computer to add this account there. The link works once and
              expires in 24 hours — treat it like a password.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={shareResult?.link ?? ''}
              className="font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
              data-testid="share-account-link"
            />
            <Button size="sm" onClick={copyShareLink}>
              Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmRemoveId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemoveId(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove account?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes <span className="font-semibold">{confirmAccount?.email}</span> from the
              usage popup. You can add it back by signing in again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmRemoveId) removeSavedAccount(confirmRemoveId)
                setConfirmRemoveId(null)
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {provider === 'anthropic' && canAddAccount && <AutoSignInSettingsBlock />}
      {automateAddAccount && (
        <AddAccountEmailDialog
          open={emailPromptOpen}
          onOpenChange={setEmailPromptOpen}
          onSubmit={(email) => void startLogin(provider, email)}
        />
      )}
    </div>
  )
}

export function SettingsAccounts(): React.JSX.Element {
  const loadSavedAccounts = useUsageStore((s) => s.loadSavedAccounts)
  const fetchEmail = useAccountStore((s) => s.fetchEmail)
  const hiveAuthToken = useSettingsStore((s) => s.hiveAuthToken)
  const [importOpen, setImportOpen] = useState(false)
  const [importUrl, setImportUrl] = useState('')
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    loadSavedAccounts().catch(() => {})
    fetchEmail('anthropic')
    fetchEmail('openai')
  }, [loadSavedAccounts, fetchEmail])

  // Refresh when a share link is imported through the hive:// deep link.
  useEffect(() => {
    return accountApi.onSharedAccountImported(({ provider, email }) => {
      toast.success(`Imported ${email} (${provider === 'anthropic' ? 'Claude' : 'OpenAI'})`)
      loadSavedAccounts().catch(() => {})
      fetchEmail(provider)
    })
  }, [loadSavedAccounts, fetchEmail])

  const handleImport = async (): Promise<void> => {
    const url = importUrl.trim()
    if (!url) return
    setImporting(true)
    try {
      const result = await accountApi.importShare(url)
      if (result.refreshedAuthToken) {
        // The claim rotated our enterprise token (import runs outside the
        // renderer, which normally persists these); adopt it before any other
        // settings save writes the stale one back.
        await useSettingsStore.getState().updateSetting('hiveAuthToken', result.refreshedAuthToken)
      }
      toast.success(
        `Imported ${result.email} (${result.provider === 'anthropic' ? 'Claude' : 'OpenAI'})`
      )
      setImportOpen(false)
      setImportUrl('')
      await loadSavedAccounts().catch(() => {})
      fetchEmail(result.provider)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import share link')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-medium mb-1">Accounts</h3>
          <p className="text-sm text-muted-foreground">
            Manage saved Claude and OpenAI accounts used for usage tracking and quick switching.
          </p>
        </div>
        {isMac() && Boolean(hiveAuthToken) && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={() => setImportOpen(true)}
            data-testid="import-share-link"
          >
            <Link2 className="h-3.5 w-3.5" />
            Import share link
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {PROVIDERS.map((provider) => (
          <ProviderAccountsCard key={provider} provider={provider} />
        ))}
      </div>

      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open)
          if (!open) setImportUrl('')
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import account from share link</DialogTitle>
            <DialogDescription>
              Paste a <span className="font-mono">hive://share-account</span> link generated on
              another computer. The account is claimed once and the link stops working.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={importUrl}
            onChange={(event) => setImportUrl(event.target.value)}
            placeholder="hive://share-account?server=…&token=…&key=…"
            className="font-mono text-xs"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !importing) void handleImport()
            }}
          />
          <DialogFooter>
            <Button
              size="sm"
              onClick={() => void handleImport()}
              disabled={importing || importUrl.trim().length === 0}
            >
              {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
