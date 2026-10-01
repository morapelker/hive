import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, Loader2, RefreshCw } from 'lucide-react'
import type { CliToolId, CliToolStatus } from '@shared/types/cli-tools'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { cliToolsApi } from '@/api/cli-tools-api'
import { projectApi } from '@/api/project-api'

interface CliToolsSectionProps {
  projectPath: string
  /** Called with the skill's directory name after it lands in `.claude/skills`, so the dialog
   * can re-list project skills. */
  onSkillInstalled: (skillId: string) => void
}

type Busy = 'install' | 'skill'

const MAX_LOG_CHARS = 20_000

function toolStatusText(tool: CliToolStatus): string {
  if (!tool.platformSupported) return 'Not available on this platform'
  if (!tool.installedVersion) return 'Not installed'
  if (tool.upToDate) return `Up to date · v${tool.installedVersion}`
  return `v${tool.installedVersion} · update to ${tool.latestVersion}`
}

function StatusPill({ tool }: { tool: CliToolStatus }): React.JSX.Element {
  const tone = !tool.platformSupported
    ? 'bg-muted text-muted-foreground'
    : !tool.installedVersion
      ? 'bg-muted text-muted-foreground'
      : tool.upToDate
        ? 'bg-green-500/10 text-green-600 dark:text-green-400'
        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
        tone
      )}
      data-testid={`manage-skills-tool-${tool.id}-status`}
    >
      {toolStatusText(tool)}
    </span>
  )
}

function OutputLog({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const node = ref.current
    if (node) node.scrollTop = node.scrollHeight
  }, [text])
  return (
    <pre
      ref={ref}
      className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-snug text-muted-foreground"
      data-testid="manage-skills-tool-log"
    >
      {text || 'Starting...'}
    </pre>
  )
}

