import { Loader2 } from 'lucide-react'
import { useLoginStore } from '@/stores/useLoginStore'
import { Button } from '@/components/ui/button'

const PROVIDER_LABEL: Record<'anthropic' | 'openai', string> = {
  anthropic: 'Claude',
  openai: 'OpenAI'
}

export function LoginBanner(): React.JSX.Element | null {
  const activeLogin = useLoginStore((s) => s.activeLogin)
  const cancelLogin = useLoginStore((s) => s.cancelLogin)

  if (!activeLogin) return null

  const providerName = PROVIDER_LABEL[activeLogin.provider]

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-2"
      data-testid="login-banner"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        <span className="text-foreground">
          Signing in to {providerName} — complete the sign-in in Chrome…
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => cancelLogin()}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
