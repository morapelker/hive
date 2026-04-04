export type TipTriggerType = 'mount' | 'action'

export interface TipDefinition {
  id: string
  description: string
  trigger: TipTriggerType
  priority: number // Lower = higher priority
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

export const TIP_DEFINITIONS: Record<string, TipDefinition> = {
  'kanban-icon': {
    id: 'kanban-icon',
    description: 'You can manage your tickets as a kanban board from this icon.',
    trigger: 'mount',
    priority: 1,
    side: 'bottom'
  },
  'kanban-reenter': {
    id: 'kanban-reenter',
    description: 'You can re-enter the kanban board anytime from this icon.',
    trigger: 'action',
    priority: 2,
    side: 'bottom'
  },
  'worktree-connect': {
    id: 'worktree-connect',
    description: 'Right-click any workspace to connect it with others for multi-repo sessions.',
    trigger: 'mount',
    priority: 3,
    side: 'right'
  },
  'provider-right-click': {
    id: 'provider-right-click',
    description: 'Right-click to start a new session with a different provider.',
    trigger: 'mount',
    priority: 4,
    side: 'bottom',
    align: 'start'
  },
  'settings-default-provider': {
    id: 'settings-default-provider',
    description: 'You can permanently change your default provider from the settings.',
    trigger: 'action',
    priority: 5,
    side: 'bottom',
    align: 'end'
  }
}
