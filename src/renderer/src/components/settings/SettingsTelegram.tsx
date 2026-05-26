import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTelegramStore } from '@/stores/useTelegramStore'
import type { TelegramConfig } from '@shared/types/telegram'
import { unwrapEnvelope } from '@/lib/ipc-envelope'

const DEFAULT_CONFIG: TelegramConfig = {
  botToken: '',
  chatId: 0,
  chatName: '',
  contextSize: 3
}

export function SettingsTelegram(): React.JSX.Element {
  const telegramConfig = useSettingsStore((s) => s.telegramConfig)
  const setTelegramConfig = useSettingsStore((s) => s.setTelegramConfig)
  const {
    connectionStatus,
    lastError,
    discoveredChats,
    refreshing,
    setDiscoveredChats,
    setRefreshing
  } = useTelegramStore()
  const [draft, setDraft] = useState<TelegramConfig>(telegramConfig ?? DEFAULT_CONFIG)
  const [verifying, setVerifying] = useState(false)
  const [testing, setTesting] = useState(false)
  const [verifyResult, setVerifyResult] = useState<boolean | null>(null)

  useEffect(() => {
    window.telegramOps
      .getConfig()
      .then(unwrapEnvelope)
      .then((config) => {
        const next = config ?? DEFAULT_CONFIG
        setDraft(next)
        setTelegramConfig(config)
      })
  }, [setTelegramConfig])

  const canTest = useMemo(() => !!draft.botToken.trim() && !!draft.chatId, [draft])

  const saveConfig = async (next: TelegramConfig): Promise<void> => {
    const normalized = {
      ...next,
      botToken: next.botToken.trim(),
      chatId: Number(next.chatId) || 0,
      contextSize: Math.min(10, Math.max(1, Number(next.contextSize) || 3))
    }
    setDraft(normalized)
    setTelegramConfig(normalized.botToken || normalized.chatId ? normalized : null)
    const result = unwrapEnvelope(
      await window.telegramOps.setConfig(
        normalized.botToken || normalized.chatId ? normalized : null
      )
    )
    if (!result.ok) toast.error(result.error ?? 'Failed to save Telegram settings')
  }

  const verifyToken = async (): Promise<void> => {
    if (!draft.botToken.trim()) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      const result = unwrapEnvelope(await window.telegramOps.verifyToken(draft.botToken.trim()))
      setVerifyResult(result.ok)
      if (result.ok) {
        toast.success(
          `Telegram bot configured${result.botUsername ? `: ${result.botUsername}` : ''}`
        )
      } else {
        toast.error(result.error ?? 'Invalid Telegram bot token')
      }
    } finally {
      setVerifying(false)
    }
  }

  const refreshChats = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await saveConfig(draft)
      const chats = unwrapEnvelope(await window.telegramOps.discoverChats(draft))
      setDiscoveredChats(chats)
      if (chats.length === 0) {
        toast.error('No chats found. Send a message to the bot, then refresh.')
      }
    } finally {
      setRefreshing(false)
    }
  }

  const sendTest = async (): Promise<void> => {
    setTesting(true)
    try {
      await saveConfig(draft)
      const result = unwrapEnvelope(await window.telegramOps.sendTestMessage())
      if (result.ok) toast.success('Telegram test message sent')
      else toast.error(result.error ?? 'Telegram test failed')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-1">Telegram</h3>
        <p className="text-xs text-muted-foreground">
          Forward one active Hive session to a Telegram chat.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Bot token</label>
          <div className="flex gap-2">
            <Input
              type="password"
              value={draft.botToken}
              onChange={(e) => {
                setDraft((prev) => ({ ...prev, botToken: e.target.value }))
                setVerifyResult(null)
              }}
              onBlur={() => void saveConfig(draft)}
              placeholder="123456:ABC..."
              className="h-8 text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={verifying}
              onClick={() => void verifyToken()}
            >
              {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Verify
            </Button>
            {verifyResult === true && <Check className="h-4 w-4 text-green-500 self-center" />}
            {verifyResult === false && <X className="h-4 w-4 text-red-500 self-center" />}
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Chat</label>
          <div className="flex gap-2">
            <select
              className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              value={draft.chatId || ''}
              onChange={(e) => {
                const chat = discoveredChats.find((item) => item.chatId === Number(e.target.value))
                const next = {
                  ...draft,
                  chatId: Number(e.target.value) || 0,
                  chatName: chat?.firstName ?? draft.chatName
                }
                setDraft(next)
                void saveConfig(next)
              }}
            >
              <option value="">Select a chat</option>
              {discoveredChats.map((chat) => (
                <option key={chat.chatId} value={chat.chatId}>
                  {chat.firstName} ({chat.type})
                </option>
              ))}
              {draft.chatId && !discoveredChats.some((chat) => chat.chatId === draft.chatId) ? (
                <option value={draft.chatId}>{draft.chatName || draft.chatId}</option>
              ) : null}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={refreshing}
              onClick={() => void refreshChats()}
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Refresh
            </Button>
          </div>
          <Input
            type="number"
            value={draft.chatId || ''}
            onChange={(e) => setDraft((prev) => ({ ...prev, chatId: Number(e.target.value) || 0 }))}
            onBlur={() => void saveConfig(draft)}
            placeholder="Manual chat ID"
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Context turns</label>
          <Input
            type="number"
            min={1}
            max={10}
            value={draft.contextSize}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, contextSize: Number(e.target.value) || 3 }))
            }
            onBlur={() => void saveConfig(draft)}
            className="h-8 text-sm w-24"
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Status: {connectionStatus}
            {lastError ? `: ${lastError}` : ''}
          </div>
          <Button size="sm" disabled={!canTest || testing} onClick={() => void sendTest()}>
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <Send className="h-3.5 w-3.5 mr-1.5" />
            )}
            Test message
          </Button>
        </div>
      </div>
    </div>
  )
}
