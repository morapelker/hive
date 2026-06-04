import { useState } from 'react'
import { Check, Loader2, RadioTower, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/useSettingsStore'

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function SettingsTeleport(): React.JSX.Element {
  const teleport = useSettingsStore((s) => s.teleport)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const [url, setUrl] = useState(teleport?.url ?? '')
  const [bootstrapToken, setBootstrapToken] = useState(teleport?.bootstrapToken ?? '')
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState<boolean | null>(null)
  const normalizedUrl = normalizeUrl(url)
  const normalizedToken = bootstrapToken.trim()
  const isComplete = Boolean(normalizedUrl && normalizedToken)
  const statusText = !normalizedUrl
    ? 'not configured'
    : !normalizedToken
      ? 'missing bootstrap token'
      : `configured for ${normalizedUrl}`

  const save = async (nextUrl = url, nextToken = bootstrapToken): Promise<void> => {
    const normalizedUrl = normalizeUrl(nextUrl)
    const normalizedToken = nextToken.trim()
    await updateSetting(
      'teleport',
      normalizedUrl || normalizedToken
        ? { url: normalizedUrl, bootstrapToken: normalizedToken }
        : null
    )
  }

  const testConnection = async (): Promise<void> => {
    if (!isComplete) return
    setTesting(true)
    setTestOk(null)
    try {
      await save()
      const [health, environment] = await Promise.all([
        fetch(`${normalizedUrl}/health`),
        fetch(`${normalizedUrl}/.well-known/hive/environment`)
      ])
      if (!health.ok || !environment.ok) {
        throw new Error(`Health ${health.status}, environment ${environment.status}`)
      }
      const bootstrapResponse = await fetch(`${normalizedUrl}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrapToken: normalizedToken })
      })
      if (!bootstrapResponse.ok) throw new Error('Bootstrap token was rejected')

      const bootstrap = (await bootstrapResponse.json()) as { session?: { accessToken?: string } }
      const accessToken = bootstrap.session?.accessToken
      if (!accessToken) throw new Error('Bootstrap response did not include an access token')

      const wsTokenResponse = await fetch(`${normalizedUrl}/api/auth/ws-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      if (!wsTokenResponse.ok) throw new Error('WebSocket token could not be issued')

      setTestOk(true)
      toast.success('Teleport remote connected')
    } catch (error) {
      setTestOk(false)
      toast.error(error instanceof Error ? error.message : 'Teleport remote connection failed')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-1">Teleport</h3>
        <p className="text-xs text-muted-foreground">
          Configure the headless Hive server that receives stopped Claude Code CLI sessions.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Remote URL</label>
          <Input
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setTestOk(null)
            }}
            onBlur={() => void save()}
            placeholder="http://localhost:3773"
            className="h-8 text-sm"
            data-testid="teleport-url-input"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Bootstrap token</label>
          <Input
            type="password"
            value={bootstrapToken}
            onChange={(event) => {
              setBootstrapToken(event.target.value)
              setTestOk(null)
            }}
            onBlur={() => void save()}
            placeholder="Remote bootstrap token"
            className="h-8 text-sm"
            data-testid="teleport-token-input"
          />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Status: {statusText}</span>
          <div className="flex items-center gap-2">
            {testOk === true && <Check className="h-4 w-4 text-green-500" />}
            {testOk === false && <X className="h-4 w-4 text-red-500" />}
            <Button
              size="sm"
              variant="outline"
              disabled={testing || !isComplete}
              onClick={() => void testConnection()}
              data-testid="teleport-test-button"
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Test
            </Button>
            <RadioTower className="h-4 w-4" />
          </div>
        </div>
      </div>
    </div>
  )
}
