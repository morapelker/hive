import { useCallback, useMemo, useState } from 'react'
import { ArrowUpCircle, ArrowDownCircle, Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { useGitStore } from '@/stores/useGitStore'
import { cn } from '@/lib/utils'

interface ConnectionPushPullMember {
  worktree_path: string
  project_name: string
}

interface ConnectionPushPullProps {
  members: ConnectionPushPullMember[]
  className?: string
}

type MemberResult = { member: ConnectionPushPullMember; success: boolean; error?: string }

function describeFailures(failures: MemberResult[]): string {
  return failures
    .map((f) => `${f.member.project_name}: ${f.error || 'unknown error'}`)
    .join('\n')
}

/**
 * Push/Pull controls for a connection: runs the operation against every member
 * worktree path (each member's checked-out branch), just like the single-worktree
 * GitPushPull does for a normal project.
 */
export function ConnectionPushPull({
  members,
  className
}: ConnectionPushPullProps): React.JSX.Element | null {
  const push = useGitStore((s) => s.push)
  const pull = useGitStore((s) => s.pull)
  const branchInfoByWorktree = useGitStore((s) => s.branchInfoByWorktree)
  const [isPushingAll, setIsPushingAll] = useState(false)
  const [isPullingAll, setIsPullingAll] = useState(false)

  const { ahead, behind, trackedMembers } = useMemo(() => {
    let ahead = 0
    let behind = 0
    const trackedMembers: ConnectionPushPullMember[] = []
    for (const member of members) {
      const info = branchInfoByWorktree.get(member.worktree_path)
      ahead += info?.ahead || 0
      behind += info?.behind || 0
      if (info?.tracking) trackedMembers.push(member)
    }
    return { ahead, behind, trackedMembers }
  }, [members, branchInfoByWorktree])

  const runAll = useCallback(
    async (
      targets: ConnectionPushPullMember[],
      op: (worktreePath: string) => Promise<{ success: boolean; error?: string }>
    ): Promise<MemberResult[]> => {
      const results: MemberResult[] = []
      for (const member of targets) {
        try {
          const result = await op(member.worktree_path)
          results.push({ member, success: result.success, error: result.error })
        } catch (error) {
          results.push({
            member,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      return results
    },
    []
  )

  const handlePushAll = useCallback(async () => {
    if (members.length === 0) return
    setIsPushingAll(true)
    try {
      const results = await runAll(members, (p) => push(p))
      const failures = results.filter((r) => !r.success)
      if (failures.length === 0) {
        toast.success(`Pushed ${results.length} repo${results.length === 1 ? '' : 's'}`)
      } else {
        toast.error(
          `Push failed for ${failures.length} of ${results.length} repo${results.length === 1 ? '' : 's'}`,
          { description: describeFailures(failures) }
        )
      }
    } finally {
      setIsPushingAll(false)
    }
  }, [members, push, runAll])

  const handlePullAll = useCallback(async () => {
    if (trackedMembers.length === 0) return
    setIsPullingAll(true)
    try {
      const results = await runAll(trackedMembers, (p) => pull(p))
      const failures = results.filter((r) => !r.success)
      const skipped = members.length - trackedMembers.length
      if (failures.length === 0) {
        toast.success(`Pulled ${results.length} repo${results.length === 1 ? '' : 's'}`, {
          description:
            skipped > 0 ? `${skipped} repo${skipped === 1 ? '' : 's'} without upstream skipped` : undefined
        })
      } else {
        toast.error(
          `Pull failed for ${failures.length} of ${results.length} repo${results.length === 1 ? '' : 's'}`,
          { description: describeFailures(failures) }
        )
      }
    } finally {
      setIsPullingAll(false)
    }
  }, [members.length, trackedMembers, pull, runAll])

  if (members.length === 0) return null

  const isOperating = isPushingAll || isPullingAll

  return (
    <div
      className={cn('flex gap-2 px-2 py-2 border-t border-border', className)}
      data-testid="connection-push-pull"
    >
      <Button
        variant="outline"
        size="sm"
        className="flex-1 h-7 text-xs"
        onClick={handlePushAll}
        disabled={isOperating}
        title={`Push all ${members.length} repos`}
        data-testid="connection-push-button"
      >
        {isPushingAll ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : (
          <ArrowUpCircle className="h-3 w-3 mr-1" />
        )}
        Push all
        {ahead > 0 && <span className="ml-1 text-[10px] opacity-75">({ahead})</span>}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="flex-1 h-7 text-xs"
        onClick={handlePullAll}
        disabled={isOperating || trackedMembers.length === 0}
        title={
          trackedMembers.length === 0
            ? 'No repo has an upstream branch'
            : `Pull all ${trackedMembers.length} repos with an upstream`
        }
        data-testid="connection-pull-button"
      >
        {isPullingAll ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : (
          <ArrowDownCircle className="h-3 w-3 mr-1" />
        )}
        Pull all
        {behind > 0 && <span className="ml-1 text-[10px] opacity-75">({behind})</span>}
      </Button>
    </div>
  )
}
