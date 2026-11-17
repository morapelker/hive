// Settings › General, "Dev folder": the folder this Mac clones projects into by itself
// (Teleport, Discord) and the clone dialogs start from. The row shows the folder in effect,
// lets the person type or pick another one, and, while projects still sit in a folder used
// before, offers to move them over.
//
// The path is a draft until it is committed: Enter or Save sends it, Escape puts the folder
// in effect back, and leaving the field does neither, so a half-typed path is never set. The
// server decides what is a usable folder; its refusal is one sentence, shown as it is.
//
// The row draws nothing until the server answered with a dev folder. A window that got no
// answer and a test double that answers something else therefore see Settings › General
// exactly as it was without this row.

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { projectApi } from '@/api/project-api'
import { settingsApi } from '@/api/settings-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { openDevFolderMove } from '@/lib/dev-folder/move-projects'
import { useDevFolderMoveStore } from '@/lib/dev-folder/store'
import { toast } from '@/lib/toast'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { isDevFolderState, type DevFolderState } from '@shared/types/dev-folder'

// Never rejects: no answer, a refusal and an answer of another shape all read as "no dev
// folder to show".
const readDevFolder = async (): Promise<DevFolderState | null> => {
  try {
    const answer: unknown = await settingsApi.getDevFolder()
    return isDevFolderState(answer) ? answer : null
  } catch {
    return null
  }
}

type SetAnswer = { changed: true; state: DevFolderState | null } | { changed: false; error: string }

// Never rejects: a call that failed is a sentence under the field, like a refusal.
const sendDevFolder = async (path: string | null): Promise<SetAnswer> => {
  try {
    const answer: unknown = await settingsApi.setDevFolder(path)
    const result = (typeof answer === 'object' && answer !== null ? answer : {}) as {
      success?: unknown
      state?: unknown
      error?: unknown
    }
    if (result.success === true) {
      return { changed: true, state: isDevFolderState(result.state) ? result.state : null }
    }
    if (result.success === false && typeof result.error === 'string' && result.error.length > 0) {
      return { changed: false, error: result.error }
    }
    return { changed: false, error: 'The dev folder could not be changed.' }
  } catch (error) {
    const reason = (error instanceof Error ? error.message : '').trim().replace(/[.\s]+$/, '')
    return {
      changed: false,
      error: reason
        ? `The dev folder could not be changed: ${reason}.`
        : 'The dev folder could not be changed.'
    }
  }
}

// "New project" starts from the folder a project was last created in. When that is the dev
// folder that was just left, it follows to the new one: otherwise the next new project would
// still be offered the old folder, as if the setting had not taken effect. The settings store
// is read here, at the moment of the change, and never subscribed to.
const followLastProjectDirectory = (left: string, entered: string): void => {
  try {
    const settings = useSettingsStore.getState()
    if (settings.lastProjectDirectory !== left) return
    void Promise.resolve(settings.updateSetting('lastProjectDirectory', entered)).catch(
      () => undefined
    )
  } catch {
    // The dev folder changed all the same; "New project" keeps its own folder.
  }
}

const leftBehindSentence = (leftBehind: DevFolderState['leftBehind']): string => {
  const { count, folders } = leftBehind
  const projects = count === 1 ? '1 project is' : `${count} projects are`
  if (folders.length === 1) return `${projects} still in ${folders[0]}.`
  if (folders.length > 1) return `${projects} still in ${folders.length} other folders.`
  return `${projects} still in a folder used before.`
}

