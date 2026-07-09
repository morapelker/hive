import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupApi } from '../backup-api'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'

describe('backupApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes exportBackup through the renderer RPC client', async () => {
    const result = { success: true, path: '/tmp/hive-backup.yaml', projectCount: 3 }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(backupApi.exportBackup()).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith('backupOps.exportBackup', {})
  })

  it('routes openBackupFile through the renderer RPC client', async () => {
    const backup = {
      version: 1,
      kind: 'hive-backup' as const,
      created_at: '2026-07-09T00:00:00.000Z',
      app_version: '1.2.12',
      projects: []
    }
    const result = { canceled: false, backup }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(backupApi.openBackupFile()).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith('backupOps.openBackupFile', {})
  })

  it('routes classifyProjects through the renderer RPC client', async () => {
    const projects = [{ name: 'hive', path: '/Users/me/hive', remoteUrl: 'git@github.com:a/b.git' }]
    const result = [
      {
        path: '/Users/me/hive',
        classification: 'exists-match' as const,
        alreadyInHive: true,
        hiveProjectId: 'project-1',
        effectivePath: '/Users/me/hive',
        localRemoteUrl: 'git@github.com:a/b.git'
      }
    ]
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(backupApi.classifyProjects(projects)).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith('backupOps.classifyProjects', { projects })
  })

  it('routes restoreProject through the renderer RPC client', async () => {
    const project = {
      name: 'hive',
      path: '/Users/me/hive',
      remote_url: 'git@github.com:a/b.git',
      description: null,
      tags: null,
      language: null,
      setup_script: null,
      run_script: null,
      archive_script: null,
      worktree_create_script: null,
      custom_commands: null,
      auto_assign_port: false,
      sort_order: 0,
      kanban_simple_mode: false,
      kanban_storage_mode: 'internal' as const,
      kanban_markdown_config: null,
      custom_icon: null,
      worktrees: [],
      tickets: null,
      ticket_dependencies: null
    }
    const options = { cloneParentDir: '/Users/me/code' }
    const result = {
      success: true,
      projectId: 'project-1',
      projectName: 'hive',
      action: 'cloned' as const,
      warnings: [],
      worktrees: [],
      tickets: { restored: 0, dependencyErrors: 0, skipped: true }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(backupApi.restoreProject(project, options)).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith('backupOps.restoreProject', { project, options })
  })
})
