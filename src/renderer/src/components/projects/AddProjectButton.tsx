import { useState, useCallback, useEffect } from 'react'
import { Plus, Loader2, FolderPlus, FolderOpen, Github } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useProjectStore } from '@/stores'
import { projectToast, toast } from '@/lib/toast'
import { GitInitDialog } from './GitInitDialog'
import { CreateProjectDialog } from './CreateProjectDialog'
import { AddRepositoryDialog } from './AddRepositoryDialog'
import { projectApi } from '@/api/project-api'

export function AddProjectButton(): React.JSX.Element {
  const [isAdding, setIsAdding] = useState(false)
  const [gitInitPath, setGitInitPath] = useState<string | null>(null)
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false)
  const [isAddRepositoryOpen, setIsAddRepositoryOpen] = useState(false)
  const { addProject } = useProjectStore()

  const handleAddExisting = useCallback(async (): Promise<void> => {
    if (isAdding) return

    setIsAdding(true)
    try {
      // Open folder picker dialog
      const selectedPath = await projectApi.openDirectoryDialog()

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
        retry: () => handleAddExisting()
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add project', {
        retry: () => handleAddExisting()
      })
    } finally {
      setIsAdding(false)
    }
  }, [isAdding, addProject])

  useEffect(() => {
    const handler = (): void => {
      handleAddExisting()
    }
    window.addEventListener('hive:add-project', handler)
    return () => window.removeEventListener('hive:add-project', handler)
  }, [handleAddExisting])

  const handleInitRepository = useCallback(async (): Promise<void> => {
    if (!gitInitPath) return

    const initResult = await projectApi.initRepository(gitInitPath)
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Add Project"
            disabled={isAdding}
            data-testid="add-project-button"
          >
            {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[190px]">
          <DropdownMenuItem
            onSelect={() => setIsCreateProjectOpen(true)}
            data-testid="add-project-menu-new"
          >
            <FolderPlus className="h-4 w-4 mr-2" />
            New project
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void handleAddExisting()}
            data-testid="add-project-menu-existing"
          >
            <FolderOpen className="h-4 w-4 mr-2" />
            Add existing project
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setIsAddRepositoryOpen(true)}
            data-testid="add-project-menu-repository"
          >
            <Github className="h-4 w-4 mr-2" />
            Add repository
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <GitInitDialog
        open={!!gitInitPath}
        path={gitInitPath || ''}
        onCancel={() => setGitInitPath(null)}
        onConfirm={handleInitRepository}
      />
      <CreateProjectDialog open={isCreateProjectOpen} onOpenChange={setIsCreateProjectOpen} />
      <AddRepositoryDialog open={isAddRepositoryOpen} onOpenChange={setIsAddRepositoryOpen} />
    </>
  )
}
