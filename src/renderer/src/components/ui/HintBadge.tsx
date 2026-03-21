import { type HintMode, type HintActionMode } from '@/stores/useHintStore'

interface HintBadgeProps {
  code: string
  mode: HintMode
  pendingChar: string | null
  actionMode?: HintActionMode
}

const matchColorsByAction = {
  select: {
    bg: 'bg-primary/20 border-primary/60',
    text: 'text-primary'
  },
  pin: {
    bg: 'bg-green-500/20 border-green-500/60',
    text: 'text-green-500'
  },
  archive: {
    bg: 'bg-red-500/20 border-red-500/60',
    text: 'text-red-500'
  }
} as const

export function HintBadge({ code, mode, pendingChar, actionMode = 'select' }: HintBadgeProps) {
  const isMatch = mode === 'pending' && pendingChar && code[0] === pendingChar

  const baseClasses =
    'inline-flex items-center font-mono text-[10px] px-1 py-0.5 rounded bg-muted/60 border border-border/50 text-muted-foreground shrink-0 select-none'

  if (mode === 'idle') {
    return (
      <span className={baseClasses}>
        <span>{code[0]}</span>
        <span>{code[1]}</span>
      </span>
    )
  }

  if (isMatch) {
    const colors = matchColorsByAction[actionMode]
    return (
      <span className={`${baseClasses} ${colors.bg}`}>
        <span className={`${colors.text} font-bold`}>{code[0]}</span>
        <span className="text-foreground font-medium">{code[1]}</span>
      </span>
    )
  }

  // pending but no match
  return (
    <span className={`${baseClasses} opacity-25`}>
      <span>{code[0]}</span>
      <span>{code[1]}</span>
    </span>
  )
}
