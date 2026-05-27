import { useState, useEffect } from 'react'
import { toast } from '@/lib/toast'
import { Brain, ImageIcon, X } from 'lucide-react'
import type { SuggestionItem } from '@shared/types/setup-suggestions'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CustomCommandsEditor } from '@/components/custom-commands/CustomCommandsEditor'
import { useProjectStore } from '@/stores'
import { LanguageIcon } from './LanguageIcon'
import { SetupScriptSuggestionsDialog } from './SetupScriptSuggestionsDialog'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import type { CustomProjectCommand } from '@/lib/custom-commands'

interface Project {
  id: string
  name: string
  path: string
  language: string | null
  custom_icon: string | null
  detected_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  worktree_create_script: string | null
  custom_commands: CustomProjectCommand[] | null
  auto_assign_port: boolean
  is_remote?: boolean
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
  const [worktreeCreateScript, setWorktreeCreateScript] = useState('')
  const [customIcon, setCustomIcon] = useState<string | null>(null)
  const [customCommands, setCustomCommands] = useState<CustomProjectCommand[]>([])
  const [autoAssignPort, setAutoAssignPort] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pickingIcon, setPickingIcon] = useState(false)
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)

  // Load current values when dialog opens
  useEffect(() => {
    if (open) {
      setSetupScript(project.setup_script ?? '')
      setRunScript(project.run_script ?? '')
      setArchiveScript(project.archive_script ?? '')
      setWorktreeCreateScript(project.worktree_create_script ?? '')
      setCustomIcon(project.custom_icon ?? null)
      setCustomCommands(project.custom_commands ?? [])
      setAutoAssignPort(project.auto_assign_port ?? false)
      setSuggestionsOpen(false)

      if (project.is_remote === true) {
        setSuggestions([])
        return
      }

      let cancelled = false
      window.projectOps
        .detectSetupSuggestions(project.path)
        .then((envelope) => {
          if (!cancelled) {
            setSuggestions(unwrapEnvelope(envelope))
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSuggestions([])
          }
        })

      return () => {
        cancelled = true
      }
    }
    setSuggestions([])
    setSuggestionsOpen(false)
    return undefined
  }, [
    open,
    project.path,
    project.is_remote,
    project.setup_script,
    project.run_script,
    project.archive_script,
    project.worktree_create_script,
    project.custom_icon,
    project.custom_commands,
    project.auto_assign_port
  ])

  const handlePickIcon = async (): Promise<void> => {
    setPickingIcon(true)
    try {
      const result = unwrapEnvelope(await window.projectOps.pickProjectIcon(project.id))
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
      unwrapEnvelope(await window.projectOps.removeProjectIcon(project.id))
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
        worktree_create_script: worktreeCreateScript.trim() || null,
        custom_commands: customCommands.filter(
          (command) => command.name.trim() !== '' && command.prompt.trim() !== ''
        ),
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
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setSuggestionsOpen(false)
          }
          onOpenChange(nextOpen)
        }}
      >
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Project Settings</DialogTitle>
            <DialogDescription className="text-xs truncate">{project.path}</DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="general">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="custom-commands">Custom Commands</TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-5">
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
                      detectedIcon={project.detected_icon}
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
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">Setup Script</label>
                  {suggestions.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => setSuggestionsOpen(true)}
                      aria-label="Suggest setup script commands"
                      title="Suggest setup script commands"
                    >
                      <Brain className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Commands to run when a new worktree is initialized. Each line is a separate
                  command.
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

              {/* Worktree Create Script */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Worktree Create Script</label>
                <p className="text-xs text-muted-foreground">
                  Advanced. When set, this script replaces Hive&apos;s built-in{' '}
                  <code className="font-mono text-[0.7rem]">git worktree add</code> call. Use for
                  repos that need special handling (e.g. git-crypt, sparse-checkout). The script
                  must create a worktree at{' '}
                  <code className="font-mono text-[0.7rem]">$HIVE_WORKTREE_PATH</code> on branch{' '}
                  <code className="font-mono text-[0.7rem]">$HIVE_BRANCH_NAME</code>. Available env
                  vars: <code className="font-mono text-[0.7rem]">HIVE_WORKTREE_PATH</code>,{' '}
                  <code className="font-mono text-[0.7rem]">HIVE_BRANCH_NAME</code>,{' '}
                  <code className="font-mono text-[0.7rem]">HIVE_BASE_BRANCH</code>,{' '}
                  <code className="font-mono text-[0.7rem]">HIVE_PROJECT_PATH</code>,{' '}
                  <code className="font-mono text-[0.7rem]">HIVE_WORKTREE_MODE</code> (
                  <code className="font-mono text-[0.7rem]">new</code> |{' '}
                  <code className="font-mono text-[0.7rem]">existing</code> |{' '}
                  <code className="font-mono text-[0.7rem]">duplicate</code>). In{' '}
                  <code className="font-mono text-[0.7rem]">duplicate</code> mode, also receives{' '}
                  <code className="font-mono text-[0.7rem]">HIVE_SOURCE_WORKTREE_PATH</code> and{' '}
                  <code className="font-mono text-[0.7rem]">HIVE_SOURCE_BRANCH</code>.
                </p>
                <Textarea
                  value={worktreeCreateScript}
                  onChange={(e) => setWorktreeCreateScript(e.target.value)}
                  placeholder={
                    'git worktree add --no-checkout "$HIVE_WORKTREE_PATH" -b "$HIVE_BRANCH_NAME" "$HIVE_BASE_BRANCH"\n# ... any tool-specific post-create work, e.g. copying encryption keys ...\ngit -C "$HIVE_WORKTREE_PATH" reset --hard HEAD'
                  }
                  rows={5}
                  className="font-mono text-sm resize-y"
                />
              </div>
            </TabsContent>

            <TabsContent value="custom-commands">
              <CustomCommandsEditor value={customCommands} onChange={setCustomCommands} />
            </TabsContent>
          </Tabs>

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
      <SetupScriptSuggestionsDialog
        open={suggestionsOpen}
        onOpenChange={setSuggestionsOpen}
        items={suggestions}
        currentValue={setupScript}
        onApply={setSetupScript}
      />
    </>
  )
}
