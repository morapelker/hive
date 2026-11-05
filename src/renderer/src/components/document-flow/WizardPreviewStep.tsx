import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Rocket } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  getCachedModelCatalog,
  getModelCatalogCacheVersion,
  loadHandoffModelCatalog,
  subscribeModelCatalogCache
} from '@/lib/handoffSelection'
import { getMemberProjects, isConnectionProject } from '@/lib/connection-project'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import {
  isTicketRun,
  type DocumentRun,
  type DocumentRunConfig,
  type DocumentRunDetail,
  type DocumentRunItem,
  type DocumentRunLaunchConfig
} from '@shared/types/document-flow'
import { AddRunTicketsDialog } from './AddRunTicketsDialog'
import { DocumentRunItemEditor } from './DocumentRunItemEditor'
import { DocumentRunSettingsPanel, type SettingsMember } from './DocumentRunSettingsPanel'
import {
  describeLaunchConfig,
  mergeLaunchConfigs,
  quickLaunchChoices,
  validateLaunch
} from './document-flow-launch'
import {
  describeBaseBranch,
  describeMemberBaseBranches,
  describeMemberVerifyCommands,
  describeVerificationChoice,
  pluralize,
  type RunMemberProject
} from './document-flow-ui'
import { ticketRunMeta } from './ticket-run-ui'
import { NO_BASE_BRANCH_OPTIONS, useBaseBranchOptionsByPath } from './useBaseBranchOptions'
import { PendingWritesProvider, useDebouncedText, usePendingWrites } from './useDebouncedText'
import { useRunConfigDraft } from './useRunConfigDraft'

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** The project the run belongs to: a git project, or a connection project with its members. */
export interface WizardProject {
  id: string
  path: string
  kind?: 'git' | 'connection'
  member_project_ids?: string | null
}

interface WizardPreviewStepProps {
  detail: DocumentRunDetail
  project: WizardProject
  /** Reports whether a launch is in flight, so the dialog can refuse to close meanwhile. */
  onLaunchingChange: (launching: boolean) => void
}

/**
 * The extracted tickets and the run settings, editable until the run is launched.
 *
 * A run made from board tickets (an orchestrator) previews the same way, minus everything
 * that comes from a document: its header is the run's name (editable) and an "Add tickets"
 * button instead of the extraction's title, notes, warnings and questions and Re-extract; its
 * rows are the board tickets themselves; there is no prompt style to choose.
 */
