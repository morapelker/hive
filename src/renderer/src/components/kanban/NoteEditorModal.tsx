import { useCallback, useEffect, useState } from 'react'
import { StickyNote } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const MAX_NOTE_LENGTH = 500

interface NoteEditorModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ticketTitle: string
  initialNote: string | null
  onSave: (note: string | null) => Promise<void> | void
}

export function NoteEditorModal({
  open,
  onOpenChange,
  ticketTitle,
  initialNote,
  onSave
}: NoteEditorModalProps) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setValue(initialNote ?? '')
  }, [open, initialNote])

  const handleSave = useCallback(async () => {
    if (saving) return
    const trimmed = value.trim()
    const next = trimmed.length === 0 ? null : trimmed
    setSaving(true)
    try {
      await onSave(next)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }, [value, saving, onSave, onOpenChange])

  const handleClear = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      await onSave(null)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }, [saving, onSave, onOpenChange])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSave()
    }
  }

  const hasExistingNote = !!initialNote && initialNote.trim().length > 0
  const remaining = MAX_NOTE_LENGTH - value.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <StickyNote className="h-4 w-4" />
            Note
          </DialogTitle>
          <p className="text-xs text-muted-foreground truncate mt-1">{ticketTitle}</p>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <Textarea
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value.slice(0, MAX_NOTE_LENGTH))}
            onKeyDown={handleKeyDown}
            placeholder="Write a personal note for this ticket..."
            className="min-h-[140px] resize-none"
            disabled={saving}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Not sent to the LLM.</span>
            <span>{remaining} characters remaining</span>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {hasExistingNote && (
              <Button variant="ghost" size="sm" onClick={handleClear} disabled={saving}>
                Clear note
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save note'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
