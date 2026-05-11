import { useEffect, useMemo, useState } from 'react'
import type { SuggestionItem } from '@shared/types/setup-suggestions'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

interface SetupScriptSuggestionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: SuggestionItem[]
  currentValue: string
  onApply: (next: string) => void
}

export function SetupScriptSuggestionsDialog({
  open,
  onOpenChange,
  items,
  currentValue,
  onApply
}: SetupScriptSuggestionsDialogProps): React.JSX.Element {
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setCheckedIds(new Set(items.filter((item) => item.defaultChecked).map((item) => item.id)))
  }, [items, open])

  const selectedCommands = useMemo(
    () => items.filter((item) => checkedIds.has(item.id)).map((item) => item.command),
    [checkedIds, items]
  )

  const selectedText = selectedCommands.join('\n')
  const hasSelection = selectedCommands.length > 0
  const isEmpty = currentValue.trim() === ''

  const toggleItem = (id: string): void => {
    setCheckedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const apply = (mode: 'replace' | 'append'): void => {
    if (!hasSelection) return
    const next =
      mode === 'append' && currentValue.trim() !== ''
        ? `${currentValue.trimEnd()}\n${selectedText}`
        : selectedText
    onApply(next)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Suggested setup commands</DialogTitle>
          <DialogDescription>
            Choose the command lines to use for this project setup script.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-start gap-3 rounded-md border border-border bg-muted/20 p-3"
            >
              <Checkbox
                checked={checkedIds.has(item.id)}
                onCheckedChange={() => toggleItem(item.id)}
                className="mt-0.5"
                aria-label={item.label}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-xs text-muted-foreground">{item.label}</div>
                <code className="block whitespace-pre-wrap break-words font-mono text-sm">
                  {item.command}
                </code>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {isEmpty ? (
            <Button onClick={() => apply('replace')} disabled={!hasSelection}>
              Apply
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => apply('append')} disabled={!hasSelection}>
                Append
              </Button>
              <Button onClick={() => apply('replace')} disabled={!hasSelection}>
                Replace
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