export function WizardPreviewStep({
  detail,
  project,
  onLaunchingChange
}: WizardPreviewStepProps): React.JSX.Element {
  const { run, items } = detail
  const ticketRun = isTicketRun(run)
  const updateItem = useDocumentFlowStore((s) => s.updateItem)
  const updateRun = useDocumentFlowStore((s) => s.updateRun)
  const startRun = useDocumentFlowStore((s) => s.startRun)
  const retryExtraction = useDocumentFlowStore((s) => s.retryExtraction)
  const closeWizard = useDocumentFlowStore((s) => s.closeWizard)
  const openDashboard = useDocumentFlowStore((s) => s.openDashboard)

  // A connection project is run member by member: one base branch and one verify command each.
  const memberProjects = isConnectionProject(project) ? getMemberProjects(project) : null
  const pendingWrites = usePendingWrites()
  const draft = useRunConfigDraft(run, memberProjects?.map((member) => member.id) ?? null)
  const branchesByPath = useBaseBranchOptionsByPath(
    memberProjects ? memberProjects.map((member) => member.path) : [project.path]
  )
  const branches = branchesByPath[project.path] ?? NO_BASE_BRANCH_OPTIONS
  const settingsMembers: SettingsMember[] | null =
    memberProjects?.map((member) => ({
      id: member.id,
      name: member.name,
      branches: branchesByPath[member.path] ?? NO_BASE_BRANCH_OPTIONS
    })) ?? null
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [confirm, setConfirm] = useState<'launch' | 'reextract' | null>(null)
  const [addingTickets, setAddingTickets] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [pickingItemIds, setPickingItemIds] = useState<readonly string[]>([])
  const [knownLaunchConfigs, setKnownLaunchConfigs] = useState<readonly DocumentRunLaunchConfig[]>(
    []
  )
  const setItemPicking = useCallback((itemId: string, picking: boolean): void => {
    setPickingItemIds((current) => {
      if (current.includes(itemId) === picking) return current
      return picking ? [...current, itemId] : current.filter((id) => id !== itemId)
    })
  }, [])

  // Variants are checked against the SDK's model catalog, which may still be loading.
  useSyncExternalStore(subscribeModelCatalogCache, getModelCatalogCacheVersion)
  const validation = validateLaunch(items, draft.config.defaultLaunch, getCachedModelCatalog)
  const variantSdks = [
    ...new Set(
      [draft.config.defaultLaunch, ...items.map((item) => item.launch_config)].flatMap(
        (config): HandoffAgentSdk[] => (config?.model?.variant ? [config.sdk] : [])
      )
    )
  ]
    .sort()
    .join(',')
  useEffect(() => {
    for (const sdk of variantSdks.split(',')) {
      if (sdk) void loadHandoffModelCatalog(sdk as HandoffAgentSdk)
    }
  }, [variantSdks])

  const extraction = run.extraction
  const documentTitle = extraction?.documentTitle || run.title
  const ownModelCount = items.filter((item) => item.selected && item.launch_config).length

  // A model a ticket settles on becomes a one-tap choice on every row, and stays one for this
  // preview even when no ticket uses it any more. A model still being picked is held back: the
  // picker saves every step on the way to it.
  const settledLaunchConfigs = mergeLaunchConfigs(
    knownLaunchConfigs,
    items.filter((item) => !pickingItemIds.includes(item.id)).map((item) => item.launch_config)
  )
  if (settledLaunchConfigs !== knownLaunchConfigs) setKnownLaunchConfigs(settledLaunchConfigs)
  const quickChoices = quickLaunchChoices(settledLaunchConfigs, draft.config.defaultLaunch)

  const setAllSelected = (selected: boolean): void => {
    for (const item of items) {
      if (item.selected === selected) continue
      updateItem(run.id, item.id, { selected }).catch((cause: unknown) => {
        toast.error(`Could not update ${item.key}: ${errorMessage(cause)}`)
      })
    }
  }

  const reextract = (): void => {
    retryExtraction(run.id).catch((cause: unknown) => {
      toast.error(`Could not re-extract the tickets: ${errorMessage(cause)}`)
    })
  }

  const launch = async (): Promise<void> => {
    if (launching) return
    setLaunching(true)
    onLaunchingChange(true)
    setLaunchError(null)
    try {
      await pendingWrites.flushAll()
      await updateRun(run.id, { config: draft.settle() })
      await startRun(run.id)
      closeWizard()
      openDashboard(run.id)
    } catch (cause) {
      // Also as a toast: the wizard may have been closed (Cmd+W) while the launch was in
      // flight, and then nothing else says that the run never started.
      setLaunchError(errorMessage(cause))
      toast.error(`The run could not be launched: ${errorMessage(cause)}`)
    } finally {
      setLaunching(false)
      onLaunchingChange(false)
    }
  }

  return (
    <PendingWritesProvider value={pendingWrites}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {ticketRun ? (
            <TicketRunHeader run={run} items={items} onAddTickets={() => setAddingTickets(true)} />
          ) : (
            <div className="space-y-2 border-b border-border px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p
                    className="truncate text-[14px] font-semibold text-foreground"
                    title={documentTitle}
                  >
                    {documentTitle}
                  </p>
                  <p
                    className="text-[12px] text-muted-foreground"
                    data-testid="docflow-preview-meta"
                  >
                    {pluralize(items.length, 'ticket')} · {validation.selectedCount} selected
                    {extraction?.numbering && ` · numbered ${extraction.numbering}`}
                    {extraction?.generatedBy && ` · extracted by ${extraction.generatedBy}`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="docflow-reextract-btn"
                  onClick={() => setConfirm('reextract')}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Re-extract
                </Button>
              </div>

              {run.config.notes && (
                <p
                  className="whitespace-pre-wrap break-words rounded-md border border-border px-3 py-2 text-[12px] leading-snug text-muted-foreground"
                  data-testid="docflow-preview-notes"
                >
                  <span className="text-foreground">Extracted with your notes: </span>
                  {run.config.notes}
                </p>
              )}

              {extraction && extraction.warnings.length > 0 && (
                <ul
                  className="list-disc space-y-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 py-2 pl-7 pr-3 text-[12px] leading-snug text-amber-600 dark:text-amber-400"
                  data-testid="docflow-extraction-warnings"
                >
                  {extraction.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              )}

              {extraction && extraction.openQuestions.length > 0 && (
                <div>
                  <button
                    type="button"
                    aria-expanded={questionsOpen}
                    data-testid="docflow-open-questions-toggle"
                    className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setQuestionsOpen((open) => !open)}
                  >
                    {questionsOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    Questions the document leaves open ({extraction.openQuestions.length})
                  </button>
                  {questionsOpen && (
                    <ul
                      className="mt-1 list-disc space-y-0.5 pl-7 text-[12px] leading-snug text-muted-foreground"
                      data-testid="docflow-open-questions"
                    >
                      {extraction.openQuestions.map((question, index) => (
                        <li key={index}>{question}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-4 py-1.5">
            <span
              className="text-[12px] text-muted-foreground"
              data-testid="docflow-selected-count"
            >
              {validation.selectedCount} of {items.length} selected
            </span>
            {/* One checkmark for every ticket's verification: unchecked, no agent is asked to
                verify, but each ticket's own choice is kept for when it is checked again. */}
            <label
              className="ml-3 flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground"
              title={
                draft.config.verificationDisabled
                  ? 'Verification is skipped for every ticket. Check to ask agents to verify again, with the choices below.'
                  : 'Agents verify their work the ways chosen on each ticket. Uncheck to skip verification for every ticket; the choices are kept.'
              }
            >
              <Checkbox
                data-testid="docflow-verification-toggle"
                aria-label="Ask agents to verify their work"
                checked={!draft.config.verificationDisabled}
                onCheckedChange={(checked) =>
                  draft.change({ verificationDisabled: checked !== true })
                }
              />
              Verification
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-6 text-xs"
              data-testid="docflow-select-all"
              disabled={validation.selectedCount === items.length}
              onClick={() => setAllSelected(true)}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              data-testid="docflow-select-none"
              disabled={validation.selectedCount === 0}
              onClick={() => setAllSelected(false)}
            >
              Select none
            </Button>
          </div>

          {items.length === 0 && (
            <p
              className="px-4 py-6 text-[13px] text-muted-foreground"
              data-testid="docflow-no-items"
            >
              {ticketRun
                ? 'This orchestrator has no tickets. Add tickets from the board to launch it.'
                : 'No tickets were found in this document. Re-extract it, or cancel and choose another document.'}
            </p>
          )}
          <div className="divide-y divide-border" data-testid="docflow-item-list">
            {items.map((item) => (
              <DocumentRunItemEditor
                key={item.id}
                run={run}
                item={item}
                items={items}
                quickChoices={quickChoices}
                verificationDisabled={draft.config.verificationDisabled}
                expanded={expandedItemId === item.id}
                onToggleExpanded={() =>
                  setExpandedItemId((current) => (current === item.id ? null : item.id))
                }
                onModelPickingChange={setItemPicking}
                config={draft.config}
              />
            ))}
          </div>
        </div>

        <aside className="w-[330px] shrink-0 overflow-y-auto border-l border-border px-4 py-3">
          <p className="mb-3 text-[13px] font-semibold text-foreground">Run settings</p>
          <DocumentRunSettingsPanel
            branches={branches}
            members={settingsMembers}
            config={draft.config}
            onChange={draft.change}
            sourceKind={run.source_kind}
          />
        </aside>
      </div>

      <div className="flex shrink-0 items-end gap-3 border-t border-border px-4 py-3">
        <div className="max-h-24 min-w-0 flex-1 space-y-0.5 overflow-y-auto text-[12px] leading-snug">
          {validation.blockers.map((blocker, index) => (
            <p key={index} className="text-destructive" data-testid="docflow-launch-blocker">
              {blocker}
            </p>
          ))}
          {validation.notes.map((note, index) => (
            <p key={index} className="text-muted-foreground" data-testid="docflow-launch-note">
              {note}
            </p>
          ))}
          {launchError && (
            <p className="text-destructive" data-testid="docflow-launch-error">
              The run could not be launched: {launchError}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          data-testid="docflow-preview-cancel"
          disabled={launching}
          onClick={closeWizard}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="docflow-launch-btn"
          disabled={validation.blockers.length > 0 || launching}
          onClick={() => setConfirm('launch')}
        >
          {launching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Rocket className="h-3.5 w-3.5" />
          )}
          Launch run ({validation.selectedCount})
        </Button>
      </div>

      <AlertDialog
        open={confirm === 'reextract'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
      >
        <AlertDialogContent data-docflow-dialog="">
          <AlertDialogHeader>
            <AlertDialogTitle>Re-extract the tickets?</AlertDialogTitle>
            <AlertDialogDescription>
              The document is read again and the tickets below are replaced, including every edit
              you made to them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="docflow-reextract-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="docflow-reextract-confirm" onClick={reextract}>
              Re-extract
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LaunchConfirmDialog
        open={confirm === 'launch'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void launch()}
        ticketCount={validation.selectedCount}
        ownModelCount={ownModelCount}
        items={items}
        config={draft.config}
        currentBranch={branches.current}
        members={settingsMembers}
        ticketRun={ticketRun}
      />

      {ticketRun && (
        <AddRunTicketsDialog run={run} open={addingTickets} onOpenChange={setAddingTickets} />
      )}
    </PendingWritesProvider>
  )
}

/**
 * The head of an orchestrator's preview: its name, edited in place (it names the run's ticket
 * and its integration branch), the counts, and "Add tickets" for more board tickets. Rendered
 * under the preview's pending writes, so a name still being typed is written before launch.
 */
function TicketRunHeader({
  run,
  items,
  onAddTickets
}: {
  run: DocumentRun
  items: readonly DocumentRunItem[]
  onAddTickets: () => void
}): React.JSX.Element {
  const updateRun = useDocumentFlowStore((s) => s.updateRun)
  // A cleared name is the user mid-retype (the server refuses an empty title); the field falls
  // back to the stored name when it is left.
  const saveTitle = useCallback(
    (value: string) => (value.trim() ? updateRun(run.id, { title: value }) : Promise.resolve()),
    [updateRun, run.id]
  )
  const title = useDebouncedText(run.title, saveTitle)
  return (
    <div className="space-y-1.5 border-b border-border px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <input
            aria-label="Orchestrator name"
            data-testid="docflow-run-title-input"
            placeholder="Name this orchestrator"
            spellCheck={false}
            className="-mx-1 w-full truncate rounded-[4px] bg-transparent px-1 text-[14px] font-semibold text-foreground outline-none transition-colors placeholder:font-normal placeholder:text-muted-foreground hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={title.value}
            onChange={(event) => title.setValue(event.target.value)}
            onFocus={title.onFocus}
            onBlur={title.onBlur}
          />
          <p className="text-[12px] text-muted-foreground" data-testid="docflow-preview-meta">
            {ticketRunMeta(items)}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="docflow-add-tickets-btn"
          onClick={onAddTickets}
        >
          <Plus className="h-3.5 w-3.5" />
          Add tickets
        </Button>
      </div>
      <p className="text-[12px] leading-snug text-muted-foreground">
        Each ticket is sent to its agent as you wrote it on the board. What a ticket starts after is
        the board&apos;s dependencies: change them here or on the board.
      </p>
    </div>
  )
}

interface LaunchConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  ticketCount: number
  /** Selected tickets that carry their own model instead of the run default. */
  ownModelCount: number
  /** Every ticket of the run, for the verification summary. */
  items: readonly DocumentRunItem[]
  config: DocumentRunConfig
  /** The root checkout's branch: where a run without a base branch of its own starts. */
  currentBranch: string | null
  /** Connection project: the members, each with its own base branch and verify command. */
  members: readonly SettingsMember[] | null
  /** A run made from board tickets: no prompt style (each ticket is its own brief). */
  ticketRun?: boolean
}

/** What the confirmation says about where the run branches from, for either kind of project. */
function describeLaunchBase(
  config: DocumentRunConfig,
  currentBranch: string | null,
  members: readonly SettingsMember[] | null
): { label: string; branches: string; lead: string; verify: React.ReactNode } {
  if (!members) {
    const baseBranch = describeBaseBranch(config, currentBranch)
    const verifyCommand = config.verifyCommand?.trim()
    return {
      label: 'Base branch',
      branches: baseBranch,
      lead: `An integration branch is created from ${baseBranch} and every ticket is merged into it. The base branch itself is not modified.`,
      verify: verifyCommand ? (
        <code className="font-mono text-[12px]">{verifyCommand}</code>
      ) : (
        'no verify command'
      )
    }
  }
  const memberProjects: RunMemberProject[] = members.map(({ id, name }) => ({ id, name }))
  const currentBranches = Object.fromEntries(
    members.map((member) => [member.id, member.branches.current])
  )
  return {
    label: 'Base branches',
    branches: describeMemberBaseBranches(memberProjects, config, currentBranches),
    lead: 'An integration branch is created in every member repository from its base branch; every ticket gets a worktree in each of them and is merged into all of them. The base branches themselves are not modified.',
    verify: (
      <code className="font-mono text-[12px]">
        {describeMemberVerifyCommands(memberProjects, config)}
      </code>
    )
  }
}

function LaunchConfirmDialog({
  open,
  onClose,
  onConfirm,
  ticketCount,
  ownModelCount,
  items,
  config,
  currentBranch,
  members,
  ticketRun = false
}: LaunchConfirmDialogProps): React.JSX.Element {
  const base = describeLaunchBase(config, currentBranch, members)
  const rows: [string, React.ReactNode][] = [
    ['Tickets', ticketCount],
    [base.label, base.branches],
    ['Parallel tickets', config.maxParallel],
    ['Verify by', describeVerificationChoice(items, config.verificationDisabled)],
    [members ? 'Verify commands' : 'Verify command', base.verify],
    [
      'Model',
      ownModelCount > 0
        ? `${describeLaunchConfig(config.defaultLaunch)} (${pluralize(ownModelCount, 'ticket')} with their own)`
        : describeLaunchConfig(config.defaultLaunch)
    ],
    ...(ticketRun
      ? []
      : [
          [
            'Prompt',
            config.promptStyle === 'small'
              ? 'small (no subagents)'
              : 'full (research with subagents)'
          ] as [string, React.ReactNode]
        ]),
    ['Questions', config.interactive ? 'agents may ask you' : 'agents decide on their own']
  ]

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <AlertDialogContent data-docflow-dialog="" data-testid="docflow-launch-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Launch {pluralize(ticketCount, 'ticket')}?</AlertDialogTitle>
          <AlertDialogDescription>{base.lead}</AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="docflow-launch-confirm-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="docflow-launch-confirm-btn" onClick={onConfirm}>
            Launch run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
