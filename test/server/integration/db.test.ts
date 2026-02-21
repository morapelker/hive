import { describe, it, expect, beforeEach, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { MockDatabaseService } from '../helpers/mock-db'
import { createTestServer } from '../helpers/test-server'

// Mock Electron's app module — resolver chain imports logger which calls app.getPath at load time
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return homedir()
      if (name === 'userData') return join(homedir(), '.hive')
      if (name === 'logs') return join(homedir(), '.hive', 'logs')
      return '/tmp'
    },
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/tmp/hive-test-app'
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn()
}))

describe('DB Resolvers — Integration Tests', () => {
  let db: MockDatabaseService
  let execute: (
    query: string,
    variables?: Record<string, unknown>
  ) => Promise<{ data?: any; errors?: any[] }> // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeEach(() => {
    db = new MockDatabaseService()
    const server = createTestServer(db)
    execute = server.execute
  })

  // =========================================================================
  // Projects
  // =========================================================================
  describe('Projects', () => {
    it('creates a project and queries it back', async () => {
      const { data } = await execute(`
        mutation {
          createProject(input: { name: "TestProject", path: "/tmp/test" }) {
            id name path description
          }
        }
      `)
      expect(data.createProject).toMatchObject({
        name: 'TestProject',
        path: '/tmp/test',
        description: null
      })
      expect(data.createProject.id).toBeTruthy()

      // Query all
      const { data: allData } = await execute(`{ projects { id name } }`)
      expect(allData.projects).toHaveLength(1)
      expect(allData.projects[0].name).toBe('TestProject')
    })

    it('queries project by id', async () => {
      const { data: created } = await execute(`
        mutation { createProject(input: { name: "P1", path: "/p1" }) { id } }
      `)
      const id = created.createProject.id

      const { data } = await execute(
        `query($id: ID!) { project(id: $id) { id name path } }`,
        { id }
      )
      expect(data.project).toMatchObject({ id, name: 'P1', path: '/p1' })
    })

    it('queries project by path', async () => {
      await execute(`
        mutation { createProject(input: { name: "P1", path: "/unique/path" }) { id } }
      `)

      const { data } = await execute(
        `query { projectByPath(path: "/unique/path") { name } }`
      )
      expect(data.projectByPath.name).toBe('P1')
    })

    it('updates a project', async () => {
      const { data: created } = await execute(`
        mutation { createProject(input: { name: "Old", path: "/p" }) { id } }
      `)
      const id = created.createProject.id

      const { data } = await execute(
        `mutation($id: ID!, $input: UpdateProjectInput!) {
          updateProject(id: $id, input: $input) { id name description }
        }`,
        { id, input: { name: 'New', description: 'updated desc' } }
      )
      expect(data.updateProject).toMatchObject({
        id,
        name: 'New',
        description: 'updated desc'
      })
    })

    it('deletes a project', async () => {
      const { data: created } = await execute(`
        mutation { createProject(input: { name: "Gone", path: "/g" }) { id } }
      `)
      const id = created.createProject.id

      const { data } = await execute(
        `mutation($id: ID!) { deleteProject(id: $id) }`,
        { id }
      )
      expect(data.deleteProject).toBe(true)

      const { data: after } = await execute(`{ projects { id } }`)
      expect(after.projects).toHaveLength(0)
    })

    it('touches a project', async () => {
      const { data: created } = await execute(`
        mutation { createProject(input: { name: "T", path: "/t" }) { id } }
      `)
      const id = created.createProject.id

      const { data } = await execute(
        `mutation($id: ID!) { touchProject(id: $id) }`,
        { id }
      )
      expect(data.touchProject).toBe(true)
    })

    it('reorders projects', async () => {
      const { data: p1 } = await execute(`
        mutation { createProject(input: { name: "A", path: "/a" }) { id } }
      `)
      const { data: p2 } = await execute(`
        mutation { createProject(input: { name: "B", path: "/b" }) { id } }
      `)

      const { data } = await execute(
        `mutation($ids: [ID!]!) { reorderProjects(orderedIds: $ids) }`,
        { ids: [p2.createProject.id, p1.createProject.id] }
      )
      expect(data.reorderProjects).toBe(true)
    })

    it('rejects duplicate project path', async () => {
      await execute(`
        mutation { createProject(input: { name: "First", path: "/tmp/dup-path" }) { id } }
      `)

      const { data, errors } = await execute(`
        mutation { createProject(input: { name: "Second", path: "/tmp/dup-path" }) { id } }
      `)

      // The UNIQUE constraint on path causes the second insert to fail
      expect(errors).toBeDefined()
      expect(data?.createProject ?? null).toBeNull()
    })
  })

  // =========================================================================
  // Worktrees
  // =========================================================================
  describe('Worktrees', () => {
    let projectId: string

    beforeEach(async () => {
      // Create a project to attach worktrees to
      const { data } = await execute(`
        mutation { createProject(input: { name: "WtProject", path: "/wt" }) { id } }
      `)
      projectId = data.createProject.id

      // Seed a worktree directly in mock DB (worktree creation via resolver
      // is a git operation in Phase 5, not simple DB CRUD)
      db.createWorktree({
        project_id: projectId,
        name: 'main',
        branch_name: 'main',
        path: '/wt/main',
        is_default: true
      })
    })

    it('queries worktree by id', async () => {
      const wt = db.worktrees[0]
      const { data } = await execute(
        `query($id: ID!) { worktree(id: $id) { id name branchName projectId isDefault } }`,
        { id: wt.id }
      )
      expect(data.worktree).toMatchObject({
        id: wt.id,
        name: 'main',
        branchName: 'main',
        projectId,
        isDefault: true
      })
    })

    it('queries worktrees by project', async () => {
      db.createWorktree({
        project_id: projectId,
        name: 'feature',
        branch_name: 'feature/x',
        path: '/wt/feature'
      })

      const { data } = await execute(
        `query($pid: ID!) { worktreesByProject(projectId: $pid) { name } }`,
        { pid: projectId }
      )
      expect(data.worktreesByProject).toHaveLength(2)
    })

    it('queries active worktrees by project', async () => {
      db.createWorktree({
        project_id: projectId,
        name: 'archived-wt',
        branch_name: 'old',
        path: '/wt/old'
      })
      db.archiveWorktree(db.worktrees[1].id)

      const { data } = await execute(
        `query($pid: ID!) { activeWorktreesByProject(projectId: $pid) { name status } }`,
        { pid: projectId }
      )
      expect(data.activeWorktreesByProject).toHaveLength(1)
      expect(data.activeWorktreesByProject[0].status).toBe('active')
    })

    it('updates a worktree', async () => {
      const wt = db.worktrees[0]
      const { data } = await execute(
        `mutation($id: ID!, $input: UpdateWorktreeInput!) {
          updateWorktree(id: $id, input: $input) { name }
        }`,
        { id: wt.id, input: { name: 'renamed' } }
      )
      expect(data.updateWorktree.name).toBe('renamed')
    })

    it('archives a worktree', async () => {
      const wt = db.worktrees[0]
      const { data } = await execute(
        `mutation($id: ID!) { archiveWorktree(id: $id) { id status } }`,
        { id: wt.id }
      )
      expect(data.archiveWorktree.status).toBe('archived')
    })

    it('touches a worktree', async () => {
      const wt = db.worktrees[0]
      const { data } = await execute(
        `mutation($id: ID!) { touchWorktree(id: $id) }`,
        { id: wt.id }
      )
      expect(data.touchWorktree).toBe(true)
    })

    it('appends worktree session title', async () => {
      const wt = db.worktrees[0]
      const { data } = await execute(
        `mutation($wtId: ID!, $title: String!) {
          appendWorktreeSessionTitle(worktreeId: $wtId, title: $title) { success }
        }`,
        { wtId: wt.id, title: 'Session A' }
      )
      expect(data.appendWorktreeSessionTitle.success).toBe(true)
      expect(JSON.parse(db.worktrees[0].session_titles)).toContain('Session A')
    })

    it('updates worktree model', async () => {
      const wt = db.worktrees[0]
      const { data } = await execute(
        `mutation($input: UpdateWorktreeModelInput!) {
          updateWorktreeModel(input: $input) { success }
        }`,
        {
          input: {
            worktreeId: wt.id,
            modelProviderId: 'anthropic',
            modelId: 'claude-4',
            modelVariant: 'opus'
          }
        }
      )
      expect(data.updateWorktreeModel.success).toBe(true)
      expect(db.worktrees[0].last_model_id).toBe('claude-4')
    })
  })

  // =========================================================================
  // Sessions
  // =========================================================================
  describe('Sessions', () => {
    let projectId: string
    let worktreeId: string

    beforeEach(async () => {
      const { data } = await execute(`
        mutation { createProject(input: { name: "SP", path: "/sp" }) { id } }
      `)
      projectId = data.createProject.id

      const wt = db.createWorktree({
        project_id: projectId,
        name: 'main',
        branch_name: 'main',
        path: '/sp/main'
      })
      worktreeId = wt.id
    })

    it('creates and queries a session', async () => {
      const { data: created } = await execute(
        `mutation($input: CreateSessionInput!) {
          createSession(input: $input) { id name projectId worktreeId agentSdk status mode }
        }`,
        {
          input: {
            projectId,
            worktreeId,
            name: 'Test Session',
            agentSdk: 'opencode'
          }
        }
      )
      expect(created.createSession).toMatchObject({
        name: 'Test Session',
        projectId,
        worktreeId,
        agentSdk: 'opencode',
        status: 'active',
        mode: 'build'
      })

      const { data: queried } = await execute(
        `query($id: ID!) { session(id: $id) { id name } }`,
        { id: created.createSession.id }
      )
      expect(queried.session.name).toBe('Test Session')
    })

    it('creates session with claude_code agent SDK', async () => {
      const { data } = await execute(
        `mutation($input: CreateSessionInput!) {
          createSession(input: $input) { agentSdk }
        }`,
        { input: { projectId, agentSdk: 'claude_code' } }
      )
      // Resolver maps claude_code -> claude-code in DB, then back to claude_code in output
      expect(data.createSession.agentSdk).toBe('claude_code')
    })

    it('queries sessions by worktree', async () => {
      await execute(
        `mutation { createSession(input: { projectId: "${projectId}", worktreeId: "${worktreeId}", name: "S1" }) { id } }`
      )
      await execute(
        `mutation { createSession(input: { projectId: "${projectId}", worktreeId: "${worktreeId}", name: "S2" }) { id } }`
      )

      const { data } = await execute(
        `query($wtId: ID!) { sessionsByWorktree(worktreeId: $wtId) { name } }`,
        { wtId: worktreeId }
      )
      expect(data.sessionsByWorktree).toHaveLength(2)
    })

    it('queries active sessions by worktree', async () => {
      const { data: s1 } = await execute(
        `mutation { createSession(input: { projectId: "${projectId}", worktreeId: "${worktreeId}" }) { id } }`
      )
      await execute(
        `mutation { createSession(input: { projectId: "${projectId}", worktreeId: "${worktreeId}" }) { id } }`
      )
      // Complete one
      await execute(
        `mutation($id: ID!, $input: UpdateSessionInput!) {
          updateSession(id: $id, input: $input) { id }
        }`,
        { id: s1.createSession.id, input: { status: 'completed' } }
      )

      const { data } = await execute(
        `query($wtId: ID!) { activeSessionsByWorktree(worktreeId: $wtId) { id } }`,
        { wtId: worktreeId }
      )
      expect(data.activeSessionsByWorktree).toHaveLength(1)
    })

    it('queries sessions by project', async () => {
      await execute(
        `mutation { createSession(input: { projectId: "${projectId}" }) { id } }`
      )

      const { data } = await execute(
        `query($pid: ID!) { sessionsByProject(projectId: $pid) { id } }`,
        { pid: projectId }
      )
      expect(data.sessionsByProject).toHaveLength(1)
    })

    it('searches sessions', async () => {
      await execute(
        `mutation { createSession(input: { projectId: "${projectId}", worktreeId: "${worktreeId}", name: "feature work" }) { id } }`
      )
      await execute(
        `mutation { createSession(input: { projectId: "${projectId}", worktreeId: "${worktreeId}", name: "bug fix" }) { id } }`
      )

      const { data } = await execute(
        `query($input: SessionSearchInput!) {
          searchSessions(input: $input) { name projectName worktreeName }
        }`,
        { input: { keyword: 'feature' } }
      )
      expect(data.searchSessions).toHaveLength(1)
      expect(data.searchSessions[0].name).toBe('feature work')
    })

    it('updates session draft', async () => {
      const { data: created } = await execute(
        `mutation { createSession(input: { projectId: "${projectId}" }) { id } }`
      )
      const sessionId = created.createSession.id

      await execute(
        `mutation($sid: ID!, $draft: String) {
          updateSessionDraft(sessionId: $sid, draft: $draft)
        }`,
        { sid: sessionId, draft: 'Hello world draft' }
      )

      const { data } = await execute(
        `query($sid: ID!) { sessionDraft(sessionId: $sid) }`,
        { sid: sessionId }
      )
      expect(data.sessionDraft).toBe('Hello world draft')
    })

    it('deletes a session', async () => {
      const { data: created } = await execute(
        `mutation { createSession(input: { projectId: "${projectId}" }) { id } }`
      )

      const { data } = await execute(
        `mutation($id: ID!) { deleteSession(id: $id) }`,
        { id: created.createSession.id }
      )
      expect(data.deleteSession).toBe(true)
      expect(db.sessions).toHaveLength(0)
    })

    it('queries sessions by connection', async () => {
      // Create sessions with a connection id directly
      db.createSession({
        project_id: projectId,
        connection_id: 'conn-1',
        agent_sdk: 'opencode'
      })
      db.createSession({
        project_id: projectId,
        connection_id: 'conn-1',
        agent_sdk: 'opencode'
      })
      db.createSession({
        project_id: projectId,
        connection_id: 'conn-2',
        agent_sdk: 'opencode'
      })

      const { data } = await execute(
        `query($cid: ID!) { sessionsByConnection(connectionId: $cid) { id } }`,
        { cid: 'conn-1' }
      )
      expect(data.sessionsByConnection).toHaveLength(2)
    })

    it('queries active sessions by connection', async () => {
      const s = db.createSession({
        project_id: projectId,
        connection_id: 'conn-1',
        agent_sdk: 'opencode'
      })
      db.createSession({
        project_id: projectId,
        connection_id: 'conn-1',
        agent_sdk: 'opencode'
      })
      db.updateSession(s.id, { status: 'completed' })

      const { data } = await execute(
        `query($cid: ID!) { activeSessionsByConnection(connectionId: $cid) { id } }`,
        { cid: 'conn-1' }
      )
      expect(data.activeSessionsByConnection).toHaveLength(1)
    })
  })

  // =========================================================================
  // Spaces
  // =========================================================================
  describe('Spaces', () => {
    it('creates and queries spaces', async () => {
      const { data: created } = await execute(`
        mutation {
          createSpace(input: { name: "Work", iconType: "emoji", iconValue: "briefcase" }) {
            id name iconType iconValue
          }
        }
      `)
      expect(created.createSpace).toMatchObject({
        name: 'Work',
        iconType: 'emoji',
        iconValue: 'briefcase'
      })

      const { data } = await execute(`{ spaces { id name } }`)
      expect(data.spaces).toHaveLength(1)
    })

    it('assigns and removes projects from spaces', async () => {
      const { data: p } = await execute(`
        mutation { createProject(input: { name: "SP", path: "/sp" }) { id } }
      `)
      const { data: s } = await execute(`
        mutation { createSpace(input: { name: "S" }) { id } }
      `)
      const projectId = p.createProject.id
      const spaceId = s.createSpace.id

      // Assign
      const { data: assigned } = await execute(
        `mutation($pid: ID!, $sid: ID!) { assignProjectToSpace(projectId: $pid, spaceId: $sid) }`,
        { pid: projectId, sid: spaceId }
      )
      expect(assigned.assignProjectToSpace).toBe(true)

      // Query assignments
      const { data: ids } = await execute(
        `query($sid: ID!) { spaceProjectIds(spaceId: $sid) }`,
        { sid: spaceId }
      )
      expect(ids.spaceProjectIds).toContain(projectId)

      // All assignments
      const { data: allAssign } = await execute(`
        { allSpaceAssignments { projectId spaceId } }
      `)
      expect(allAssign.allSpaceAssignments).toHaveLength(1)

      // Remove
      const { data: removed } = await execute(
        `mutation($pid: ID!, $sid: ID!) { removeProjectFromSpace(projectId: $pid, spaceId: $sid) }`,
        { pid: projectId, sid: spaceId }
      )
      expect(removed.removeProjectFromSpace).toBe(true)

      const { data: afterRemove } = await execute(
        `query($sid: ID!) { spaceProjectIds(spaceId: $sid) }`,
        { sid: spaceId }
      )
      expect(afterRemove.spaceProjectIds).toHaveLength(0)
    })

    it('updates a space', async () => {
      const { data: created } = await execute(`
        mutation { createSpace(input: { name: "Old" }) { id } }
      `)
      const id = created.createSpace.id

      const { data } = await execute(
        `mutation($id: ID!, $input: UpdateSpaceInput!) {
          updateSpace(id: $id, input: $input) { name }
        }`,
        { id, input: { name: 'New' } }
      )
      expect(data.updateSpace.name).toBe('New')
    })

    it('deletes a space', async () => {
      const { data: created } = await execute(`
        mutation { createSpace(input: { name: "Gone" }) { id } }
      `)

      const { data } = await execute(
        `mutation($id: ID!) { deleteSpace(id: $id) }`,
        { id: created.createSpace.id }
      )
      expect(data.deleteSpace).toBe(true)
      expect(db.spaces).toHaveLength(0)
    })

    it('reorders spaces', async () => {
      const { data: s1 } = await execute(`
        mutation { createSpace(input: { name: "A" }) { id } }
      `)
      const { data: s2 } = await execute(`
        mutation { createSpace(input: { name: "B" }) { id } }
      `)

      const { data } = await execute(
        `mutation($ids: [ID!]!) { reorderSpaces(orderedIds: $ids) }`,
        { ids: [s2.createSpace.id, s1.createSpace.id] }
      )
      expect(data.reorderSpaces).toBe(true)
    })
  })

  // =========================================================================
  // Settings
  // =========================================================================
  describe('Settings', () => {
    it('sets, gets, and deletes a setting', async () => {
      // Set
      const { data: setResult } = await execute(`
        mutation { setSetting(key: "theme", value: "dark") }
      `)
      expect(setResult.setSetting).toBe(true)

      // Get
      const { data: getResult } = await execute(`
        query { setting(key: "theme") }
      `)
      expect(getResult.setting).toBe('dark')

      // Get all
      const { data: allResult } = await execute(`
        query { allSettings { key value } }
      `)
      expect(allResult.allSettings).toHaveLength(1)
      expect(allResult.allSettings[0]).toEqual({ key: 'theme', value: 'dark' })

      // Delete
      const { data: delResult } = await execute(`
        mutation { deleteSetting(key: "theme") }
      `)
      expect(delResult.deleteSetting).toBe(true)

      // Verify gone
      const { data: afterDel } = await execute(`
        query { setting(key: "theme") }
      `)
      expect(afterDel.setting).toBeNull()
    })
  })

  // =========================================================================
  // Schema Version
  // =========================================================================
  describe('Schema Version', () => {
    it('returns the current schema version', async () => {
      const { data } = await execute(`{ dbSchemaVersion }`)
      expect(data.dbSchemaVersion).toBe(4)
    })
  })
})
