import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useProjectStore } from '@/stores'

interface Project {
  id: string
  name: string
  path: string
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
}

interface ProjectSettingsDialogProps {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange
}: ProjectSettingsDialogProps): React.JSX.Element {
  const { updateProject } = useProjectStore()

  const [setupScript, setSetupScript] = useState('')
  const [runScript, setRunScript] = useState('')
  const [archiveScript, setArchiveScript] = useState('')
  const [saving, setSaving] = useState(false)

  // Load current values when dialog opens
  useEffect(() => {
    if (open) {
      setSetupScript(project.setup_script ?? '')
      setRunScript(project.run_script ?? '')
      setArchiveScript(project.archive_script ?? '')
    }
  }, [open, project.setup_script, project.run_script, project.archive_script])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const success = await updateProject(project.id, {
        setup_script: setupScript.trim() || null,
        run_script: runScript.trim() || null,
        archive_script: archiveScript.trim() || null
      })
      if (success) {
        toast.success('Project settings saved')
        onOpenChange(false)
      } else {
        toast.error('Failed to save project settings')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
          <DialogDescription className="text-xs truncate">{project.path}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Setup Script */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Setup Script</label>
            <p className="text-xs text-muted-foreground">
              Commands to run when a new worktree is initialized. Each line is a separate command.
            </p>
            <Textarea
              value={setupScript}
              onChange={(e) => setSetupScript(e.target.value)}
              placeholder={'pnpm install\npnpm run build'}
              rows={4}
              className="font-mono text-sm resize-y"
            />
          </div>

          {/* Run Script */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Run Script</label>
            <p className="text-xs text-muted-foreground">
              Commands triggered by {'\u2318'}R. Press {'\u2318'}R again while running to kill and restart.
            </p>
            <Textarea
              value={runScript}
              onChange={(e) => setRunScript(e.target.value)}
              placeholder={'pnpm run dev'}
              rows={4}
              className="font-mono text-sm resize-y"
            />
          </div>

          {/* Archive Script */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Archive Script</label>
            <p className="text-xs text-muted-foreground">
              Commands to run before worktree archival. Failures won't block archival.
            </p>
            <Textarea
              value={archiveScript}
              onChange={(e) => setArchiveScript(e.target.value)}
              placeholder={'pnpm run clean'}
              rows={4}
              className="font-mono text-sm resize-y"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
