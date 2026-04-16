import { Github, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import jiraIcon from '@/assets/provider-icons/jira.svg'

// ── Per-provider style config ────────────────────────────────────────
interface ProviderConfig {
  Icon?: LucideIcon
  imgSrc?: string
  bg: string
  color: string
  label: string
}

const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  github: {
    Icon: Github,
    bg: 'bg-zinc-200 dark:bg-zinc-700',
    color: 'text-zinc-700 dark:text-zinc-200',
    label: 'GitHub',
  },
  jira: {
    imgSrc: jiraIcon,
    bg: 'bg-blue-500 dark:bg-blue-600',
    color: '',
    label: 'Jira',
  },
}

const FALLBACK_CONFIG: ProviderConfig = {
  Icon: Github,
  bg: 'bg-zinc-200 dark:bg-zinc-700',
  color: 'text-zinc-700 dark:text-zinc-200',
  label: 'External',
}

// ── Component ────────────────────────────────────────────────────────
interface ProviderIconProps {
  provider: string
  size?: 'sm' | 'md'
  className?: string
}

export function ProviderIcon({ provider, size = 'sm', className }: ProviderIconProps) {
  const config = PROVIDER_CONFIG[provider] ?? FALLBACK_CONFIG
  const { Icon, imgSrc, bg, color } = config

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full shrink-0',
        bg,
        size === 'sm' && 'h-5 w-5',
        size === 'md' && 'h-7 w-7',
        className
      )}
      title={config.label}
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          alt={config.label}
          className={cn(
            size === 'sm' && 'h-3 w-3',
            size === 'md' && 'h-4 w-4'
          )}
          draggable={false}
        />
      ) : Icon ? (
        <Icon
          className={cn(
            color,
            size === 'sm' && 'h-3 w-3',
            size === 'md' && 'h-4 w-4'
          )}
        />
      ) : null}
    </span>
  )
}

/** Get the display label for a provider id string */
export function getProviderLabel(provider: string): string {
  return PROVIDER_CONFIG[provider]?.label ?? provider
}
