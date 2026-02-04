import { useState } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/stores'

export function AddProjectButton(): React.JSX.Element {
  const [isAdding, setIsAdding] = useState(false)
  const { addProject } = useProjectStore()

  const handleAddProject = async (): Promise<void> => {
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
        toast.success('Project added successfully')
      } else {
        toast.error(result.error || 'Failed to add project')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add project')
    } finally {
      setIsAdding(false)
    }
  }

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
