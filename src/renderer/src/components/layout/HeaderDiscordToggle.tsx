import { useState } from 'react'
import { Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiscordProvisionModal } from '@/components/discord/DiscordProvisionModal'
import { cn } from '@/lib/utils'
import { useDiscordStore } from '@/stores/useDiscordStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

export function HeaderDiscordToggle(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { configured, enabled, refresh } = useDiscordStore()
  const openSettings = useSettingsStore((s) => s.openSettings)

  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      disabled={!configured}
      onClick={() => {
        if (!configured) {
          openSettings('discord')
          return
        }
        setOpen(true)
      }}
      className={cn(enabled && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
      title={configured ? 'Discord provisioning' : 'Configure Discord in Settings'}
      data-testid="discord-provision-toggle"
    >
      <Hash className="h-4 w-4" />
    </Button>
  )

  return (
    <>
      {!configured ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">{trigger}</span>
          </TooltipTrigger>
          <TooltipContent>Configure Discord in Settings</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DiscordProvisionModal
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) refresh().catch(() => {})
        }}
      />
    </>
  )
}
