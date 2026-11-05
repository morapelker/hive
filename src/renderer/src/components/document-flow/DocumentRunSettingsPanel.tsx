import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { clampMaxParallel } from '@/stores/useDocumentFlowStore'
import {
  DOCUMENT_RUN_MAX_PARALLEL_LIMIT,
  type DocumentRunConfig,
  type DocumentRunPromptStyle,
  type DocumentRunSourceKind
} from '@shared/types/document-flow'
import { LaunchConfigPicker } from './LaunchConfigPicker'
import { defaultBaseBranchLabel, memberBaseBranch } from './document-flow-ui'
import type { BaseBranchOptions } from './useBaseBranchOptions'

const LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'
const HELP_CLASS = 'text-[11px] leading-snug text-muted-foreground'
const SELECT_CLASS =
  'h-8 w-full rounded-md border border-input bg-background px-2.5 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

const PROMPT_STYLE_OPTIONS: { value: DocumentRunPromptStyle; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'small', label: 'Small' }
]

/** A member project of a connection project, with the branches it offers as base. */
export interface SettingsMember {
  id: string
  name: string
  branches: BaseBranchOptions
}

interface DocumentRunSettingsPanelProps {
  /** Git project: the branches of the project. Not read when `members` is given. */
  branches: BaseBranchOptions
  /** Connection project: one base branch and one verify command per member, in member order. */
  members?: readonly SettingsMember[] | null
  config: DocumentRunConfig
  onChange: (patch: Partial<DocumentRunConfig>, options?: { debounce?: boolean }) => void
  /**
   * Where the run's tickets come from. A run made from board tickets has no prompt style: each
   * ticket's own title and description are its brief, so the Full / Small choice (how much of
   * the spec an agent researches) is not offered.
   */
  sourceKind?: DocumentRunSourceKind
}

/** A stored branch stays selectable while the list loads (or if it has since been deleted). */
function branchOptions(stored: string | null, branches: BaseBranchOptions): string[] {
  return stored && !branches.names.includes(stored) ? [stored, ...branches.names] : branches.names
}

function BaseBranchSelect({
  id,
  value,
  branches,
  onChange
}: {
  id: string
  value: string | null
  branches: BaseBranchOptions
  onChange: (branch: string | null) => void
}): React.JSX.Element {
  return (
    <select
      id={id}
      data-testid={id}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      className={SELECT_CLASS}
    >
      <option value="">{defaultBaseBranchLabel(branches.current)}</option>
      {branchOptions(value, branches).map((branch) => (
        <option key={branch} value={branch}>
          {branch}
        </option>
      ))}
    </select>
  )
}

