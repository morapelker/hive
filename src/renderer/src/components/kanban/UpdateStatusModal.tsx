import { useState, useEffect } from 'react'
import { getProviderSettings } from '@/lib/provider-settings'
import { Loader2, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface UpdateStatusModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  externalProvider: string
  externalId: string
  externalUrl: string
  ticketTitle: string
}

export function UpdateStatusModal({
  open,
  onOpenChange,
  externalProvider,
  externalId,
  externalUrl,
  ticketTitle
}: UpdateStatusModalProps) {
  const [statuses, setStatuses] = useState<Array<{ id: string; label: string }>>([])
  const [loading, setLoading] = useState(false)
  const [updating, setUpdating] = useState(false)

  const getRepoFromUrl = (): string | null => {
    const match = externalUrl.match(/github\.com\/([^/]+\/[^/]+)/)
    return match ? match[1] : null
  }

  useEffect(() => {
    if (!open) return
    const repo = getRepoFromUrl()
    if (!repo) return

    setLoading(true)
    window.ticketImport
      .getAvailableStatuses(externalProvider, repo, externalId, getProviderSettings())
      .then(setStatuses)
      .catch((err) => {
        toast.error(`Failed to fetch statuses: ${err instanceof Error ? err.message : String(err)}`)
        setStatuses([])
      })
      .finally(() => setLoading(false))
  }, [open, externalProvider, externalId, externalUrl])

  const handleUpdate = async (statusId: string) => {
    const repo = getRepoFromUrl()
    if (!repo) return

    setUpdating(true)
    try {
      const result = await window.ticketImport.updateRemoteStatus(
        externalProvider,
        repo,
        externalId,
        statusId,
        getProviderSettings()
      )
      if (result.success) {
        toast.success(`Updated #${externalId} to "${statuses.find((s) => s.id === statusId)?.label}"`)
        onOpenChange(false)
      } else {
        toast.error(result.error ?? 'Failed to update status')
      }
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <RefreshCw className="h-4 w-4" />
            Update status on GitHub
          </DialogTitle>
          <p className="text-xs text-muted-foreground truncate mt-1">
            #{externalId} — {ticketTitle}
          </p>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading statuses...
            </div>
          ) : (
            statuses.map((status) => (
              <Button
                key={status.id}
                variant="outline"
                size="sm"
                disabled={updating}
                onClick={() => handleUpdate(status.id)}
                className="justify-start"
              >
                {status.label}
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
