import { useState, useCallback } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/stores'
import { projectToast, toast } from '@/lib/toast'
import { GitInitDialog } from './GitInitDialog'

export function AddProjectButton(): React.JSX.Element {
  const [isAdding, setIsAdding] = useState(false)
  const [gitInitPath, setGitInitPath] = useState<string | null>(null)
  const { addProject } = useProjectStore()

  const handleAddProject = useCallback(async (): Promise<void> => {
    if (isAdding) return

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
  }, [isAdding, addProject])

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
      <GitInitDialog
        open={!!gitInitPath}
        path={gitInitPath || ''}
        onCancel={() => setGitInitPath(null)}
        onConfirm={handleInitRepository}
      />
    </>
  )
}