/** Run-wide settings of a previewed run: where it branches from and how its tickets run. */
export function DocumentRunSettingsPanel({
  branches,
  members = null,
  config,
  onChange,
  sourceKind = 'document'
}: DocumentRunSettingsPanelProps): React.JSX.Element {
  const memberBranchErrors = (members ?? []).flatMap((member) =>
    member.branches.error ? [`${member.name}: ${member.branches.error}`] : []
  )

  return (
    <div className="space-y-5" data-testid="docflow-settings">
      {members ? (
        <div className="space-y-1.5" data-testid="docflow-member-base-branches">
          <p className={LABEL_CLASS}>Base branches</p>
          <div className="space-y-1.5">
            {members.map((member) => (
              <div key={member.id} className="space-y-0.5">
                <label
                  htmlFor={`docflow-base-branch-${member.id}`}
                  className="text-[12px] text-foreground"
                >
                  {member.name}
                </label>
                <BaseBranchSelect
                  id={`docflow-base-branch-${member.id}`}
                  value={memberBaseBranch(config, member.id)}
                  branches={member.branches}
                  onChange={(branch) =>
                    onChange({
                      memberBaseBranches: { ...config.memberBaseBranches, [member.id]: branch }
                    })
                  }
                />
              </div>
            ))}
          </div>
          <p className={HELP_CLASS}>
            {memberBranchErrors.length > 0
              ? `Branches could not be listed: ${memberBranchErrors.join(' · ')}`
              : "An integration branch is cut from each member's base branch, and every ticket gets a worktree in every member project. The base branches themselves are never modified."}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <label htmlFor="docflow-base-branch" className={LABEL_CLASS}>
            Base branch
          </label>
          <BaseBranchSelect
            id="docflow-base-branch"
            value={config.baseBranch}
            branches={branches}
            onChange={(baseBranch) => onChange({ baseBranch })}
          />
          <p className={HELP_CLASS}>
            {branches.error
              ? `Branches could not be listed: ${branches.error}`
              : 'The integration branch is cut from it. The base branch itself is never modified.'}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <p className={LABEL_CLASS}>Default model for tickets</p>
        <LaunchConfigPicker
          value={config.defaultLaunch}
          onChange={(defaultLaunch) => onChange({ defaultLaunch })}
          inheritLabel="App default"
          clearLabel="Use app default"
          testIdPrefix="docflow-default-model"
        />
        <p className={HELP_CLASS}>Tickets without their own model use this one.</p>
      </div>

      <div className="space-y-1.5">
        <p className={LABEL_CLASS}>Parallel tickets</p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Fewer parallel tickets"
            data-testid="docflow-parallel-decrease"
            disabled={config.maxParallel <= 1}
            onClick={() => onChange({ maxParallel: clampMaxParallel(config.maxParallel - 1) })}
          >
            <Minus />
          </Button>
          <span
            className="w-6 text-center text-[13px] tabular-nums"
            data-testid="docflow-parallel-value"
          >
            {config.maxParallel}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="More parallel tickets"
            data-testid="docflow-parallel-increase"
            disabled={config.maxParallel >= DOCUMENT_RUN_MAX_PARALLEL_LIMIT}
            onClick={() => onChange({ maxParallel: clampMaxParallel(config.maxParallel + 1) })}
          >
            <Plus />
          </Button>
        </div>
        <p className={HELP_CLASS}>
          How many tickets may have an agent working at the same time. You can change this while the
          run is going, from the run's ticket.
        </p>
      </div>

      {members ? (
        <div className="space-y-1.5" data-testid="docflow-member-verify-commands">
          <p className={LABEL_CLASS}>Verify commands</p>
          <div className="space-y-1.5">
            {members.map((member) => (
              <div key={member.id} className="space-y-0.5">
                <label
                  htmlFor={`docflow-verify-command-${member.id}`}
                  className="text-[12px] text-foreground"
                >
                  {member.name}
                </label>
                <Input
                  id={`docflow-verify-command-${member.id}`}
                  data-testid={`docflow-verify-command-${member.id}`}
                  placeholder="No verification"
                  spellCheck={false}
                  className="font-mono text-[12px]"
                  value={config.memberVerifyCommands[member.id] ?? ''}
                  onChange={(event) =>
                    onChange(
                      {
                        memberVerifyCommands: {
                          ...config.memberVerifyCommands,
                          [member.id]: event.target.value
                        }
                      },
                      { debounce: true }
                    )
                  }
                />
              </div>
            ))}
          </div>
          <p className={HELP_CLASS}>
            Each runs in its member's integration worktree after every merge, and all must pass;
            leave one empty to skip that member. On failure a fix session gets 2 attempts, then the
            merge is rolled back in every member. Separate from how each agent verifies its own
            ticket (the tcu / playwright / tests chips in the list).
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <label htmlFor="docflow-verify-command" className={LABEL_CLASS}>
            Verify command
          </label>
          <Input
            id="docflow-verify-command"
            data-testid="docflow-verify-command"
            placeholder="No verification"
            spellCheck={false}
            className="font-mono text-[12px]"
            value={config.verifyCommand ?? ''}
            onChange={(event) =>
              onChange({ verifyCommand: event.target.value }, { debounce: true })
            }
          />
          <p className={HELP_CLASS}>
            Runs in the integration worktree after each merge. On failure a fix session gets 2
            attempts, then the merge is rolled back. Separate from how each agent verifies its own
            ticket (the tcu / playwright / tests chips in the list).
          </p>
        </div>
      )}

      {sourceKind !== 'tickets' && (
        <div className="space-y-1.5">
          <p className={LABEL_CLASS}>Prompt</p>
          <div className="flex gap-2" role="radiogroup" data-testid="docflow-prompt-style">
            {PROMPT_STYLE_OPTIONS.map((option) => {
              const selected = config.promptStyle === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`docflow-prompt-style-${option.value}`}
                  onClick={() => onChange({ promptStyle: option.value })}
                  className={cn(
                    'rounded-md border px-3 py-1 text-[12px] transition-colors',
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-muted/50 text-muted-foreground hover:bg-accent/50'
                  )}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
          <p className={HELP_CLASS}>
            Full: agents research the spec with subagents before they implement. Small: no
            subagents, for documents of small tasks.
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="docflow-interactive" className="text-[13px] text-foreground">
            Agents may ask me questions
          </label>
          <Switch
            id="docflow-interactive"
            size="sm"
            data-testid="docflow-interactive-switch"
            checked={config.interactive}
            onCheckedChange={(interactive) => onChange({ interactive })}
          />
        </div>
        <p className={HELP_CLASS}>
          On: a ticket whose agent asks a question waits for you while the others continue. Off:
          nothing waits for you. Agents pick the recommended approach and document what was too
          pivotal to decide; one that still stops short of done is told to finish, and after two
          reminders its branch is merged as it stands, with a note on the ticket. You can change
          this while the run is going, from the run's ticket.
        </p>
      </div>
    </div>
  )
}
