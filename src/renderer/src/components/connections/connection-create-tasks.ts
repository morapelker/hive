// The checklist shown while a connection is being created from projects: one line per step of
// lib/connection-create (the base branch of each project that joins on it, a pull of each
// other project's base branch when asked for, then a worktree in each of those). Shared by the
// New Connection dialog and the "Go to project" switcher; each draws its own list around these.

import type { ConnectionCreateProgress, ConnectionCreateStep } from '@/lib/connection-create'

/** One line of the checklist. */
export interface CreateTask {
  projectId: string
  projectName: string
  step: ConnectionCreateStep
  status: 'pending' | ConnectionCreateProgress['status']
}

/**
 * What creating a connection over `projects` will do, in the order it is done: the base branch
 * of every `useBase` project, then for the others every pull (when asked to pull), then every
 * worktree.
 */
export function planCreateTasks(
  projects: readonly { id: string; name: string; useBase?: boolean }[],
  autoPull: boolean
): CreateTask[] {
  const tasksFor = (step: ConnectionCreateStep, onBase: boolean): CreateTask[] =>
    projects
      .filter((project) => !!project.useBase === onBase)
      .map((project) => ({
        projectId: project.id,
        projectName: project.name,
        step,
        status: 'pending'
      }))
  return [
    ...tasksFor('base', true),
    ...(autoPull ? tasksFor('pull', false) : []),
    ...tasksFor('worktree', false)
  ]
}

/** The checklist after a step started or ended. null (no creation under way) stays null. */
export function applyCreateProgress(
  tasks: CreateTask[] | null,
  { projectId, step, status }: Pick<ConnectionCreateProgress, 'projectId' | 'step' | 'status'>
): CreateTask[] | null {
  return (
    tasks?.map((task) =>
      task.projectId === projectId && task.step === step ? { ...task, status } : task
    ) ?? null
  )
}

export function createTaskLabel(task: Pick<CreateTask, 'step' | 'projectName'>): string {
  if (task.step === 'base') return `Use the base branch of ${task.projectName}`
  return task.step === 'pull'
    ? `Pull ${task.projectName} from origin`
    : `Create worktree in ${task.projectName}`
}
