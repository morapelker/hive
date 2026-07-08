import { useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * The subset of a synced org member's profile the usage popover needs to
 * render an avatar stack. Mirrors the `member` shape returned by the
 * `listAccountMembers` GraphQL query (see `fetchHiveAccountMembers` in
 * `@/api/hive-enterprise/client`).
 */
export interface AccountMemberInfo {
  id: string
  email: string
  name: string | null
  picture: string | null
}

const MAX_VISIBLE_AVATARS = 3

const AVATAR_CLASSNAME = 'h-4 w-4 rounded-full ring-1 ring-background shrink-0'
const TRIGGER_CLASSNAME = 'shrink-0 cursor-default bg-transparent border-none p-0 rounded-full'

function initialFor(member: AccountMemberInfo): string {
  const source = member.name ?? member.email
  return source ? source[0] : '?'
}

function MemberAvatar({ member }: { member: AccountMemberInfo }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const label = member.name ?? member.email

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={TRIGGER_CLASSNAME}
          aria-label={label}
          data-testid="member-avatar"
        >
          {!failed && member.picture ? (
            <img
              src={member.picture}
              alt={label}
              className={cn(AVATAR_CLASSNAME, 'bg-white')}
              onError={() => setFailed(true)}
            />
          ) : (
            <div
              className={cn(
                AVATAR_CLASSNAME,
                'bg-muted flex items-center justify-center text-[9px] font-medium text-muted-foreground uppercase'
              )}
            >
              {initialFor(member)}
            </div>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function MemberAvatarOverflow({ members }: { members: AccountMemberInfo[] }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={TRIGGER_CLASSNAME}
          aria-label={`${members.length} more members`}
          data-testid="member-avatar-overflow"
        >
          <div
            className={cn(
              AVATAR_CLASSNAME,
              'bg-muted flex items-center justify-center text-[9px] font-medium text-muted-foreground'
            )}
          >
            +{members.length}
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {members.map((member) => (
          <div key={member.id}>{member.name ?? member.email}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

export interface MemberAvatarStackProps {
  members: AccountMemberInfo[] | undefined
  loading: boolean
}

export function MemberAvatarStack({
  members,
  loading
}: MemberAvatarStackProps): React.JSX.Element | null {
  if (loading) {
    return (
      <div className="flex -space-x-1.5 items-center" data-testid="member-avatar-stack-loading">
        <div className="h-4 w-4 rounded-full bg-muted animate-pulse ring-1 ring-background" />
      </div>
    )
  }

  if (!members || members.length === 0) return null

  const visible = members.slice(0, MAX_VISIBLE_AVATARS)
  const overflow = members.slice(MAX_VISIBLE_AVATARS)

  return (
    <div className="flex -space-x-1.5 items-center" data-testid="member-avatar-stack">
      {visible.map((member) => (
        <MemberAvatar key={member.id} member={member} />
      ))}
      {overflow.length > 0 && <MemberAvatarOverflow members={overflow} />}
    </div>
  )
}
