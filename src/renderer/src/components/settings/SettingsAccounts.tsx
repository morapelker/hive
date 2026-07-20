import { useEffect, useState } from 'react'
import { Link2, Loader2, Plus, RefreshCw, Repeat, Share2, Timer, Trash2 } from 'lucide-react'
import { useAccountStore, useUsageStore } from '@/stores'
import { useLoginStore } from '@/stores/useLoginStore'
import { useAccountScheduleStore } from '@/stores/useAccountScheduleStore'
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
import type { SavedAccountDTO, UsageProvider } from '@shared/types/usage'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'

const PROVIDERS: UsageProvider[] = ['anthropic', 'openai']

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
  const schedule = useAccountScheduleStore((s) => s.schedules[provider])
  const cancelSchedule = useAccountScheduleStore((s) => s.cancelSchedule)
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
            onClick={() => startLogin(provider)}
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
                      <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        Active
                      </span>
                    )}
                    {account.plan && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {account.plan}
                      </span>
                    )}
                    {!isExpired && account.status === 'ok' && !isActive && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        OK
                      </span>
                    )}
                    {isExpired && (
                      <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                        Expired
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
                  {canShare && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => handleShare(account)}
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
                  {isExpired && (
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
