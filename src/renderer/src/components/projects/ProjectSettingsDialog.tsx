import { useState, useEffect } from 'react'
import { toast } from '@/lib/toast'
import { ImageIcon, X } from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
import { useProjectStore } from '@/stores'
import { LanguageIcon } from './LanguageIcon'

interface Project {
  id: string
  name: string
  path: string
  language: string | null
  custom_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  auto_assign_port: boolean
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
  const [customIcon, setCustomIcon] = useState<string | null>(null)
  const [autoAssignPort, setAutoAssignPort] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pickingIcon, setPickingIcon] = useState(false)

  // Load current values when dialog opens
  useEffect(() => {
    if (open) {
      setSetupScript(project.setup_script ?? '')
      setRunScript(project.run_script ?? '')
      setArchiveScript(project.archive_script ?? '')
      setCustomIcon(project.custom_icon ?? null)
      setAutoAssignPort(project.auto_assign_port ?? false)
    }
  }, [
    open,
    project.setup_script,
    project.run_script,
    project.archive_script,
    project.custom_icon,
    project.auto_assign_port
  ])

  const handlePickIcon = async (): Promise<void> => {
    setPickingIcon(true)
    try {
      const result = await window.projectOps.pickProjectIcon(project.id)
      if (result.success && result.filename) {
        setCustomIcon(result.filename)
      }
      // If cancelled, do nothing
    } catch {
      toast.error('Failed to pick icon')
    } finally {
      setPickingIcon(false)
    }
  }

  const handleClearIcon = async (): Promise<void> => {
    try {
      await window.projectOps.removeProjectIcon(project.id)
      setCustomIcon(null)
    } catch {
      toast.error('Failed to remove icon')
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const success = await updateProject(project.id, {
        setup_script: setupScript.trim() || null,
        run_script: runScript.trim() || null,
        archive_script: archiveScript.trim() || null,
        custom_icon: customIcon,
        auto_assign_port: autoAssignPort
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
          {/* Project Icon */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Project Icon</label>
            <p className="text-xs text-muted-foreground">
              Custom icon displayed in the sidebar. Supports SVG, PNG, JPG, and WebP.
            </p>
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 flex items-center justify-center rounded-md border border-border bg-muted/30">
                <LanguageIcon
                  language={project.language}
                  customIcon={customIcon}
                  className="h-5 w-5 text-muted-foreground shrink-0"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handlePickIcon}
                  disabled={pickingIcon}
                >
                  <ImageIcon className="h-3 w-3 mr-1.5" />
                  {pickingIcon ? 'Picking...' : 'Change'}
                </Button>
                {customIcon && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleClearIcon}
                  >
                    <X className="h-3 w-3 mr-1.5" />
                    Clear
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Auto Port Assignment */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Auto-assign Port</label>
                <p className="text-xs text-muted-foreground">
                  Assign a unique port to each worktree and inject PORT into run/setup scripts.
                  Ports start at 3011.
                </p>
              </div>
              <Switch checked={autoAssignPort} onCheckedChange={setAutoAssignPort} />
            </div>
          </div>

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
              Commands triggered by {'\u2318'}R. Press {'\u2318'}R again while running to stop.
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
