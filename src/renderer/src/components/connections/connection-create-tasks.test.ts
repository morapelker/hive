import { describe, expect, it } from 'vitest'
import { applyCreateProgress, createTaskLabel, planCreateTasks } from './connection-create-tasks'

const PROJECTS = [
  { id: 'seller-ios', name: 'seller-ios' },
  { id: 'ads-api', name: 'ads-api', useBase: true },
  { id: 'ledger-core', name: 'ledger-core' }
]

const lines = (tasks: ReturnType<typeof planCreateTasks>): string[] =>
  tasks.map((task) => `${createTaskLabel(task)} [${task.status}]`)

describe('planCreateTasks', () => {
  it('lists every pull, then every worktree', () => {
    const projects = PROJECTS.map(({ id, name }) => ({ id, name }))
    expect(lines(planCreateTasks(projects, true))).toEqual([
      'Pull seller-ios from origin [pending]',
      'Pull ads-api from origin [pending]',
      'Pull ledger-core from origin [pending]',
      'Create worktree in seller-ios [pending]',
      'Create worktree in ads-api [pending]',
      'Create worktree in ledger-core [pending]'
    ])
    expect(lines(planCreateTasks(projects, false))).toEqual([
      'Create worktree in seller-ios [pending]',
      'Create worktree in ads-api [pending]',
      'Create worktree in ledger-core [pending]'
    ])
  })

  it('lists a project that joins on its base branch once, first, with no pull and no worktree', () => {
    expect(lines(planCreateTasks(PROJECTS, true))).toEqual([
      'Use the base branch of ads-api [pending]',
      'Pull seller-ios from origin [pending]',
      'Pull ledger-core from origin [pending]',
      'Create worktree in seller-ios [pending]',
      'Create worktree in ledger-core [pending]'
    ])
  })

  it('lists only base branches when every project joins on its own', () => {
    const projects = PROJECTS.map((project) => ({ ...project, useBase: true }))
    expect(planCreateTasks(projects, true).map((task) => task.step)).toEqual([
      'base',
      'base',
      'base'
    ])
  })
})

describe('applyCreateProgress', () => {
  it('moves the one step of the one project it is told about', () => {
    const tasks = planCreateTasks(PROJECTS, false)
    const next = applyCreateProgress(tasks, {
      projectId: 'ads-api',
      step: 'base',
      status: 'done'
    })
    expect(lines(next ?? [])).toEqual([
      'Use the base branch of ads-api [done]',
      'Create worktree in seller-ios [pending]',
      'Create worktree in ledger-core [pending]'
    ])
  })

  it('leaves no checklist as it is', () => {
    expect(
      applyCreateProgress(null, { projectId: 'ads-api', step: 'base', status: 'done' })
    ).toBeNull()
  })
})
