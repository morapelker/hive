import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Image as ImageIcon
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ticketPillClass } from '@/components/kanban/pill'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import type {
  DocumentRunItem,
  DocumentRunItemPatch,
  DocumentTicketConflictRisk
} from '@shared/types/document-flow'
import {
  LaunchConfigBadge,
  LaunchConfigChip,
  TonePill,
  VerificationChips
} from './DocumentFlowBadges'
import { LaunchConfigPicker } from './LaunchConfigPicker'
import {
  dependencyReaches,
  dependencyState,
  sameLaunchConfig,
  type QuickLaunchChoice
} from './document-flow-launch'
import { pluralize, toggleVerificationMethod, type DocumentFlowTone } from './document-flow-ui'
import { useDebouncedText } from './useDebouncedText'

const LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

const CONFLICT_RISK_TONES: Record<DocumentTicketConflictRisk, DocumentFlowTone> = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger'
}

function reportSaveFailure(error: unknown): void {
  toast.error(`Could not save your edit: ${error instanceof Error ? error.message : String(error)}`)
}

interface DocumentRunItemEditorProps {
  runId: string
  item: DocumentRunItem
  /** Every ticket of the run, in document order. */
  items: readonly DocumentRunItem[]
  /** Models other tickets of the run settled on, offered as one-tap toggles. */
  quickChoices: readonly QuickLaunchChoice[]
  /** The run skips verification: the chips show the choice but cannot be changed. */
  verificationDisabled: boolean
  expanded: boolean
  onToggleExpanded: () => void
  /**
   * Reports whether this ticket's model is still being picked: its picker is open, or a pick
   * is on its way to the server. The picker saves every step, so the model is not final yet.
   */
  onModelPickingChange: (itemId: string, picking: boolean) => void
}

/**
 * One extracted ticket in the preview list: a summary row that expands into its editor. The
 * model and effort are changed straight from the row, without expanding it: through the
 * picker, or with one tap on a model another ticket already uses.
 */
