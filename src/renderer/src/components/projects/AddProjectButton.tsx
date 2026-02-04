import { useState, useCallback } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/stores'
import { projectToast, toast } from '@/lib/toast'

export function AddProjectButton(): React.JSX.Element {
  const [isAdding, setIsAdding] = useState(false)
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

      if (result.success && result.project) {
        projectToast.added(result.project.name)
      } else {
        toast.error(result.error || 'Failed to add project', {
          retry: () => handleAddProject()
        })
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add project', {
        retry: () => handleAddProject()
      })
    } finally {
      setIsAdding(false)
    }
  }, [isAdding, addProject])

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      title="Add Project"
      onClick={handleAddProject}
      disabled={isAdding}
      data-testid="add-project-button"
    >
      {isAdding ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Plus className="h-4 w-4" />
      )}
    </Button>
  )
}
