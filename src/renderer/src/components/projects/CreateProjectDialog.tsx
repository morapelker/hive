import { useState, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useProjectStore, useSettingsStore } from '@/stores'
import { projectToast } from '@/lib/toast'
import { projectApi } from '@/api/project-api'

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateProjectDialog({
  open,
  onOpenChange
}: CreateProjectDialogProps): React.JSX.Element {
  const [location, setLocation] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { addProject } = useProjectStore()

  useEffect(() => {
    if (open) {
      setLocation((prev) => prev ?? useSettingsStore.getState().lastProjectDirectory)
      setName('')
      setError(null)
      setIsCreating(false)
    }
  }, [open])

  const handleBrowse = useCallback(async (): Promise<void> => {
    const selectedPath = await projectApi.openDirectoryDialog()
    if (selectedPath) {
      setLocation(selectedPath)
      setError(null)
    }
  }, [])

  const trimmedName = name.trim()
  const projectPath = location && trimmedName ? `${location}/${trimmedName}` : null
  const canCreate = !!location && !!trimmedName && !isCreating

  const handleCreate = useCallback(async (): Promise<void> => {
    if (!location || !trimmedName) return

    setIsCreating(true)
    setError(null)
    try {
      const result = await projectApi.createProjectFolder(location, trimmedName)
      if (!result.success || !result.path) {
        setError(result.error || 'Failed to create project folder.')
        return
      }

      void useSettingsStore.getState().updateSetting('lastProjectDirectory', location)

      const addResult = await addProject(result.path)
      if (!addResult.success) {
        setError(addResult.error || 'Failed to add project.')
        return
      }

      projectToast.added(trimmedName)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project.')
    } finally {
      setIsCreating(false)
    }
  }, [location, trimmedName, addProject, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isCreating && onOpenChange(isOpen)}>
      <DialogContent className="sm:max-w-md" data-testid="create-project-dialog">
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
          <DialogDescription>
            Choose a location and name for your new project. Hive will create the folder, initialize
            a Git repository, and add it to your projects.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="create-project-location" className="text-sm font-medium">
              Location
            </label>
            <div className="flex gap-2">
              <Input
                id="create-project-location"
                readOnly
                value={location ?? ''}
                placeholder="Select a folder…"
                className="flex-1 cursor-pointer"
                onClick={handleBrowse}
                data-testid="create-project-location"
              />
              <Button variant="outline" onClick={handleBrowse} disabled={isCreating}>
                Browse…
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="create-project-name" className="text-sm font-medium">
              Project name
            </label>
            <Input
              id="create-project-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              placeholder="my-project"
              disabled={isCreating}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canCreate) {
                  void handleCreate()
                }
              }}
              data-testid="create-project-name-input"
            />
          </div>
          {projectPath && (
            <p className="font-mono text-xs bg-muted rounded px-2 py-1 break-all">{projectPath}</p>
          )}
          {error && (
            <p className="text-sm text-destructive" data-testid="create-project-error">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canCreate} data-testid="create-project-confirm">
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
