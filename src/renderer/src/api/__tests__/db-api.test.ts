import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { dbApi } from '../db-api'

describe('dbApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes schemaVersion through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(42)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.schemaVersion()).resolves.toBe(42)
    expect(request).toHaveBeenCalledWith('db.schemaVersion')
  })

  it('routes tableExists through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.tableExists('projects')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.tableExists', { tableName: 'projects' })
  })

  it('routes getIndexes through the renderer RPC client', async () => {
    const indexes = [{ name: 'idx_projects_path', tbl_name: 'projects' }]
    const request = vi.fn().mockResolvedValue(indexes)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.getIndexes()).resolves.toBe(indexes)
    expect(request).toHaveBeenCalledWith('db.getIndexes')
  })

  it('routes diffComment.create through the renderer RPC client', async () => {
    const comment = {
      id: 'comment-1',
      worktree_id: 'worktree-1',
      file_path: 'src/app.ts',
      line_start: 12,
      line_end: null,
      anchor_text: 'const value = 1',
      anchor_context_before: null,
      anchor_context_after: null,
      body: 'Check this',
      is_outdated: false,
      created_at: '2026-05-28T00:00:00.000Z',
      updated_at: '2026-05-28T00:00:00.000Z'
    }
    const data = {
      worktree_id: 'worktree-1',
      file_path: 'src/app.ts',
      line_start: 12,
      line_end: null,
      anchor_text: 'const value = 1',
      anchor_context_before: null,
      anchor_context_after: null,
      body: 'Check this'
    }
    const request = vi.fn().mockResolvedValue(comment)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.diffComment.create(data)).resolves.toBe(comment)
    expect(request).toHaveBeenCalledWith('db.diffComment.create', data)
  })

  it('routes diffComment.update through the renderer RPC client', async () => {
    const comment = {
      id: 'comment-1',
      worktree_id: 'worktree-1',
      file_path: 'src/app.ts',
      line_start: 14,
      line_end: null,
      anchor_text: 'const value = 2',
      anchor_context_before: null,
      anchor_context_after: null,
      body: 'Updated',
      is_outdated: true,
      created_at: '2026-05-28T00:00:00.000Z',
      updated_at: '2026-05-28T00:00:01.000Z'
    }
    const data = {
      body: 'Updated',
      line_start: 14,
      line_end: null,
      is_outdated: true
    }
    const request = vi.fn().mockResolvedValue(comment)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.diffComment.update('comment-1', data)).resolves.toBe(comment)
    expect(request).toHaveBeenCalledWith('db.diffComment.update', { id: 'comment-1', data })
  })

  it('routes diffComment.delete through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.diffComment.delete('comment-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.diffComment.delete', { id: 'comment-1' })
  })

  it('routes diffComment.clearAll through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(2)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.diffComment.clearAll('worktree-1')).resolves.toBe(2)
    expect(request).toHaveBeenCalledWith('db.diffComment.clearAll', { worktreeId: 'worktree-1' })
  })

  it('routes diffComment.list through the renderer RPC client', async () => {
    const comments = [
      {
        id: 'comment-1',
        worktree_id: 'worktree-1',
        file_path: 'src/app.ts',
        line_start: 12,
        line_end: null,
        anchor_text: null,
        anchor_context_before: null,
        anchor_context_after: null,
        body: 'Check this',
        is_outdated: false,
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z'
      }
    ]
    const request = vi.fn().mockResolvedValue(comments)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.diffComment.list('worktree-1')).resolves.toBe(comments)
    expect(request).toHaveBeenCalledWith('db.diffComment.list', { worktreeId: 'worktree-1' })
  })

  it('routes project.get through the renderer RPC client', async () => {
    const project = {
      id: 'project-1',
      name: 'Hive',
      path: '/tmp/hive',
      description: null,
      tags: null,
      language: null,
      custom_icon: null,
      detected_icon: null,
      setup_script: null,
      run_script: null,
      archive_script: null,
      auto_assign_port: false,
      sort_order: 0,
      created_at: '2026-05-28T00:00:00.000Z',
      last_accessed_at: '2026-05-28T00:00:00.000Z'
    }
    const request = vi.fn().mockResolvedValue(project)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.project.get('project-1')).resolves.toBe(project)
    expect(request).toHaveBeenCalledWith('db.project.get', { id: 'project-1' })
  })

  it('routes project.getByPath through the renderer RPC client', async () => {
    const project = {
      id: 'project-1',
      name: 'Hive',
      path: '/tmp/hive',
      description: null,
      tags: null,
      language: null,
      custom_icon: null,
      detected_icon: null,
      setup_script: null,
      run_script: null,
      archive_script: null,
      auto_assign_port: false,
      sort_order: 0,
      created_at: '2026-05-28T00:00:00.000Z',
      last_accessed_at: '2026-05-28T00:00:00.000Z'
    }
    const request = vi.fn().mockResolvedValue(project)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.project.getByPath('/tmp/hive')).resolves.toBe(project)
    expect(request).toHaveBeenCalledWith('db.project.getByPath', { path: '/tmp/hive' })
  })

  it('routes project.create through the renderer RPC client', async () => {
    const project = {
      id: 'project-1',
      name: 'Hive',
      path: '/tmp/hive',
      description: null,
      tags: null,
      language: null,
      custom_icon: null,
      detected_icon: null,
      setup_script: null,
      run_script: null,
      archive_script: null,
      auto_assign_port: false,
      sort_order: 0,
      created_at: '2026-05-28T00:00:00.000Z',
      last_accessed_at: '2026-05-28T00:00:00.000Z'
    }
    const request = vi.fn().mockResolvedValue(project)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.project.create({ name: 'Hive', path: '/tmp/hive' })).resolves.toBe(project)
    expect(request).toHaveBeenCalledWith('db.project.create', {
      name: 'Hive',
      path: '/tmp/hive'
    })
  })

  it('routes project.update through the renderer RPC client', async () => {
    const project = {
      id: 'project-1',
      name: 'Hive',
      path: '/tmp/hive',
      description: null,
      tags: null,
      language: null,
      custom_icon: null,
      detected_icon: 'favicon.png',
      setup_script: null,
      run_script: null,
      archive_script: null,
      auto_assign_port: false,
      sort_order: 0,
      created_at: '2026-05-28T00:00:00.000Z',
      last_accessed_at: '2026-05-28T00:00:00.000Z'
    }
    const request = vi.fn().mockResolvedValue(project)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.project.update('project-1', { detected_icon: 'favicon.png' })).resolves.toBe(
      project
    )
    expect(request).toHaveBeenCalledWith('db.project.update', {
      id: 'project-1',
      data: { detected_icon: 'favicon.png' }
    })
  })

  it('routes project.delete through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.project.delete('project-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.project.delete', { id: 'project-1' })
  })

  it('routes project.touch through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.project.touch('project-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.project.touch', { id: 'project-1' })
  })

  it('routes project.getAll through the renderer RPC client', async () => {
    const projects = [
      {
        id: 'project-1',
        name: 'Hive',
        path: '/tmp/hive',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        detected_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        auto_assign_port: false,
        sort_order: 0,
        created_at: '2026-05-28T00:00:00.000Z',
        last_accessed_at: '2026-05-28T00:00:00.000Z'
      }
    ]
    const request = vi.fn().mockResolvedValue(projects)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.project.getAll()).resolves.toBe(projects)
    expect(request).toHaveBeenCalledWith('db.project.getAll', {})
  })

  it('routes project.reorder through the renderer RPC client', async () => {
    const orderedIds = ['project-2', 'project-1']
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.project.reorder(orderedIds)).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.project.reorder', { orderedIds })
  })

  it('routes project.sortByLastMessage through the renderer RPC client', async () => {
    const orderedIds = ['project-2', 'project-1']
    const request = vi.fn().mockResolvedValue(orderedIds)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.project.sortByLastMessage()).resolves.toBe(orderedIds)
    expect(request).toHaveBeenCalledWith('db.project.sortByLastMessage', {})
  })

  it('routes space.list through the renderer RPC client', async () => {
    const spaces = [
      {
        id: 'space-1',
        name: 'Core',
        icon_type: 'emoji',
        icon_value: 'C',
        sort_order: 0,
        created_at: '2026-05-28T00:00:00.000Z'
      }
    ]
    const request = vi.fn().mockResolvedValue(spaces)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.space.list()).resolves.toBe(spaces)
    expect(request).toHaveBeenCalledWith('db.space.list')
  })

  it('routes space.create through the renderer RPC client', async () => {
    const space = {
      id: 'space-1',
      name: 'Planning',
      icon_type: 'lucide',
      icon_value: 'Calendar',
      sort_order: 0,
      created_at: '2026-05-28T00:00:00.000Z'
    }
    const request = vi.fn().mockResolvedValue(space)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      dbApi.space.create({
        name: 'Planning',
        icon_type: 'lucide',
        icon_value: 'Calendar'
      })
    ).resolves.toBe(space)
    expect(request).toHaveBeenCalledWith('db.space.create', {
      name: 'Planning',
      icon_type: 'lucide',
      icon_value: 'Calendar'
    })
  })

  it('routes space.update through the renderer RPC client', async () => {
    const space = {
      id: 'space-1',
      name: 'Delivery',
      icon_type: 'lucide',
      icon_value: 'Rocket',
      sort_order: 2,
      created_at: '2026-05-28T00:00:00.000Z'
    }
    const request = vi.fn().mockResolvedValue(space)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      dbApi.space.update('space-1', {
        name: 'Delivery',
        icon_type: 'lucide',
        icon_value: 'Rocket',
        sort_order: 2
      })
    ).resolves.toBe(space)
    expect(request).toHaveBeenCalledWith('db.space.update', {
      id: 'space-1',
      data: {
        name: 'Delivery',
        icon_type: 'lucide',
        icon_value: 'Rocket',
        sort_order: 2
      }
    })
  })

  it('routes space.delete through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.space.delete('space-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.space.delete', { id: 'space-1' })
  })

  it('routes space.assignProject through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.space.assignProject('project-1', 'space-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.space.assignProject', {
      projectId: 'project-1',
      spaceId: 'space-1'
    })
  })

  it('routes space.removeProject through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.space.removeProject('project-1', 'space-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.space.removeProject', {
      projectId: 'project-1',
      spaceId: 'space-1'
    })
  })

  it('routes space.reorder through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.space.reorder(['space-2', 'space-1'])).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.space.reorder', {
      orderedIds: ['space-2', 'space-1']
    })
  })

  it('routes space.getAllAssignments through the renderer RPC client', async () => {
    const assignments = [
      {
        project_id: 'project-1',
        space_id: 'space-1'
      }
    ]
    const request = vi.fn().mockResolvedValue(assignments)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.space.getAllAssignments()).resolves.toBe(assignments)
    expect(request).toHaveBeenCalledWith('db.space.getAllAssignments')
  })

  it('routes setting.get through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('glass-dark')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.get('selected_theme')).resolves.toBe('glass-dark')
    expect(request).toHaveBeenCalledWith('db.setting.get', { key: 'selected_theme' })
  })

  it('routes setting.get for seen tips through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('["provider-right-click"]')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.get('seen_tips')).resolves.toBe('["provider-right-click"]')
    expect(request).toHaveBeenCalledWith('db.setting.get', { key: 'seen_tips' })
  })

  it('routes setting.get for app settings through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('{"editor":"vscode"}')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.get('app_settings')).resolves.toBe('{"editor":"vscode"}')
    expect(request).toHaveBeenCalledWith('db.setting.get', { key: 'app_settings' })
  })

  it('routes setting.get for keyboard shortcuts through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('{"new-session":{"key":"n"}}')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.get('keyboard_shortcuts')).resolves.toBe(
      '{"new-session":{"key":"n"}}'
    )
    expect(request).toHaveBeenCalledWith('db.setting.get', { key: 'keyboard_shortcuts' })
  })

  it('routes setting.get for provider settings through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('{"github":"token"}')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.get('provider_settings')).resolves.toBe('{"github":"token"}')
    expect(request).toHaveBeenCalledWith('db.setting.get', { key: 'provider_settings' })
  })

  it('routes setting.set through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.set('selected_theme', 'glass-light')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.setting.set', {
      key: 'selected_theme',
      value: 'glass-light'
    })
  })

  it('routes setting.set for seen tips through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.set('seen_tips', '["provider-right-click"]')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.setting.set', {
      key: 'seen_tips',
      value: '["provider-right-click"]'
    })
  })

  it('routes setting.set for app settings through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.set('app_settings', '{"defaultEditor":"vscode"}')).resolves.toBe(
      true
    )
    expect(request).toHaveBeenCalledWith('db.setting.set', {
      key: 'app_settings',
      value: '{"defaultEditor":"vscode"}'
    })
  })

  it('routes setting.set for keyboard shortcuts through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      dbApi.setting.set('keyboard_shortcuts', '{"new-session":{"key":"n"}}')
    ).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.setting.set', {
      key: 'keyboard_shortcuts',
      value: '{"new-session":{"key":"n"}}'
    })
  })

  it('routes setting.set for provider settings through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.set('provider_settings', '{"github":"token"}')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.setting.set', {
      key: 'provider_settings',
      value: '{"github":"token"}'
    })
  })

  it('routes setting.delete through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.delete('selected_theme')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.setting.delete', { key: 'selected_theme' })
  })

  it('routes setting.getAll through the renderer RPC client', async () => {
    const rows = [
      { key: 'selected_theme', value: 'glass-light' },
      { key: 'app_settings', value: '{"defaultEditor":"vscode"}' }
    ]
    const request = vi.fn().mockResolvedValue(rows)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.setting.getAll()).resolves.toBe(rows)
    expect(request).toHaveBeenCalledWith('db.setting.getAll', {})
  })

  it('routes session.get through the renderer RPC client', async () => {
    const session = {
      id: 'session-1',
      project_id: 'project-1',
      opencode_session_id: 'oc-1'
    }
    const request = vi.fn().mockResolvedValue(session)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.get('session-1')).resolves.toBe(session)
    expect(request).toHaveBeenCalledWith('db.session.get', { id: 'session-1' })
  })

  it('routes session.create through the renderer RPC client', async () => {
    const session = {
      id: 'session-1',
      worktree_id: 'worktree-1',
      project_id: 'project-1',
      connection_id: null,
      name: 'Session 1',
      status: 'active',
      opencode_session_id: null,
      claude_session_id: null,
      agent_sdk: 'opencode',
      mode: 'build',
      session_type: 'default',
      model_provider_id: 'openai',
      model_id: 'gpt-5',
      model_variant: null,
      created_at: '2026-05-28T00:00:00.000Z',
      updated_at: '2026-05-28T00:00:00.000Z',
      completed_at: null
    }
    const data = {
      worktree_id: 'worktree-1',
      project_id: 'project-1',
      name: 'Session 1',
      agent_sdk: 'opencode' as const,
      mode: 'build' as const,
      model_provider_id: 'openai',
      model_id: 'gpt-5',
      model_variant: null
    }
    const request = vi.fn().mockResolvedValue(session)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.create(data)).resolves.toBe(session)
    expect(request).toHaveBeenCalledWith('db.session.create', data)
  })

  it('routes session.update through the renderer RPC client', async () => {
    const session = {
      id: 'session-1',
      worktree_id: 'worktree-1',
      project_id: 'project-1',
      connection_id: null,
      name: 'Session 1',
      status: 'completed',
      opencode_session_id: null,
      claude_session_id: null,
      agent_sdk: 'opencode',
      mode: 'build',
      session_type: 'default',
      model_provider_id: null,
      model_id: null,
      model_variant: null,
      created_at: '2026-05-28T00:00:00.000Z',
      updated_at: '2026-05-28T00:00:01.000Z',
      completed_at: '2026-05-28T00:00:01.000Z'
    }
    const data = {
      status: 'completed' as const,
      completed_at: '2026-05-28T00:00:01.000Z'
    }
    const request = vi.fn().mockResolvedValue(session)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.update('session-1', data)).resolves.toBe(session)
    expect(request).toHaveBeenCalledWith('db.session.update', { id: 'session-1', data })
  })

  it('routes session.delete through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.delete('session-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('db.session.delete', { id: 'session-1' })
  })

  it('routes session.updateDraft through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.updateDraft('session-1', 'Draft body')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('db.session.updateDraft', {
      sessionId: 'session-1',
      draft: 'Draft body'
    })
  })

  it('routes session.getDraft through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('Draft body')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.getDraft('session-1')).resolves.toBe('Draft body')
    expect(request).toHaveBeenCalledWith('db.session.getDraft', {
      sessionId: 'session-1'
    })
  })

  it('routes session.getActiveByWorktree through the renderer RPC client', async () => {
    const sessions = [
      {
        id: 'session-1',
        worktree_id: 'worktree-1',
        project_id: 'project-1',
        connection_id: null,
        name: 'Build login',
        status: 'active',
        opencode_session_id: null,
        claude_session_id: null,
        agent_sdk: 'opencode',
        mode: 'build',
        session_type: 'default',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z',
        completed_at: null
      }
    ]
    const request = vi.fn().mockResolvedValue(sessions)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.getActiveByWorktree('worktree-1')).resolves.toBe(sessions)
    expect(request).toHaveBeenCalledWith('db.session.getActiveByWorktree', {
      worktreeId: 'worktree-1'
    })
  })

  it('routes session.getActiveByConnection through the renderer RPC client', async () => {
    const sessions = [
      {
        id: 'session-1',
        worktree_id: null,
        project_id: 'project-1',
        connection_id: 'connection-1',
        name: 'Connection build',
        status: 'active',
        opencode_session_id: null,
        claude_session_id: null,
        agent_sdk: 'opencode',
        mode: 'build',
        session_type: 'default',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z',
        completed_at: null
      }
    ]
    const request = vi.fn().mockResolvedValue(sessions)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.getActiveByConnection('connection-1')).resolves.toBe(sessions)
    expect(request).toHaveBeenCalledWith('db.session.getActiveByConnection', {
      connectionId: 'connection-1'
    })
  })

  it('routes session.getActiveBoardAssistant through the renderer RPC client', async () => {
    const session = {
      id: 'session-1',
      worktree_id: null,
      project_id: 'project-1',
      connection_id: null,
      name: '[Board Assistant] Project',
      status: 'active',
      opencode_session_id: null,
      claude_session_id: null,
      agent_sdk: 'opencode',
      mode: 'build',
      session_type: 'board-assistant',
      model_provider_id: null,
      model_id: null,
      model_variant: null,
      created_at: '2026-05-28T00:00:00.000Z',
      updated_at: '2026-05-28T00:00:00.000Z',
      completed_at: null
    }
    const request = vi.fn().mockResolvedValue(session)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.getActiveBoardAssistant('project-1')).resolves.toBe(session)
    expect(request).toHaveBeenCalledWith('db.session.getActiveBoardAssistant', {
      projectId: 'project-1'
    })
  })

  it('routes session.getPinnedSessions through the renderer RPC client', async () => {
    const sessions = [
      {
        id: 'session-1',
        worktree_id: 'worktree-1',
        project_id: 'project-1',
        connection_id: null,
        name: 'Pinned build',
        status: 'active',
        opencode_session_id: null,
        claude_session_id: null,
        agent_sdk: 'opencode',
        mode: 'build',
        session_type: 'default',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z',
        completed_at: null
      }
    ]
    const request = vi.fn().mockResolvedValue(sessions)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.getPinnedSessions('worktree-1')).resolves.toBe(sessions)
    expect(request).toHaveBeenCalledWith('db.session.getPinnedSessions', {
      worktreeId: 'worktree-1'
    })
  })

  it('routes session.setPinnedToBoard through the renderer RPC client', async () => {
    const session = {
      id: 'session-1',
      worktree_id: 'worktree-1',
      project_id: 'project-1',
      connection_id: null,
      name: 'Pinned build',
      status: 'active',
      opencode_session_id: null,
      claude_session_id: null,
      agent_sdk: 'opencode',
      mode: 'build',
      session_type: 'default',
      model_provider_id: null,
      model_id: null,
      model_variant: null,
      pinned_to_board: true,
      created_at: '2026-05-28T00:00:00.000Z',
      updated_at: '2026-05-28T00:00:00.000Z',
      completed_at: null
    }
    const request = vi.fn().mockResolvedValue(session)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.session.setPinnedToBoard('session-1', true)).resolves.toBe(session)
    expect(request).toHaveBeenCalledWith('db.session.setPinnedToBoard', {
      sessionId: 'session-1',
      pinned: true
    })
  })

  it('routes session.search through the renderer RPC client', async () => {
    const result = [
      {
        id: 'session-1',
        worktree_id: 'worktree-1',
        project_id: 'project-1',
        connection_id: null,
        name: 'Build login',
        status: 'active',
        opencode_session_id: null,
        claude_session_id: null,
        agent_sdk: 'opencode',
        mode: 'build',
        session_type: 'default',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z',
        completed_at: null,
        project_name: 'Hive'
      }
    ]
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      dbApi.session.search({
        keyword: 'login',
        project_id: 'project-1',
        includeArchived: false
      })
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('db.session.search', {
      keyword: 'login',
      project_id: 'project-1',
      includeArchived: false
    })
  })

  it('routes sessionMessage.list through the renderer RPC client', async () => {
    const messages = [
      {
        id: 'message-1',
        session_id: 'session-1',
        role: 'user',
        text: 'Build this',
        created_at: '2026-05-28T00:00:00.000Z'
      }
    ]
    const request = vi.fn().mockResolvedValue(messages)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.sessionMessage.list('session-1')).resolves.toBe(messages)
    expect(request).toHaveBeenCalledWith('db.sessionMessage.list', {
      sessionId: 'session-1'
    })
  })

  it('routes sessionActivity.list through the renderer RPC client', async () => {
    const activities = [
      {
        id: 'activity-1',
        session_id: 'session-1',
        agent_session_id: 'agent-session-1',
        thread_id: null,
        turn_id: null,
        item_id: null,
        request_id: null,
        kind: 'session.info',
        tone: 'info',
        summary: 'Loaded context',
        payload_json: null,
        sequence: 1,
        created_at: '2026-05-28T00:00:00.000Z'
      }
    ]
    const request = vi.fn().mockResolvedValue(activities)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.sessionActivity.list('session-1')).resolves.toBe(activities)
    expect(request).toHaveBeenCalledWith('db.sessionActivity.list', {
      sessionId: 'session-1'
    })
  })

  it('routes worktree.get through the renderer RPC client', async () => {
    const worktree = {
      id: 'worktree-1',
      project_id: 'project-1',
      name: 'main',
      branch_name: 'main',
      path: '/tmp/hive',
      status: 'active',
      is_default: true,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      created_at: '2026-05-28T00:00:00.000Z',
      last_accessed_at: '2026-05-28T00:00:00.000Z'
    }
    const request = vi.fn().mockResolvedValue(worktree)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.get('worktree-1')).resolves.toBe(worktree)
    expect(request).toHaveBeenCalledWith('db.worktree.get', { id: 'worktree-1' })
  })

  it('routes worktree.update through the renderer RPC client', async () => {
    const worktree = {
      id: 'worktree-1',
      project_id: 'project-1',
      name: 'main',
      branch_name: 'main',
      path: '/tmp/hive',
      status: 'active',
      is_default: true,
      branch_renamed: 0,
      last_message_at: 1779920400000,
      session_titles: '',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      created_at: '2026-05-28T00:00:00.000Z',
      last_accessed_at: '2026-05-28T00:00:00.000Z'
    }
    const update = { last_message_at: 1779920400000 }
    const request = vi.fn().mockResolvedValue(worktree)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.update('worktree-1', update)).resolves.toBe(worktree)
    expect(request).toHaveBeenCalledWith('db.worktree.update', {
      id: 'worktree-1',
      data: update
    })
  })

  it('routes worktree.getActiveByProject through the renderer RPC client', async () => {
    const worktrees = [
      {
        id: 'worktree-1',
        project_id: 'project-1',
        name: 'main',
        branch_name: 'main',
        path: '/tmp/hive',
        status: 'active',
        is_default: true,
        branch_renamed: 0,
        last_message_at: null,
        session_titles: '[]',
        last_model_provider_id: null,
        last_model_id: null,
        last_model_variant: null,
        created_at: '2026-05-28T00:00:00.000Z',
        last_accessed_at: '2026-05-28T00:00:00.000Z'
      }
    ]
    const request = vi.fn().mockResolvedValue(worktrees)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.getActiveByProject('project-1')).resolves.toBe(worktrees)
    expect(request).toHaveBeenCalledWith('db.worktree.getActiveByProject', {
      projectId: 'project-1'
    })
  })

  it('routes worktree.getPinned through the renderer RPC client', async () => {
    const worktrees = [
      {
        id: 'worktree-1',
        project_id: 'project-1',
        name: 'main',
        branch_name: 'main',
        path: '/tmp/hive',
        status: 'active',
        is_default: true,
        branch_renamed: 0,
        last_message_at: null,
        session_titles: '[]',
        last_model_provider_id: null,
        last_model_id: null,
        last_model_variant: null,
        created_at: '2026-05-28T00:00:00.000Z',
        last_accessed_at: '2026-05-28T00:00:00.000Z'
      }
    ]
    const request = vi.fn().mockResolvedValue(worktrees)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.getPinned()).resolves.toBe(worktrees)
    expect(request).toHaveBeenCalledWith('db.worktree.getPinned', {})
  })

  it('routes worktree.updateModel through the renderer RPC client', async () => {
    const params = {
      worktreeId: 'worktree-1',
      modelProviderId: 'anthropic',
      modelId: 'claude-sonnet-4',
      modelVariant: null
    }
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.updateModel(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('db.worktree.updateModel', params)
  })

  it('routes worktree.removeAttachment through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.removeAttachment('worktree-1', 'attachment-1')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('db.worktree.removeAttachment', {
      worktreeId: 'worktree-1',
      attachmentId: 'attachment-1'
    })
  })

  it('routes worktree.addAttachment through the renderer RPC client', async () => {
    const attachment = {
      type: 'jira' as const,
      url: 'https://example.atlassian.net/browse/HIVE-123',
      label: 'HIVE-123'
    }
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.addAttachment('worktree-1', attachment)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('db.worktree.addAttachment', {
      worktreeId: 'worktree-1',
      attachment
    })
  })

  it('routes worktree.setPinned through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.setPinned('worktree-1', true)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('db.worktree.setPinned', {
      worktreeId: 'worktree-1',
      pinned: true
    })
  })

  it('routes worktree.setPinned false through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.setPinned('worktree-1', false)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('db.worktree.setPinned', {
      worktreeId: 'worktree-1',
      pinned: false
    })
  })

  it('routes worktree.touch through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.touch('worktree-1')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('db.worktree.touch', { id: 'worktree-1' })
  })

  it('routes worktree.appendSessionTitle through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      dbApi.worktree.appendSessionTitle('worktree-1', 'Implement RPC migration')
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('db.worktree.appendSessionTitle', {
      worktreeId: 'worktree-1',
      title: 'Implement RPC migration'
    })
  })

  it('routes worktree.attachPR through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      dbApi.worktree.attachPR('worktree-1', 42, 'https://github.com/acme/hive/pull/42')
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('db.worktree.attachPR', {
      worktreeId: 'worktree-1',
      prNumber: 42,
      prUrl: 'https://github.com/acme/hive/pull/42'
    })
  })

  it('routes worktree.detachPR through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.detachPR('worktree-1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('db.worktree.detachPR', {
      worktreeId: 'worktree-1'
    })
  })

  it('routes worktree.getRecentlyActive through the renderer RPC client', async () => {
    const worktrees = [
      {
        id: 'worktree-1',
        project_id: 'project-1',
        name: 'main',
        branch_name: 'main',
        path: '/tmp/hive',
        status: 'active',
        is_default: true,
        branch_renamed: 0,
        last_message_at: Date.UTC(2026, 4, 28),
        session_titles: '',
        last_model_provider_id: null,
        last_model_id: null,
        last_model_variant: null,
        created_at: '2026-05-28T00:00:00.000Z',
        last_accessed_at: '2026-05-28T00:00:00.000Z'
      }
    ]
    const request = vi.fn().mockResolvedValue(worktrees)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.getRecentlyActive(1234)).resolves.toBe(worktrees)
    expect(request).toHaveBeenCalledWith('db.worktree.getRecentlyActive', { cutoffMs: 1234 })
  })

  it('rejects when the renderer RPC client has not been initialized', async () => {
    await expect(dbApi.setting.get('selected_theme')).rejects.toThrow(
      'Renderer RPC client has not been initialized'
    )
  })
})
