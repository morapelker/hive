import { useState, useCallback, useEffect } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useProjectStore } from '@/stores'
import { useIsWebMode } from '@/hooks/useIsWebMode'
import { projectToast, toast } from '@/lib/toast'
import { GitInitDialog } from './GitInitDialog'

export function AddProjectButton(): React.JSX.Element {
  const isWebMode = useIsWebMode()
  const [isAdding, setIsAdding] = useState(false)
  const [gitInitPath, setGitInitPath] = useState<string | null>(null)
  const [showPathInput, setShowPathInput] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const { addProject } = useProjectStore()

  const handleAddProjectFromPath = useCallback(async (path: string): Promise<void> => {
    if (!path.trim()) return

    setIsAdding(true)
    try {
      const result = await addProject(path.trim())

      if (result.success) {
        projectToast.added(path.trim().split('/').pop() || path.trim())
        setShowPathInput(false)
        setManualPath('')
        return
      }

      if (result.error?.includes('not a Git repository')) {
        setGitInitPath(path.trim())
        setShowPathInput(false)
        setManualPath('')
        return
      }

      toast.error(result.error || 'Failed to add project')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add project')
    } finally {
      setIsAdding(false)
    }
  }, [addProject])

  const handleAddProject = useCallback(async (): Promise<void> => {
    if (isAdding) return

    if (isWebMode) {
      setShowPathInput(true)
      return
    }

    setIsAdding(true)
    try {
      // Open folder picker dialog
      const selectedPath = await window.projectOps.openDirectoryDialog()

      if (!selectedPath) {
        // User cancelled the dialog
        return
      }

      // Add the project
      const result = await addProject(selectedPath)

      if (result.success) {
        projectToast.added(selectedPath.split('/').pop() || selectedPath)
        return
      }

      // Check if the error is about not being a git repo
      if (result.error?.includes('not a Git repository')) {
        setGitInitPath(selectedPath)
        return
      }

      toast.error(result.error || 'Failed to add project', {
        retry: () => handleAddProject()
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add project', {
        retry: () => handleAddProject()
      })
    } finally {
      setIsAdding(false)
    }
  }, [isAdding, isWebMode, addProject])

  useEffect(() => {
    const handler = (): void => {
      handleAddProject()
    }
    window.addEventListener('hive:add-project', handler)
    return () => window.removeEventListener('hive:add-project', handler)
  }, [handleAddProject])

  const handleInitRepository = useCallback(async (): Promise<void> => {
    if (!gitInitPath) return

    const initResult = await window.projectOps.initRepository(gitInitPath)
    if (!initResult.success) {
      toast.error(initResult.error || 'Failed to initialize repository')
      setGitInitPath(null)
      return
    }

    toast.success('Git repository initialized')

    // Retry adding the project
    const addResult = await addProject(gitInitPath)
    if (!addResult.success) {
      toast.error(addResult.error || 'Failed to add project')
    } else {
      projectToast.added(gitInitPath.split('/').pop() || gitInitPath)
    }
    setGitInitPath(null)
  }, [gitInitPath, addProject])

  return (
    <>
      {showPathInput && isWebMode ? (
        <div className="flex items-center gap-1">
          <Input
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddProjectFromPath(manualPath)
              if (e.key === 'Escape') {
                setShowPathInput(false)
                setManualPath('')
              }
            }}
            placeholder="/path/to/project"
            className="h-6 text-xs font-mono w-48"
            autoFocus
            data-testid="add-project-path-input"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => handleAddProjectFromPath(manualPath)}
            disabled={isAdding || !manualPath.trim()}
          >
            {isAdding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title="Add Project"
          onClick={handleAddProject}
          disabled={isAdding}
          data-testid="add-project-button"
        >
          {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      )}
      <GitInitDialog
        open={!!gitInitPath}
        path={gitInitPath || ''}
        onCancel={() => setGitInitPath(null)}
        onConfirm={handleInitRepository}
      />
    </>
  )
}
