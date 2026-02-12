import { useState, useEffect, useMemo } from 'react'
import { Loader2, Search, GitBranch, Globe, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface BranchInfo {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

interface BranchPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  onSelect: (branchName: string) => void
}

export function BranchPickerDialog({
  open,
  onOpenChange,
  projectPath,
  onSelect
}: BranchPickerDialogProps): React.JSX.Element {
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Fetch branches when dialog opens
  useEffect(() => {
    if (!open) {
      setFilter('')
      return
    }

    setLoading(true)
    setError(null)

    window.gitOps
      .listBranchesWithStatus(projectPath)
      .then((result) => {
        if (result.success) {
          setBranches(result.branches)
        } else {
          setError(result.error || 'Failed to load branches')
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load branches')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [open, projectPath])

  // Filter and sort branches
  const filteredBranches = useMemo(() => {
    const lowerFilter = filter.toLowerCase()
    const filtered = branches.filter((b) => b.name.toLowerCase().includes(lowerFilter))

    // Sort: local first, then remote; alphabetical within each group
    return filtered.sort((a, b) => {
      if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
      return a.name.localeCompare(b.name)
    })
  }, [branches, filter])

  const handleSelect = (branch: BranchInfo): void => {
    onSelect(branch.name)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Workspace From Branch</DialogTitle>
          <DialogDescription>Select a branch to create a new workspace from.</DialogDescription>
        </DialogHeader>

        {/* Search/Filter */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter branches..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>

        {/* Branch List */}
        <div className="max-h-[300px] overflow-y-auto border rounded-md">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading branches...</span>
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center text-sm text-destructive">{error}</div>
          ) : filteredBranches.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {filter ? 'No branches match your filter' : 'No branches found'}
            </div>
          ) : (
            <div className="py-1">
              {filteredBranches.map((branch) => (
                <button
                  key={`${branch.name}-${branch.isRemote}`}
                  className={cn(
                    'flex items-center gap-2 w-full px-3 py-2 text-sm text-left',
                    'hover:bg-accent hover:text-accent-foreground transition-colors',
                    'focus:bg-accent focus:text-accent-foreground focus:outline-none'
                  )}
                  onClick={() => handleSelect(branch)}
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{branch.name}</span>
                  {branch.isRemote && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-muted text-muted-foreground shrink-0">
                      <Globe className="h-2.5 w-2.5" />
                      remote
                    </span>
                  )}
                  {branch.isCheckedOut && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary/10 text-primary shrink-0">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      active
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer info */}
        {!loading && !error && filteredBranches.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {filteredBranches.length} branch{filteredBranches.length !== 1 ? 'es' : ''}
            {filter && ` matching "${filter}"`}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
