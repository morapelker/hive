import { useState, useEffect, useId } from 'react'
import { toast } from '@/lib/toast'
import { Brain, ChevronDown, Folder, FolderKanban, FolderPlus, ImageIcon, X } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CustomCommandsEditor } from '@/components/custom-commands/CustomCommandsEditor'
import { useProjectStore } from '@/stores/useProjectStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { LanguageIcon } from './LanguageIcon'
import { SetupScriptSuggestionsDialog } from './SetupScriptSuggestionsDialog'
import { kanbanApi } from '@/api/kanban-api'
import { projectApi } from '@/api/project-api'
import type { CustomProjectCommand } from '@/lib/custom-commands'
import { formatSelectedKanbanFolder } from './kanban-folder-paths'

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
  kanban_storage_mode?: 'internal' | 'markdown'
  kanban_markdown_config?: string | null
  is_remote?: boolean
}

type MarkdownLayout = 'single-folder' | 'status-folders'
type MarkdownConfig =
  | {
      layout: 'single-folder'
      singleFolder: string
      statusFolders?: { todo: string; in_progress: string; review: string; done: string }
    }
  | {
      layout: 'status-folders'
      singleFolder?: string
      statusFolders: { todo: string; in_progress: string; review: string; done: string }
    }

const DEFAULT_MARKDOWN_FOLDERS = {
  singleFolder: 'docs/kanban',
  todo: 'docs/kanban/todo',
  inProgress: 'docs/kanban/in-progress',
  review: 'docs/kanban/review',
  done: 'docs/kanban/done'
}

