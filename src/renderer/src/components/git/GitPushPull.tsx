import { useState, useCallback } from 'react'
import { ArrowUpCircle, ArrowDownCircle, Loader2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useGitStore } from '@/stores/useGitStore'
import { cn } from '@/lib/utils'

interface GitPushPullProps {
  worktreePath: string | null
  className?: string
}

export function GitPushPull({
  worktreePath,
  className
}: GitPushPullProps): React.JSX.Element | null {
  const [forcePush, setForcePush] = useState(false)
  const [rebasePull, setRebasePull] = useState(false)
  const [showForceConfirm, setShowForceConfirm] = useState(false)

  const { push, pull, isPushing, isPulling } = useGitStore()

  // Subscribe to branch info for ahead/behind counts
  const branchInfoByWorktree = useGitStore((state) => state.branchInfoByWorktree)
  const branchInfo = worktreePath ? branchInfoByWorktree.get(worktreePath) : undefined

  const hasTracking = !!branchInfo?.tracking
  const ahead = branchInfo?.ahead || 0
  const behind = branchInfo?.behind || 0

  const handlePush = useCallback(async () => {
    if (!worktreePath) return

    // Check for force push confirmation
    if (forcePush && !showForceConfirm) {
      setShowForceConfirm(true)
      return
    }

    setShowForceConfirm(false)

    const result = await push(worktreePath, undefined, undefined, forcePush)

    if (result.success) {
      toast.success(forcePush ? 'Force pushed successfully' : 'Pushed successfully')
      setForcePush(false)
    } else {
      toast.error('Push failed', {
        description: result.error
      })
    }
  }, [worktreePath, forcePush, showForceConfirm, push])

  const handlePull = useCallback(async () => {
    if (!worktreePath) return

    const result = await pull(worktreePath, undefined, undefined, rebasePull)

    if (result.success) {
      toast.success(rebasePull ? 'Pulled with rebase successfully' : 'Pulled successfully')
    } else {
      toast.error('Pull failed', {
        description: result.error
      })
    }
  }, [worktreePath, rebasePull, pull])

  const handleCancelForce = useCallback(() => {
    setShowForceConfirm(false)
    setForcePush(false)
  }, [])

  if (!worktreePath) {
    return null
  }

  const isOperating = isPushing || isPulling

  return (
    <div className={cn('flex flex-col gap-2 px-2 py-2 border-t', className)} data-testid="git-push-pull">
      {/* Force push confirmation dialog */}
      {showForceConfirm && (
        <div className="bg-destructive/10 border border-destructive/50 rounded-md p-2 text-xs" data-testid="force-push-confirm">
          <div className="flex items-start gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">Force push warning</p>
              <p className="text-muted-foreground mt-1">
                Force pushing will overwrite remote history. This can cause problems for collaborators.
              </p>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={handleCancelForce}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-6 text-xs"
              onClick={handlePush}
              disabled={isPushing}
            >
              {isPushing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                'Force Push'
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Push/Pull buttons */}
      {!showForceConfirm && (
        <>
          <div className="flex gap-2">
            {/* Push button */}
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-7 text-xs"
              onClick={handlePush}
              disabled={isOperating || (!hasTracking && ahead === 0)}
              data-testid="push-button"
            >
              {isPushing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <ArrowUpCircle className="h-3 w-3 mr-1" />
              )}
              Push
              {ahead > 0 && (
                <span className="ml-1 text-[10px] opacity-75">({ahead})</span>
              )}
            </Button>

            {/* Pull button */}
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-7 text-xs"
              onClick={handlePull}
              disabled={isOperating || !hasTracking}
              data-testid="pull-button"
            >
              {isPulling ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <ArrowDownCircle className="h-3 w-3 mr-1" />
              )}
              Pull
              {behind > 0 && (
                <span className="ml-1 text-[10px] opacity-75">({behind})</span>
              )}
            </Button>
          </div>

          {/* Options */}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <label className="flex items-center gap-1 cursor-pointer hover:text-foreground">
              <Checkbox
                checked={forcePush}
                onCheckedChange={(checked) => setForcePush(checked === true)}
                className="h-3 w-3"
                disabled={isOperating}
                data-testid="force-push-checkbox"
              />
              Force push
            </label>
            <label className="flex items-center gap-1 cursor-pointer hover:text-foreground">
              <Checkbox
                checked={rebasePull}
                onCheckedChange={(checked) => setRebasePull(checked === true)}
                className="h-3 w-3"
                disabled={isOperating}
                data-testid="rebase-pull-checkbox"
              />
              Rebase on pull
            </label>
          </div>

          {/* Status hint */}
          {!hasTracking && (
            <div className="text-[10px] text-muted-foreground text-center">
              No upstream branch set. Push will set upstream.
            </div>
          )}
        </>
      )}
    </div>
  )
}