export function SettingsDevFolder(): React.JSX.Element | null {
  const [state, setState] = useState<DevFolderState | null>(null)
  // What is typed in the field; null while the field shows the folder in effect.
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  // Names the newest question to the server: an answer to an older one is dropped.
  const asked = useRef(0)
  const readOnMount = useRef(false)
  const moveClosed = useDevFolderMoveStore((move) => move.phase === 'closed')

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // On mount, whatever "Move projects" is doing (Settings can be opened again while its dialog
  // is open, and a row that never asked would draw nothing), and again each time the dialog is
  // closed: what it moved changes how many projects are left behind.
  useEffect(() => {
    if (!moveClosed && readOnMount.current) return
    readOnMount.current = true
    const turn = ++asked.current
    void readDevFolder().then((next) => {
      if (next && mounted.current && turn === asked.current) setState(next)
    })
  }, [moveClosed])

  const dirty = state !== null && draft !== null && draft !== state.path
  const revertible = dirty || error !== null

  // Escape in the field puts the folder in effect back. The Settings dialog listens for Escape
  // on the document before the field sees the key, so it is taken here, one step earlier, and
  // only while there is something to put back: with nothing typed, Escape closes Settings as
  // it does everywhere else.
  useEffect(() => {
    if (!revertible) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.target !== inputRef.current) return
      event.stopPropagation()
      event.preventDefault()
      setDraft(null)
      setError(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [revertible])

  if (!state) return null

  // While "Move projects" is open the folder stays as it is: its list was made for this dev
  // folder, and a run would refuse every project that is left once the folder is another one.
  const locked = busy || !moveClosed

  /** One change at a time: the buttons and the field wait while one is under way. */
  const whileBusy = async (task: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    // Asked at the moment of the change: Enter in the field arrives here too.
    if (useDevFolderMoveStore.getState().phase !== 'closed') return
    busyRef.current = true
    setBusy(true)
    try {
      await task()
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const change = async (path: string | null): Promise<void> => {
    const left = state.path
    const turn = ++asked.current
    setError(null)
    const answer = await sendDevFolder(path)
    // Read again whatever the answer was: a refused folder may have been created on the way,
    // and the count of projects left behind belongs to the folder now in effect.
    const fresh = await readDevFolder()
    if (!mounted.current || turn !== asked.current) return
    const after = fresh ?? (answer.changed ? answer.state : null)
    if (after) setState(after)
    if (!answer.changed) {
      setError(answer.error)
      return
    }
    setDraft(null)
    if (after && after.path !== left) {
      followLastProjectDirectory(left, after.path)
      toast.success('Dev folder changed', { description: after.path })
    }
  }

  const saveDraft = (): void => {
    if (draft === null) return
    // A typed path loses the spaces around it: a folder name that ends in one is a slip of
    // the keyboard far more often than a wish.
    const typed = draft.trim()
    if (typed.length === 0 || typed === state.path) {
      setDraft(null)
      setError(null)
      return
    }
    void whileBusy(() => change(typed))
  }

  const browse = (): Promise<void> =>
    whileBusy(async () => {
      let picked: unknown = null
      try {
        picked = await projectApi.openDirectoryDialog()
      } catch {
        picked = null
      }
      // Nothing picked (the panel was cancelled, or this window has no panel to open).
      if (typeof picked !== 'string' || picked.length === 0 || !mounted.current) return
      // The panel's path is sent as it is: it names a folder that exists, spaces included.
      setDraft(picked)
      await change(picked)
    })

  return (
    <div className="space-y-2" data-testid="dev-folder">
      <div>
        <label className="text-sm font-medium" htmlFor="dev-folder-path">
          Dev folder
        </label>
        <p className="text-xs text-muted-foreground">
          Where this Mac puts the projects it clones for you: Teleport and Discord. The clone
          dialogs start here too.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          id="dev-folder-path"
          className="flex-1 font-mono"
          value={draft ?? state.path}
          // Read-only, not disabled, while a change is under way: the field keeps the focus,
          // so Escape after a refusal still reaches it.
          readOnly={locked}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? 'dev-folder-error' : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            saveDraft()
          }}
          data-testid="dev-folder-path"
        />
        {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {dirty && (
          <Button
            size="sm"
            disabled={locked || draft.trim().length === 0}
            onClick={saveDraft}
            data-testid="dev-folder-save"
          >
            Save
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={locked}
          onClick={() => void browse()}
          data-testid="dev-folder-browse"
        >
          Browse…
        </Button>
        {!state.isDefault && (
          <Button
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={() => void whileBusy(() => change(null))}
            data-testid="dev-folder-use-default"
          >
            Use default
          </Button>
        )}
      </div>
      {error !== null && (
        <p
          className="text-xs text-destructive"
          id="dev-folder-error"
          role="alert"
          data-testid="dev-folder-error"
        >
          {error}
        </p>
      )}
      {!state.exists && (
        <p className="text-xs text-muted-foreground" data-testid="dev-folder-missing">
          This folder does not exist yet. Hive creates it the first time it puts a project
          there.
        </p>
      )}
      {state.leftBehind.count > 0 && (
        <div
          className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2"
          data-testid="dev-folder-move-hint"
        >
          <p className="min-w-0 break-words text-xs text-muted-foreground">
            {leftBehindSentence(state.leftBehind)}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            // While the dialog is open (a run can outlive Settings) there is nothing to open,
            // and while the folder is being changed the plan would be for the wrong one.
            disabled={locked}
            onClick={() => void openDevFolderMove()}
            data-testid="dev-folder-move-open"
          >
            Move projects…
          </Button>
        </div>
      )}
    </div>
  )
}
