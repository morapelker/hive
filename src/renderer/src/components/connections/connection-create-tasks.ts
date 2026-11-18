// The checklist shown while a connection is being created from projects: one line per step of
// lib/connection-create (a pull of each project's base branch when asked for, then a worktree
// in each project). Shared by the New Connection dialog and the "Go to project" switcher; each
// draws its own list around these.

import type { ConnectionCreateProgress, ConnectionCreateStep } from '@/lib/connection-create'

/** One line of the checklist. */
export interface CreateTask {
  projectId: string
  projectName: string
  step: ConnectionCreateStep
  status: 'pending' | ConnectionCreateProgress['status']
}

/**
 * What creating a connection over `projects` will do, in the order it is done: every pull
 * first (when asked to pull), then every worktree.
 */
export function planCreateTasks(
  projects: readonly { id: string; name: string }[],
  autoPull: boolean
): CreateTask[] {
  const tasksFor = (step: ConnectionCreateStep): CreateTask[] =>
    projects.map((project) => ({
      projectId: project.id,
      projectName: project.name,
      step,
      status: 'pending'
    }))
  return [...(autoPull ? tasksFor('pull') : []), ...tasksFor('worktree')]
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
  return task.step === 'pull'
    ? `Pull ${task.projectName} from origin`
    : `Create worktree in ${task.projectName}`
}
