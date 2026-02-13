import { Minimize2 } from 'lucide-react'

interface CompactionPillProps {
  auto: boolean
}

export function CompactionPill({ auto }: CompactionPillProps) {
  return (
    <div className="my-2 flex justify-center" data-testid="compaction-pill">
      <span className="inline-flex items-center gap-1 bg-muted text-muted-foreground text-xs rounded-full px-2 py-0.5">
        <Minimize2 className="h-3 w-3" />
        {auto ? 'Auto-compacted' : 'Context compacted'}
      </span>
    </div>
  )
}