const folderOrDefault = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || fallback
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
  const { updateProject, loadProjects } = useProjectStore()
  const worktreeCreateScriptContentId = useId()

  const [setupScript, setSetupScript] = useState('')
  const [runScript, setRunScript] = useState('')
  const [archiveScript, setArchiveScript] = useState('')
  const [worktreeCreateScript, setWorktreeCreateScript] = useState('')
  const [worktreeCreateScriptExpanded, setWorktreeCreateScriptExpanded] = useState(false)
  const [customIcon, setCustomIcon] = useState<string | null>(null)
  const [customCommands, setCustomCommands] = useState<CustomProjectCommand[]>([])
  const [autoAssignPort, setAutoAssignPort] = useState(false)
  const [kanbanMode, setKanbanMode] = useState<'internal' | 'markdown'>('internal')
  const [kanbanLayout, setKanbanLayout] = useState<MarkdownLayout>('single-folder')
  const [singleFolder, setSingleFolder] = useState('docs/kanban')
  const [todoFolder, setTodoFolder] = useState('docs/kanban/todo')
  const [inProgressFolder, setInProgressFolder] = useState('docs/kanban/in-progress')
  const [reviewFolder, setReviewFolder] = useState('docs/kanban/review')
  const [doneFolder, setDoneFolder] = useState('docs/kanban/done')
  const [kanbanConfigError, setKanbanConfigError] = useState<string | null>(null)
  const [canCreateKanbanFolders, setCanCreateKanbanFolders] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pickingIcon, setPickingIcon] = useState(false)
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [initializedProjectId, setInitializedProjectId] = useState<string | null>(null)
  const [initialProject, setInitialProject] = useState<Project | null>(null)

  useEffect(() => {
    if (!open) {
      setInitializedProjectId(null)
      setInitialProject(null)
      setSuggestions([])
      setSuggestionsOpen(false)
      return
    }

    if (initializedProjectId !== project.id) {
      setInitializedProjectId(project.id)
      setInitialProject(project)
    }
  }, [open, project, initializedProjectId])

  // Load current values once per dialog-open/project combination. Later save echoes should not
  // reset in-progress edits while the same project remains open.
  useEffect(() => {
    if (!open || !initialProject || initializedProjectId !== initialProject.id) {
      return undefined
    }

    let cancelled = false
    setSetupScript(initialProject.setup_script ?? '')
    setRunScript(initialProject.run_script ?? '')
    setArchiveScript(initialProject.archive_script ?? '')
    setWorktreeCreateScript(initialProject.worktree_create_script ?? '')
    setWorktreeCreateScriptExpanded((initialProject.worktree_create_script ?? '').trim().length > 0)
    setCustomIcon(initialProject.custom_icon ?? null)
    setCustomCommands(initialProject.custom_commands ?? [])
    setAutoAssignPort(initialProject.auto_assign_port ?? false)
    setKanbanMode(initialProject.kanban_storage_mode ?? 'internal')
    setKanbanConfigError(null)
    setCanCreateKanbanFolders(false)
    setSuggestionsOpen(false)

    kanbanApi.config
      .get<{ mode: 'internal' | 'markdown'; markdown: MarkdownConfig }>(initialProject.id)
      .then((config) => {
        if (cancelled) return
        setKanbanMode(config.mode)
        setKanbanLayout(config.markdown.layout)
        setSingleFolder(
          config.markdown.layout === 'single-folder'
            ? folderOrDefault(config.markdown.singleFolder, DEFAULT_MARKDOWN_FOLDERS.singleFolder)
            : DEFAULT_MARKDOWN_FOLDERS.singleFolder
        )
        const statusFolders = config.markdown.statusFolders ?? {
          todo: DEFAULT_MARKDOWN_FOLDERS.todo,
          in_progress: DEFAULT_MARKDOWN_FOLDERS.inProgress,
          review: DEFAULT_MARKDOWN_FOLDERS.review,
          done: DEFAULT_MARKDOWN_FOLDERS.done
        }
        setTodoFolder(folderOrDefault(statusFolders.todo, DEFAULT_MARKDOWN_FOLDERS.todo))
        setInProgressFolder(
          folderOrDefault(statusFolders.in_progress, DEFAULT_MARKDOWN_FOLDERS.inProgress)
        )
        setReviewFolder(folderOrDefault(statusFolders.review, DEFAULT_MARKDOWN_FOLDERS.review))
        setDoneFolder(folderOrDefault(statusFolders.done, DEFAULT_MARKDOWN_FOLDERS.done))
      })
      .catch(() => {
        if (cancelled) return
        setKanbanConfigError('Failed to load Kanban storage settings')
      })

    if (initialProject.is_remote === true) {
      setSuggestions([])
      return () => {
        cancelled = true
      }
    }

    projectApi
      .detectSetupSuggestions(initialProject.path)
      .then((items) => {
        if (!cancelled) {
          setSuggestions(items)
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
  }, [open, initializedProjectId, initialProject])

  const handlePickIcon = async (): Promise<void> => {
    setPickingIcon(true)
    try {
      const result = await projectApi.pickProjectIcon(project.id)
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
      await projectApi.removeProjectIcon(project.id)
      setCustomIcon(null)
    } catch {
      toast.error('Failed to remove icon')
    }
  }

  const handlePickKanbanFolder = async (setFolder: (value: string) => void): Promise<void> => {
    try {
      const selectedPath = await kanbanApi.config.pickMarkdownFolder()
      if (!selectedPath) return
      setFolder(formatSelectedKanbanFolder(project.path, selectedPath))
    } catch {
      toast.error('Failed to choose Kanban folder')
    }
  }

  const renderKanbanFolderInput = (
    label: string,
    value: string,
    setValue: (value: string) => void,
    pickerLabel: string
  ): React.JSX.Element => (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={pickerLabel}
          title={pickerLabel}
          onClick={() => void handlePickKanbanFolder(setValue)}
        >
          <Folder className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )

  const buildMarkdownConfig = (): MarkdownConfig =>
    kanbanLayout === 'single-folder'
      ? {
          layout: 'single-folder' as const,
          singleFolder: folderOrDefault(singleFolder, DEFAULT_MARKDOWN_FOLDERS.singleFolder),
          statusFolders: {
            todo: folderOrDefault(todoFolder, DEFAULT_MARKDOWN_FOLDERS.todo),
            in_progress: folderOrDefault(inProgressFolder, DEFAULT_MARKDOWN_FOLDERS.inProgress),
            review: folderOrDefault(reviewFolder, DEFAULT_MARKDOWN_FOLDERS.review),
            done: folderOrDefault(doneFolder, DEFAULT_MARKDOWN_FOLDERS.done)
          }
        }
      : {
          layout: 'status-folders' as const,
          singleFolder: folderOrDefault(singleFolder, DEFAULT_MARKDOWN_FOLDERS.singleFolder),
          statusFolders: {
            todo: folderOrDefault(todoFolder, DEFAULT_MARKDOWN_FOLDERS.todo),
            in_progress: folderOrDefault(inProgressFolder, DEFAULT_MARKDOWN_FOLDERS.inProgress),
            review: folderOrDefault(reviewFolder, DEFAULT_MARKDOWN_FOLDERS.review),
            done: folderOrDefault(doneFolder, DEFAULT_MARKDOWN_FOLDERS.done)
          }
        }

  const isMissingFolderError = (message: string): boolean =>
    /ENOENT|no such file|cannot find|not found/i.test(message)

  const extractMissingFolderPath = (message: string): string => {
    const quotedPath = message.match(/'([^']+)'/)?.[1]
    const path =
      quotedPath ?? (kanbanLayout === 'single-folder' ? singleFolder : 'configured folders')
    const projectPrefix = project.path.endsWith('/') ? project.path : `${project.path}/`
    return path.startsWith(projectPrefix) ? path.slice(projectPrefix.length) : path
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setKanbanConfigError(null)
    setCanCreateKanbanFolders(false)
    try {
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
        if (!success) {
          toast.error('Failed to save project settings')
          return
        }
      } catch {
        toast.error('Failed to save project settings')
        return
      }

      if (kanbanMode === 'markdown') {
        await kanbanApi.config.update(project.id, buildMarkdownConfig())
      }
      const modeResult = await kanbanApi.config.setMode(project.id, kanbanMode)
      if (!modeResult.success) {
        const message = modeResult.error ?? 'Kanban storage mode could not be changed'
        setKanbanConfigError(message)
        setCanCreateKanbanFolders(kanbanMode === 'markdown' && isMissingFolderError(message))
        return
      }

      await loadProjects()
      await useKanbanStore.getState().loadTickets(project.id)
      toast.success('Project settings saved')
      onOpenChange(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save Kanban settings'
      setKanbanConfigError(message)
      setCanCreateKanbanFolders(kanbanMode === 'markdown' && isMissingFolderError(message))
    } finally {
      setSaving(false)
    }
  }

  const handleCreateKanbanFolders = async (): Promise<void> => {
    setSaving(true)
    setKanbanConfigError(null)
    setCanCreateKanbanFolders(false)
    try {
      const result = await kanbanApi.config.createFolders(project.id, buildMarkdownConfig())
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to create Kanban folders')
      }
      await handleSave()
    } catch (error) {
      setKanbanConfigError(
        error instanceof Error ? error.message : 'Failed to create Kanban folders'
      )
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

              <div className="space-y-3 rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-2">
                  <FolderKanban className="h-4 w-4 text-muted-foreground" />
                  <label className="text-sm font-medium">Kanban Storage</label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={kanbanMode === 'internal' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setKanbanMode('internal')}
                  >
                    Internal
                  </Button>
                  <Button
                    type="button"
                    variant={kanbanMode === 'markdown' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setKanbanMode('markdown')}
                  >
                    Markdown
                  </Button>
                </div>

                {kanbanMode === 'markdown' && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant={kanbanLayout === 'single-folder' ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => setKanbanLayout('single-folder')}
                      >
                        One folder
                      </Button>
                      <Button
                        type="button"
                        variant={kanbanLayout === 'status-folders' ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => setKanbanLayout('status-folders')}
                      >
                        Status folders
                      </Button>
                    </div>

                    {kanbanLayout === 'single-folder' ? (
                      renderKanbanFolderInput(
                        'Folder',
                        singleFolder,
                        setSingleFolder,
                        'Choose Kanban folder'
                      )
                    ) : (
                      <div className="grid gap-2">
                        {renderKanbanFolderInput(
                          'To Do',
                          todoFolder,
                          setTodoFolder,
                          'Choose To Do Kanban folder'
                        )}
                        {renderKanbanFolderInput(
                          'In Progress',
                          inProgressFolder,
                          setInProgressFolder,
                          'Choose In Progress Kanban folder'
                        )}
                        {renderKanbanFolderInput(
                          'Review',
                          reviewFolder,
                          setReviewFolder,
                          'Choose Review Kanban folder'
                        )}
                        {renderKanbanFolderInput(
                          'Done',
                          doneFolder,
                          setDoneFolder,
                          'Choose Done Kanban folder'
                        )}
                      </div>
                    )}

                    {kanbanConfigError && canCreateKanbanFolders ? (
                      <div
                        data-testid="kanban-missing-folders-state"
                        className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
                      >
                        <div className="flex items-start gap-2">
                          <FolderPlus className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="font-medium text-amber-100">
                              Kanban folder needs to be created
                            </p>
                            <p className="text-amber-100/75">
                              Hive could not find{' '}
                              <code className="rounded bg-background/40 px-1 py-0.5 font-mono text-[11px] text-amber-100">
                                {extractMissingFolderPath(kanbanConfigError)}
                              </code>
                              . Create it to enable Markdown Kanban for this project.
                            </p>
                          </div>
                        </div>
                        <div className="mt-2 flex justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 border-amber-400/40 bg-amber-400/10 text-xs text-amber-100 hover:bg-amber-400/15 hover:text-amber-50"
                            disabled={saving}
                            onClick={handleCreateKanbanFolders}
                          >
                            Create folder and enable
                          </Button>
                        </div>
                      </div>
                    ) : kanbanConfigError ? (
                      <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                        <p>{kanbanConfigError}</p>
                      </div>
                    ) : null}
                  </>
                )}
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
              <div className="rounded-md border border-border bg-muted/20">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
                  onClick={() => setWorktreeCreateScriptExpanded((expanded) => !expanded)}
                  aria-expanded={worktreeCreateScriptExpanded}
                  aria-controls={worktreeCreateScriptContentId}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                        worktreeCreateScriptExpanded ? '' : '-rotate-90'
                      }`}
                    />
                    <span className="text-sm font-medium">Worktree Create Script</span>
                    <span className="rounded border border-border px-1.5 py-0.5 text-[0.65rem] font-medium uppercase leading-none text-muted-foreground">
                      Advanced
                    </span>
                  </span>
                  {worktreeCreateScript.trim().length > 0 && (
                    <span className="shrink-0 text-xs text-muted-foreground">Configured</span>
                  )}
                </button>
                {worktreeCreateScriptExpanded && (
                  <div
                    id={worktreeCreateScriptContentId}
                    className="space-y-1.5 border-t border-border px-3 py-3"
                  >
                    <p className="text-xs text-muted-foreground">
                      When set, this script replaces Hive&apos;s built-in{' '}
                      <code className="font-mono text-[0.7rem]">git worktree add</code> call. Use
                      for repos that need special handling (e.g. git-crypt, sparse-checkout). The
                      script must create a worktree at{' '}
                      <code className="font-mono text-[0.7rem]">$HIVE_WORKTREE_PATH</code> on branch{' '}
                      <code className="font-mono text-[0.7rem]">$HIVE_BRANCH_NAME</code>. Available
                      env vars: <code className="font-mono text-[0.7rem]">HIVE_WORKTREE_PATH</code>,{' '}
                      <code className="font-mono text-[0.7rem]">HIVE_BRANCH_NAME</code>,{' '}
                      <code className="font-mono text-[0.7rem]">HIVE_BASE_BRANCH</code>{' '}
                      (human-readable base branch name),{' '}
                      <code className="font-mono text-[0.7rem]">HIVE_BASE_REF</code> (git ref to use
                      with <code className="font-mono text-[0.7rem]">git worktree add</code>; equals{' '}
                      <code className="font-mono text-[0.7rem]">HIVE_BASE_BRANCH</code> in most
                      flows, but is <code className="font-mono text-[0.7rem]">FETCH_HEAD</code> when
                      checking out a pull-request ref),{' '}
                      <code className="font-mono text-[0.7rem]">HIVE_PROJECT_PATH</code>,{' '}
                      <code className="font-mono text-[0.7rem]">HIVE_WORKTREE_MODE</code> (
                      <code className="font-mono text-[0.7rem]">new</code> |{' '}
                      <code className="font-mono text-[0.7rem]">existing</code> |{' '}
                      <code className="font-mono text-[0.7rem]">duplicate</code>). In{' '}
                      <code className="font-mono text-[0.7rem]">duplicate</code> mode, also receives{' '}
                      <code className="font-mono text-[0.7rem]">HIVE_SOURCE_WORKTREE_PATH</code> and{' '}
                      <code className="font-mono text-[0.7rem]">HIVE_SOURCE_BRANCH</code>. Scripts
                      run via <code className="font-mono text-[0.7rem]">/bin/sh -c</code> by
                      default; a{' '}
                      <code className="font-mono text-[0.7rem]">#!/usr/bin/env bash</code> or{' '}
                      <code className="font-mono text-[0.7rem]">#!/bin/bash</code> shebang on the
                      first line switches to{' '}
                      <code className="font-mono text-[0.7rem]">bash -c</code>. Hive aborts the
                      script (and its whole process group) after 5 minutes if it does not exit, and
                      best-effort cleans up any partial worktree/branch on failure.
                    </p>
                    <Textarea
                      value={worktreeCreateScript}
                      onChange={(e) => setWorktreeCreateScript(e.target.value)}
                      placeholder={
                        'git worktree add --no-checkout "$HIVE_WORKTREE_PATH" -b "$HIVE_BRANCH_NAME" "$HIVE_BASE_REF"\n# ... any tool-specific post-create work, e.g. copying encryption keys ...\ngit -C "$HIVE_WORKTREE_PATH" reset --hard HEAD'
                      }
                      rows={5}
                      className="font-mono text-sm resize-y"
                    />
                  </div>
                )}
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