function ManualCommand({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(async () => {
    try {
      await projectApi.copyToClipboard(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy the command')
    }
  }, [command])
  return (
    <div className="mt-1.5 flex items-center gap-1.5 min-w-0">
      <code className="min-w-0 flex-1 truncate rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
        {command}
      </code>
      <Button variant="ghost" size="icon-xs" onClick={copy} title="Copy command">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}

interface ToolRowProps {
  tool: CliToolStatus
  busy: Busy | null
  log: string
  error: string | null
  onInstall: (toolId: CliToolId) => void
  onInstallSkill: (toolId: CliToolId) => void
}

function globalSkillUpdateHint(tool: CliToolStatus): string {
  return tool.id === 'playwright-cli'
    ? 'The global copy is older than the one shipped with the installed CLI. Update it with: playwright-cli install --skills --global'
    : `The global copy is older than the one shipped with the installed CLI. Replace ~/.claude/skills/${tool.skillId} with ~/.local/share/tcu/${tool.installedVersion ?? '<version>'}/skills/${tool.skillId}`
}

function ToolRow({
  tool,
  busy,
  log,
  error,
  onInstall,
  onInstallSkill
}: ToolRowProps): React.JSX.Element {
  const installed = tool.installedVersion !== null
  const showInstall = tool.platformSupported && (!installed || !tool.upToDate)
  const installLabel = installed ? 'Update' : 'Install'
  const disabled = busy !== null

  let skillControl: React.ReactNode
  if (!tool.platformSupported) {
    skillControl = null
  } else if (tool.skill.inGlobal) {
    // A global copy serves every project, so no project install is offered — but a stale one
    // is worth knowing about, since the CLI only nags about the project copy.
    skillControl = tool.skill.globalOutdated ? (
      <span
        className="text-xs text-amber-600 dark:text-amber-400"
        title={globalSkillUpdateHint(tool)}
        data-testid={`manage-skills-tool-${tool.id}-global-outdated`}
      >
        Skill installed globally · outdated
      </span>
    ) : (
      <span className="text-xs text-muted-foreground">Skill installed globally</span>
    )
  } else if (tool.skill.inProject && !tool.skill.projectOutdated) {
    skillControl = <span className="text-xs text-muted-foreground">Skill installed in project</span>
  } else {
    const update = tool.skill.inProject && tool.skill.projectOutdated
    skillControl = (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || !installed}
        title={!installed ? `Install ${tool.name} first` : undefined}
        onClick={() => onInstallSkill(tool.id)}
        data-testid={`manage-skills-tool-${tool.id}-skill`}
      >
        {busy === 'skill' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : update ? (
          <RefreshCw className="h-3.5 w-3.5" />
        ) : null}
        {busy === 'skill' ? 'Adding skill...' : update ? 'Update skill' : 'Add skill to project'}
      </Button>
    )
  }

  return (
    <div className="px-3 py-2 text-sm" data-testid={`manage-skills-tool-${tool.id}`}>
      {/* Name + status on top, actions on their own row: the dialog is too narrow for both
          side by side without truncating the tool name. */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span className="font-medium">{tool.name}</span>
          <StatusPill tool={tool} />
        </div>
        <p className="truncate text-xs text-muted-foreground" title={tool.description}>
          {tool.description}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1.5">
          {skillControl}
          {showInstall && tool.canAutoInstall && (
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => onInstall(tool.id)}
              data-testid={`manage-skills-tool-${tool.id}-install`}
            >
              {busy === 'install' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {busy === 'install'
                ? `${installLabel === 'Update' ? 'Updating' : 'Installing'}...`
                : installLabel}
            </Button>
          )}
        </div>
      </div>
      {showInstall && !tool.canAutoInstall && (
        <div
          className="mt-1 text-xs text-muted-foreground"
          data-testid={`manage-skills-tool-${tool.id}-manual`}
        >
          Tedooo Code can&apos;t {installLabel.toLowerCase()} this here. Run in a terminal:
          <ManualCommand command={tool.manualInstallCommand} />
        </div>
      )}
      {tool.installHint && (
        <p
          className="mt-1 text-xs text-amber-600 dark:text-amber-400"
          data-testid={`manage-skills-tool-${tool.id}-hint`}
        >
          {tool.installHint}
        </p>
      )}
      {error && (
        <p
          className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive"
          data-testid={`manage-skills-tool-${tool.id}-error`}
        >
          {error}
        </p>
      )}
      {(busy !== null || (error && log)) && <OutputLog text={log} />}
    </div>
  )
}

export function CliToolsSection({
  projectPath,
  onSkillInstalled
}: CliToolsSectionProps): React.JSX.Element {
  const [tools, setTools] = useState<CliToolStatus[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Partial<Record<CliToolId, Busy>>>({})
  const [logs, setLogs] = useState<Partial<Record<CliToolId, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<CliToolId, string>>>({})
  // Bumped when the project changes or the section unmounts so late results are dropped.
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    setTools(null)
    setLoadError(null)
    setBusy({})
    setLogs({})
    setErrors({})
    cliToolsApi
      .list(projectPath)
      .then((result) => {
        if (generationRef.current !== generation) return
        setTools(result.tools)
      })
      .catch((error) => {
        if (generationRef.current !== generation) return
        setLoadError(error instanceof Error && error.message ? error.message : 'Unknown error')
      })
    return () => {
      generationRef.current += 1
    }
  }, [projectPath])

  const replaceTool = useCallback((status: CliToolStatus) => {
    setTools((prev) => (prev ? prev.map((tool) => (tool.id === status.id ? status : tool)) : prev))
  }, [])

  const runAction = useCallback(
    async (
      toolId: CliToolId,
      kind: Busy,
      action: () => Promise<{ success: boolean; error?: string; status?: CliToolStatus }>
    ) => {
      const generation = generationRef.current
      setBusy((prev) => ({ ...prev, [toolId]: kind }))
      setLogs((prev) => ({ ...prev, [toolId]: '' }))
      setErrors((prev) => ({ ...prev, [toolId]: undefined }))
      const unsubscribe = cliToolsApi.onOutput(toolId, (event) => {
        if (event.type !== 'output' || !event.data) return
        setLogs((prev) => {
          const next = (prev[toolId] ?? '') + event.data
          return {
            ...prev,
            [toolId]: next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS) : next
          }
        })
      })

      let result: { success: boolean; error?: string; status?: CliToolStatus }
      try {
        result = await action()
      } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      } finally {
        unsubscribe()
      }

      // The toast is global: it must still show when the dialog was closed mid-install.
      const toolName = tools?.find((tool) => tool.id === toolId)?.name ?? toolId
      const message =
        result.error || (kind === 'install' ? 'Install failed' : 'Could not add the skill')
      if (result.success) {
        toast.success(
          kind === 'install' ? `${toolName} installed` : `${toolName} skill added to the project`
        )
      } else {
        toast.error(message.split('\n')[0])
      }
      if (generationRef.current !== generation) return

      if (result.status) replaceTool(result.status)
      setBusy((prev) => ({ ...prev, [toolId]: undefined }))
      if (result.success) {
        if (kind === 'skill') {
          onSkillInstalled(
            result.status?.skillId ?? tools?.find((tool) => tool.id === toolId)?.skillId ?? toolId
          )
        }
      } else {
        setErrors((prev) => ({ ...prev, [toolId]: message }))
      }
    },
    [onSkillInstalled, replaceTool, tools]
  )

  const handleInstall = useCallback(
    (toolId: CliToolId) => {
      void runAction(toolId, 'install', () => cliToolsApi.install(toolId, projectPath))
    },
    [projectPath, runAction]
  )
  const handleInstallSkill = useCallback(
    (toolId: CliToolId) => {
      void runAction(toolId, 'skill', () => cliToolsApi.installSkill(toolId, projectPath))
    },
    [projectPath, runAction]
  )

  return (
    <div className="space-y-1.5 min-w-0">
      <span className="block text-sm font-medium">Tools</span>
      <p className="text-xs text-muted-foreground">
        CLIs agents can use. Install or update them for this machine, then add their skill to the
        project.
      </p>
      <div className="border rounded-md">
        {tools === null && loadError === null ? (
          <div
            className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
            data-testid="manage-skills-tools-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking installed tools...
          </div>
        ) : loadError !== null ? (
          <div
            className="px-3 py-2 text-xs text-destructive break-words"
            data-testid="manage-skills-tools-error"
          >
            Could not check tools: {loadError}
          </div>
        ) : (
          <div className="divide-y py-0.5" data-testid="manage-skills-tools-list">
            {tools?.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                busy={busy[tool.id] ?? null}
                log={logs[tool.id] ?? ''}
                error={errors[tool.id] ?? null}
                onInstall={handleInstall}
                onInstallSkill={handleInstallSkill}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
