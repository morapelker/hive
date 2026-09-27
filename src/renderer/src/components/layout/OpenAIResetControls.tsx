import { useEffect, useState } from 'react'
import { RotateCcw, Loader2 } from 'lucide-react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useOpenAIResetsStore } from '@/stores/useOpenAIResetsStore'
import type { OpenAIResetCredit } from '@shared/types/usage'

function expiration(credit: OpenAIResetCredit): string {
  if (credit.expires_at === null) return 'Does not expire'
  const date = new Date(credit.expires_at ?? '')
  return Number.isNaN(date.getTime())
    ? 'Expiration unavailable'
    : `Expires ${date.toLocaleString()}`
}

export function OpenAIResetControls({
  accountId,
  email,
  availableCount,
  refreshedAt
}: {
  accountId: string
  email: string
  availableCount?: number
  refreshedAt?: string | null
}): React.JSX.Element | null {
  const state = useOpenAIResetsStore((s) => s.accounts[accountId])
  const load = useOpenAIResetsStore((s) => s.load)
  const select = useOpenAIResetsStore((s) => s.select)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void load(accountId)
  }, [accountId, refreshedAt, load])
  const count = state?.data?.available_count ?? availableCount ?? 0
  if (count < 1) return null
  const credits = (state?.data?.credits ?? [])
    .filter((c) => c.status === 'available')
    .sort(
      (a, b) =>
        (Date.parse(a.expires_at ?? '') || Infinity) - (Date.parse(b.expires_at ?? '') || Infinity)
    )
    .slice(0, count)
  return (
    <HoverCard
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) void load(accountId)
      }}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={`${count} usage resets available for ${email}`}
          onClick={() => setOpen((value) => !value)}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <RotateCcw className="h-2.5 w-2.5" />
          {count}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="end"
        className="w-72 space-y-2"
        onPointerDownOutside={() => setOpen(false)}
      >
        <div className="font-medium">
          {count} usage limit {count === 1 ? 'reset' : 'resets'} available
        </div>
        <div className="truncate text-xs text-muted-foreground">{email}</div>
        {state?.loading && (
          <div className="text-xs text-muted-foreground">Checking available resets…</div>
        )}
        {state?.error && (
          <div className="text-xs text-destructive">
            {state.error}{' '}
            <button className="underline" onClick={() => void load(accountId)}>
              Retry
            </button>
          </div>
        )}
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {credits.length > 0 ? (
            credits.map((credit) => (
              <div
                key={credit.id}
                className="rounded-md border border-border p-2 text-xs space-y-1"
              >
                <div className="font-medium">{credit.title?.trim() || 'Full reset'}</div>
                <div className="text-muted-foreground">{expiration(credit)}</div>
                {credit.description && <div>{credit.description}</div>}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOpen(false)
                    select(accountId, email, credit)
                  }}
                >
                  Use reset
                </Button>
              </div>
            ))
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                Individual reset details unavailable.
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setOpen(false)
                  select(accountId, email)
                }}
              >
                Use a reset
              </Button>
            </>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

// Mounted outside the hover card: moving to the confirmation dialog must not
// dismiss it, lose the selected account, or interrupt an in-flight redemption.
export function OpenAIResetDialog(): React.JSX.Element {
  const { selection, pending, message, error, close, consume, accounts } = useOpenAIResetsStore()
  const state = selection ? accounts[selection.accountId] : undefined
  return (
    <Dialog
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          document.getElementById('cancel-codex-reset')?.focus()
        }}
      >
        <DialogTitle>
          {message ? 'Usage limit reset' : 'Are you sure you want to reset your usage?'}
        </DialogTitle>
        <DialogDescription>
          {message ??
            `This will use one reset for ${selection?.email ?? 'this account'}. Once used, it cannot be undone.`}
        </DialogDescription>
        <div className="text-sm font-medium break-all">{selection?.email}</div>
        {!message && selection?.credit && (
          <div className="text-sm space-y-1">
            <div>{selection.credit.title?.trim() || 'Full reset'}</div>
            <div className="text-muted-foreground">{expiration(selection.credit)}</div>
            {selection.credit.description && <div>{selection.credit.description}</div>}
          </div>
        )}
        {message && state?.data && !state.loading && !state.error && (
          <div className="text-sm">{state.data.available_count} resets remaining.</div>
        )}
        {message && state?.error && (
          <div className="text-sm text-muted-foreground">
            The remaining reset count could not be refreshed. Reopen the usage popover to check
            again.
          </div>
        )}
        {error && (
          <div role="alert" className="text-sm text-destructive">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button id="cancel-codex-reset" variant="outline" disabled={pending} onClick={close}>
            {message ? 'Done' : 'Cancel'}
          </Button>
          {!message && (
            <Button variant="destructive" disabled={pending} onClick={() => void consume()}>
              {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {pending ? 'Resetting…' : error ? 'Confirm retry' : 'Use one reset'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
