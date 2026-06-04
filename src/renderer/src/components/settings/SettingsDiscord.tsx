import { useEffect, useState } from 'react'
import { Check, Hash, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { DiscordConfig, DiscordGuild } from '@shared/types/discord'
import { discordApi } from '@/api/discord-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDiscordStore } from '@/stores/useDiscordStore'

const DEFAULT_CONFIG: DiscordConfig = {
  botToken: '',
  guildId: '',
  guildName: '',
  enabled: false,
  selectedProjectIds: []
}

export function SettingsDiscord(): React.JSX.Element {
  const storeConfig = useDiscordStore((s) => s.config)
  const setStoreConfig = useDiscordStore((s) => s.setConfig)
  const [draft, setDraft] = useState<DiscordConfig>(storeConfig ?? DEFAULT_CONFIG)
  const [guilds, setGuilds] = useState<DiscordGuild[]>([])
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<boolean | null>(null)

  useEffect(() => {
    discordApi.getConfig().then((config) => {
      const next = config ?? DEFAULT_CONFIG
      setDraft(next)
      setStoreConfig(config)
      if (next.guildId) {
        setGuilds([{ id: next.guildId, name: next.guildName || next.guildId }])
      }
    })
  }, [setStoreConfig])

  const saveConfig = async (next: DiscordConfig): Promise<void> => {
    const normalized: DiscordConfig = {
      ...next,
      botToken: next.botToken.trim(),
      guildId: next.guildId.trim(),
      guildName: next.guildName.trim(),
      selectedProjectIds: next.selectedProjectIds
    }
    setDraft(normalized)
    const config = normalized.botToken || normalized.guildId ? normalized : null
    setStoreConfig(config)
    const result = await discordApi.setConfig(config)
    if (!result.ok) toast.error(result.error ?? 'Failed to save Discord settings')
  }

  const verifyToken = async (): Promise<void> => {
    if (!draft.botToken.trim()) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      const result = await discordApi.verifyToken(draft.botToken.trim())
      setVerifyResult(result.ok)
      setGuilds(result.guilds)
      const hiveGuild = result.guilds.find((guild) => guild.name === 'Hive')
      const selectedGuild =
        result.guilds.find((guild) => guild.id === draft.guildId) ?? hiveGuild ?? result.guilds[0]
      if (result.ok && result.guilds.length === 0) {
        setVerifyResult(false)
        toast.error(
          'Discord bot verified, but it is not in any servers. Invite the bot with bot and applications.commands scopes plus Manage Channels, then verify again.'
        )
      } else if (result.ok && selectedGuild) {
        const next = {
          ...draft,
          botToken: draft.botToken.trim(),
          guildId: selectedGuild.id,
          guildName: selectedGuild.name
        }
        setDraft(next)
        await saveConfig(next)
        toast.success(`Discord bot verified: ${result.botUser ?? 'connected'}`)
      } else if (!result.ok) {
        toast.error(result.error ?? 'Invalid Discord bot token')
      }
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-1">Discord</h3>
        <p className="text-xs text-muted-foreground">
          Provision project categories and worktree channels in your Discord server. Invite the
          bot with bot and applications.commands scopes plus Manage Channels so /archive appears.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Bot token</label>
          <div className="flex gap-2">
            <Input
              type="password"
              value={draft.botToken}
              onChange={(event) => {
                setDraft((prev) => ({ ...prev, botToken: event.target.value }))
                setVerifyResult(null)
              }}
              onBlur={() => void saveConfig(draft)}
              placeholder="Bot token"
              className="h-8 text-sm"
              data-testid="discord-bot-token-input"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={verifying || !draft.botToken.trim()}
              onClick={() => void verifyToken()}
              data-testid="discord-verify-button"
            >
              {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Verify
            </Button>
            {verifyResult === true && <Check className="h-4 w-4 text-green-500 self-center" />}
            {verifyResult === false && <X className="h-4 w-4 text-red-500 self-center" />}
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Server</label>
          <div className="flex gap-2">
            <select
              className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              value={draft.guildId}
              onChange={(event) => {
                const guild = guilds.find((item) => item.id === event.target.value)
                const next = {
                  ...draft,
                  guildId: event.target.value,
                  guildName: guild?.name ?? draft.guildName
                }
                setDraft(next)
                void saveConfig(next)
              }}
              data-testid="discord-server-select"
            >
              <option value="">Select a server</option>
              {guilds.map((guild) => (
                <option key={guild.id} value={guild.id}>
                  {guild.name}
                </option>
              ))}
              {draft.guildId && !guilds.some((guild) => guild.id === draft.guildId) ? (
                <option value={draft.guildId}>{draft.guildName || draft.guildId}</option>
              ) : null}
            </select>
          </div>
          <Input
            value={draft.guildId}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                guildId: event.target.value,
                guildName: event.target.value
              }))
            }
            onBlur={() => void saveConfig(draft)}
            placeholder="Manual server ID"
            className="h-8 text-sm"
            data-testid="discord-manual-server-input"
          />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Status:{' '}
            {draft.botToken && draft.guildId
              ? `configured for ${draft.guildName || draft.guildId}`
              : 'not configured'}
          </span>
          <Hash className="h-4 w-4" />
        </div>
      </div>
    </div>
  )
}