export function DocumentRunItemEditor({
  runId,
  item,
  items,
  quickChoices,
  verificationDisabled,
  expanded,
  onToggleExpanded,
  onModelPickingChange
}: DocumentRunItemEditorProps): React.JSX.Element {
  const updateItem = useDocumentFlowStore((s) => s.updateItem)
  const save = useCallback(
    (patch: DocumentRunItemPatch) => updateItem(runId, item.id, patch),
    [updateItem, runId, item.id]
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingPicks, setPendingPicks] = useState(0)
  const picking = pickerOpen || pendingPicks > 0
  useEffect(() => {
    onModelPickingChange(item.id, picking)
  }, [onModelPickingChange, item.id, picking])
  // The pressed chip already names the model; the trigger then only keeps its arrows.
  const usesQuickChoice = quickChoices.some((choice) =>
    sameLaunchConfig(choice.config, item.launch_config)
  )

  return (
    <div data-testid={`docflow-item-${item.key}`} className={cn(!item.selected && 'opacity-60')}>
      <div className="flex items-start gap-3 px-4 py-2.5">
        <Checkbox
          checked={item.selected}
          aria-label={`Include ${item.key}`}
          data-testid={`docflow-item-select-${item.key}`}
          className="mt-0.5"
          onCheckedChange={(selected) => {
            save({ selected }).catch(reportSaveFailure)
          }}
        />
        <button
          type="button"
          aria-expanded={expanded}
          data-testid={`docflow-item-toggle-${item.key}`}
          className="flex min-w-[140px] flex-1 items-start gap-2 text-left"
          onClick={onToggleExpanded}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {item.key}
              </span>
              <span className="truncate text-[13px] font-medium text-foreground">
                {item.title || 'Untitled ticket'}
              </span>
            </span>
            <ItemPills item={item} items={items} />
          </span>
        </button>
        {/* In a narrow window the chips move under the picker, then shorten, before the title is squeezed away. */}
        <div className="-my-0.5 flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <VerificationChips
            itemKey={item.key}
            item={item}
            disabled={verificationDisabled}
            onToggle={(method) => {
              save({ verification: toggleVerificationMethod(item.verification, method) }).catch(
                reportSaveFailure
              )
            }}
          />
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Model and effort for ${item.key}`}
                title="Change model and effort"
                data-testid={`docflow-item-model-trigger-${item.key}`}
                className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-transparent px-1.5 transition-colors hover:border-border hover:bg-accent/50 data-[state=open]:border-border data-[state=open]:bg-accent/50"
              >
                {!usesQuickChoice && (
                  <LaunchConfigBadge
                    config={item.launch_config}
                    inheritLabel="default"
                    testId={`docflow-item-model-${item.key}`}
                  />
                )}
                <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            {/* The picker (and its model catalog request) only mounts while the popover is open. */}
            <PopoverContent align="end" className="w-[380px] space-y-1.5" data-docflow-dialog="">
              <p className={LABEL_CLASS}>Model for {item.key}</p>
              <LaunchConfigPicker
                value={item.launch_config}
                onChange={(launch_config) => {
                  setPendingPicks((count) => count + 1)
                  save({ launch_config })
                    .catch(reportSaveFailure)
                    .finally(() => setPendingPicks((count) => count - 1))
                }}
                inheritLabel="Run default"
                clearLabel="Use run default"
                testIdPrefix={`docflow-item-model-picker-${item.key}`}
              />
            </PopoverContent>
          </Popover>
          {quickChoices.length > 0 && (
            <div
              role="group"
              aria-label={`Quick models for ${item.key}`}
              data-testid={`docflow-item-quick-models-${item.key}`}
              className="flex min-w-0 items-center justify-end gap-1"
            >
              {quickChoices.map((choice, index) => {
                const pressed = sameLaunchConfig(choice.config, item.launch_config)
                return (
                  <LaunchConfigChip
                    key={choice.key}
                    choice={choice}
                    pressed={pressed}
                    testId={`docflow-item-quick-model-${item.key}-${index}`}
                    onClick={() => {
                      save({ launch_config: pressed ? null : choice.config }).catch(
                        reportSaveFailure
                      )
                    }}
                  />
                )
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className="mt-0.5 shrink-0 text-muted-foreground"
          onClick={onToggleExpanded}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {expanded && <ItemEditorBody item={item} items={items} save={save} />}
    </div>
  )
}

function ItemPills({
  item,
  items
}: {
  item: DocumentRunItem
  items: readonly DocumentRunItem[]
}): React.JSX.Element {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
      <span className={ticketPillClass}>{item.kind}</span>
      {item.size && <span className={ticketPillClass}>{item.size}</span>}
      {item.has_migration && <TonePill tone="info">migration</TonePill>}
      {item.conflict_risk && (
        <TonePill tone={CONFLICT_RISK_TONES[item.conflict_risk]}>
          {item.conflict_risk} conflict risk
        </TonePill>
      )}
      {item.doc_status === 'done' && (
        <TonePill tone="success" testId={`docflow-item-doc-status-${item.key}`}>
          marked done in the document
        </TonePill>
      )}
      {item.doc_status === 'partial' && (
        <TonePill tone="warning" testId={`docflow-item-doc-status-${item.key}`}>
          partly done in the document
        </TonePill>
      )}
      {item.depends_on.map((key) => {
        const state = dependencyState(key, items)
        return (
          <TonePill
            key={key}
            tone={state === 'ok' ? 'neutral' : state === 'excluded' ? 'warning' : 'danger'}
            title={
              state === 'excluded'
                ? `${key} is not included, so ${item.key} will not wait for it`
                : state === 'unknown'
                  ? `There is no ticket ${key} in this run`
                  : undefined
            }
            testId={`docflow-item-dep-${item.key}-${key}`}
          >
            after {key}
            {state === 'excluded' && ' (not included)'}
            {state === 'unknown' && ' (unknown)'}
          </TonePill>
        )
      })}
      {item.open_questions.length > 0 && (
        <TonePill tone="warning">{pluralize(item.open_questions.length, 'open question')}</TonePill>
      )}
      {item.figures.length > 0 && (
        <span className={ticketPillClass}>
          <ImageIcon className="h-2.5 w-2.5" />
          {pluralize(item.figures.length, 'figure')}
        </span>
      )}
    </span>
  )
}

interface ItemEditorBodyProps {
  item: DocumentRunItem
  items: readonly DocumentRunItem[]
  save: (patch: DocumentRunItemPatch) => Promise<DocumentRunItem>
}

function ItemEditorBody({ item, items, save }: ItemEditorBodyProps): React.JSX.Element {
  const [showPreview, setShowPreview] = useState(false)
  // A cleared title is the user mid-retype, not a request the server would refuse; the field
  // falls back to the stored title when it is left.
  const saveTitle = useCallback(
    (value: string) => (value.trim() ? save({ title: value }) : Promise.resolve()),
    [save]
  )
  const saveDescription = useCallback((value: string) => save({ description: value }), [save])
  const title = useDebouncedText(item.title, saveTitle)
  const description = useDebouncedText(item.description, saveDescription)
  const others = items.filter((candidate) => candidate.id !== item.id)
  const knownKeys = new Set(others.map((candidate) => candidate.key))
  const danglingKeys = item.depends_on.filter((key) => !knownKeys.has(key))

  const toggleDependency = (key: string): void => {
    const wanted = new Set(item.depends_on)
    if (!wanted.delete(key)) wanted.add(key)
    // Keep the list in document order, with keys that match no ticket at the end.
    const next = [
      ...others.map((other) => other.key).filter((candidate) => wanted.has(candidate)),
      ...danglingKeys.filter((candidate) => wanted.has(candidate))
    ]
    save({ depends_on: next }).catch(reportSaveFailure)
  }

  return (
    <div
      className="space-y-3 border-t border-border/60 bg-muted/20 px-4 py-3 pl-11"
      data-testid={`docflow-item-editor-${item.key}`}
    >
      <div className="space-y-1.5">
        <label htmlFor={`docflow-title-${item.id}`} className={LABEL_CLASS}>
          Title
        </label>
        <Input
          id={`docflow-title-${item.id}`}
          data-testid={`docflow-item-title-${item.key}`}
          value={title.value}
          onChange={(event) => title.setValue(event.target.value)}
          onFocus={title.onFocus}
          onBlur={title.onBlur}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor={`docflow-description-${item.id}`} className={LABEL_CLASS}>
            Description
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            tabIndex={-1}
            data-testid={`docflow-item-preview-toggle-${item.key}`}
            className="h-6 gap-1 text-xs text-muted-foreground"
            onClick={() => setShowPreview((previous) => !previous)}
          >
            {showPreview ? (
              <>
                <EyeOff className="h-3.5 w-3.5" /> Edit
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5" /> Preview
              </>
            )}
          </Button>
        </div>
        {showPreview ? (
          <div
            data-testid={`docflow-item-description-preview-${item.key}`}
            className="prose prose-sm dark:prose-invert max-h-[320px] min-h-[120px] max-w-none overflow-y-auto rounded-md border border-input bg-muted/30 px-3 py-2 text-sm"
          >
            {description.value.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{description.value}</ReactMarkdown>
            ) : (
              <p className="italic text-muted-foreground/60">No description</p>
            )}
          </div>
        ) : (
          <Textarea
            id={`docflow-description-${item.id}`}
            data-testid={`docflow-item-description-${item.key}`}
            placeholder="Shown on the board ticket; the agent reads the task from the original document (supports markdown)"
            rows={8}
            className="resize-y font-mono text-[12px]"
            value={description.value}
            onChange={(event) => description.setValue(event.target.value)}
            onFocus={description.onFocus}
            onBlur={description.onBlur}
          />
        )}
      </div>

      {item.summary.trim() && (
        <div className="space-y-1">
          <p className={LABEL_CLASS}>Summary</p>
          <p className="text-[12px] leading-snug text-muted-foreground">{item.summary}</p>
        </div>
      )}

      {item.open_questions.length > 0 && (
        <div className="space-y-1">
          <p className={LABEL_CLASS}>Open questions</p>
          <ul className="list-disc space-y-0.5 pl-4 text-[12px] leading-snug text-amber-600 dark:text-amber-400">
            {item.open_questions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </div>
      )}

      {(others.length > 0 || danglingKeys.length > 0) && (
        <div className="space-y-1.5">
          <p className={LABEL_CLASS}>Starts after</p>
          <div className="flex flex-wrap gap-1">
            {others.map((other) => {
              const active = item.depends_on.includes(other.key)
              // Adding it would make the two wait for each other forever.
              const circular = !active && dependencyReaches(other.key, item.key, items)
              return (
                <button
                  key={other.id}
                  type="button"
                  aria-pressed={active}
                  disabled={circular}
                  title={circular ? `${other.key} already starts after ${item.key}` : other.title}
                  data-testid={`docflow-item-dep-toggle-${item.key}-${other.key}`}
                  className={cn(
                    'rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent/50'
                  )}
                  onClick={() => toggleDependency(other.key)}
                >
                  {other.key}
                </button>
              )
            })}
            {danglingKeys.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed
                title={`There is no ticket ${key} in this run. Click to remove.`}
                data-testid={`docflow-item-dep-toggle-${item.key}-${key}`}
                className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-mono text-[10px] text-red-500"
                onClick={() => toggleDependency(key)}
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
