import { useState, useCallback } from 'react'
import { ArrowDownUp, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/stores'

export function SortProjectsButton(): React.JSX.Element {
  const [isSorting, setIsSorting] = useState(false)
  const sortProjectsByLastMessage = useProjectStore((s) => s.sortProjectsByLastMessage)

  const handleSort = useCallback(async (): Promise<void> => {
    if (isSorting) return
    setIsSorting(true)
    try {
      await sortProjectsByLastMessage()
    } finally {
      setIsSorting(false)
    }
  }, [isSorting, sortProjectsByLastMessage])

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      title="Sort by last message"
      onClick={handleSort}
      disabled={isSorting}
      data-testid="sort-projects-button"
    >
      {isSorting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <ArrowDownUp className="h-4 w-4" />
      )}
    </Button>
  )
}
