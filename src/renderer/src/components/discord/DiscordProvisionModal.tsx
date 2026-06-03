import { useEffect, useMemo, useState } from 'react'
import { Hash, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Project } from '@shared/types/project'
import type { DiscordProvisionProgress } from '@shared/types/discord'
import { dbApi } from '@/api/db-api'
import { discordApi } from '@/api/discord-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useDiscordStore } from '@/stores/useDiscordStore'

interface DiscordProvisionModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DiscordProvisionModal({
  open,
  onOpenChange
}: DiscordProvisionModalProps): React.JSX.Element {
  const config = useDiscordStore((s) => s.config)
  const refreshDiscord = useDiscordStore((s) => s.refresh)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [provisioning, setProvisioning] = useState(false)
  const [progress, setProgress] = useState<DiscordProvisionProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setProgress(null)
    setSelectedIds(new Set(config?.selectedProjectIds ?? []))
    setLoadingProjects(true)
    dbApi.project
      .getAll<Project>()
      .then(setProjects)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoadingProjects(false))
  }, [config?.selectedProjectIds, open])

  useEffect(() => {
    if (!open) return
    return discordApi.onProvisionProgress((next) => {
      setProgress(next)
    })
  }, [open])

  const selectedProjectIds = useMemo(() => Array.from(selectedIds), [selectedIds])
  const percent = progress?.total ? Math.min(100, (progress.current / progress.total) * 100) : 0

  const toggleProject = (projectId: string, checked: boolean): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(projectId)
      else next.delete(projectId)
      return next
    })
  }

  const approve = async (): Promise<void> => {
    setProvisioning(true)
    setError(null)
    setProgress(null)
    try {
      const summary = await discordApi.provision(selectedProjectIds)
      await refreshDiscord()
      toast.success(`Discord provisioned: ${summary.created} created, ${summary.deleted} deleted`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProvisioning(false)
    }
  }

  const disable = async (): Promise<void> => {
    setProvisioning(true)
    setError(null)
    try {
      const result = await discordApi.disable()
      await refreshDiscord()
      if (result.ok) {
        toast.success('Discord mode disabled')
      } else {
        setError(result.error ?? 'Failed to disable Discord mode')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProvisioning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="discord-provision-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Hash className="h-4 w-4" />
            Discord Provisioning
          </DialogTitle>
          <DialogDescription>
            Provisioning into: <span className="font-medium">{config?.guildName || 'Discord'}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="max-h-72 overflow-y-auto rounded-md border">
            {loadingProjects ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading projects
              </div>
            ) : projects.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No projects found.</div>
            ) : (
              projects.map((project) => (
                <label
                  key={project.id}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{project.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.path}
                    </span>
                  </span>
                  <Switch
                    checked={selectedIds.has(project.id)}
                    onCheckedChange={(checked) => toggleProject(project.id, checked)}
                    disabled={provisioning}
                    data-testid={`discord-project-switch-${project.id}`}
                  />
                </label>
              ))
            )}
          </div>

          {(provisioning || progress) && (
            <div className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                <span className="truncate">{progress?.label ?? 'Starting provisioning'}</span>
                <span>
                  {progress?.current ?? 0}/{progress?.total ?? selectedProjectIds.length}
                </span>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
          <Button
            variant="outline"
            disabled={provisioning}
            onClick={() => void disable()}
            data-testid="discord-disable-button"
          >
            Disable Discord mode
          </Button>
          <Button
            disabled={provisioning || loadingProjects}
            onClick={() => void approve()}
            data-testid="discord-approve-button"
          >
            {provisioning ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
