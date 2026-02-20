import { Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useRecentStore } from '@/stores'
import { cn } from '@/lib/utils'

export function RecentToggleButton(): React.JSX.Element {
  const recentVisible = useRecentStore((s) => s.recentVisible)
  const toggleRecent = useRecentStore((s) => s.toggleRecent)

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('h-6 w-6', recentVisible && 'text-primary bg-accent')}
      title="Toggle recent activity"
      onClick={toggleRecent}
      data-testid="recent-toggle-button"
    >
      <Zap className="h-4 w-4" />
    </Button>
  )
}
