import { useSettingsStore } from '@/stores/useSettingsStore'
import { autoReviewTaskKey, resolveAutoReview } from '@/lib/auto-review'

/** Personal workflow preferences live in the persisted application settings. */
export function AutoReviewPreference({
  projectId,
  ticketId,
  draft
}: {
  projectId?: string
  ticketId?: string
  draft?: { value: boolean | undefined; onChange: (value: boolean | undefined) => void }
}): React.JSX.Element {
  const settings = useSettingsStore()
  const field = ticketId ? 'autoReviewTasks' : 'autoReviewProjects'
  const key = ticketId && projectId ? autoReviewTaskKey(projectId, ticketId) : projectId
  const override = draft ? draft.value : key ? settings[field]?.[key] : settings.autoReview
  const inherited = resolveAutoReview(settings, ticketId || draft ? projectId : undefined)
  const effective = draft
    ? (draft.value ?? inherited)
    : resolveAutoReview(settings, projectId, ticketId)
  return (
    <label
      className="block space-y-1 text-xs"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span>Automatically move to Review when the agent finishes</span>
      <select
        aria-label="Automatically move to Review when the agent finishes"
        className="block w-full rounded border border-border bg-background p-1"
        value={override === undefined ? 'inherit' : String(override)}
        onChange={(event) => {
          const value = event.target.value
          if (draft) {
            draft.onChange(value === 'inherit' ? undefined : value === 'true')
          } else if (!key) {
            settings.updateSetting('autoReview', value === 'true')
          } else {
            const next = { ...settings[field] }
            if (value === 'inherit') delete next[key]
            else next[key] = value === 'true'
            settings.updateSetting(field, next)
          }
        }}
      >
        {(key || draft) && (
          <option value="inherit">
            Inherit {ticketId || draft ? 'project' : 'global'} default ({inherited ? 'On' : 'Off'})
          </option>
        )}
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
      <span className="text-muted-foreground">Effective: {effective ? 'On' : 'Off'}</span>
    </label>
  )
}
