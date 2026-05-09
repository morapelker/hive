import { Data, Effect } from 'effect'
import { z } from 'zod'

import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import { telemetryService } from '../services/telemetry-service'
import type {
  ProjectCreate,
  ProjectUpdate,
  WorktreeCreate,
  WorktreeUpdate,
  SessionCreate,
  SessionUpdate,
  SessionSearchOptions,
  SpaceCreate,
  SpaceUpdate,
  DiffCommentCreate,
  DiffCommentUpdate
} from '../db'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'DatabaseHandlers' })

class DbHandlerFailed extends Data.TaggedError('DbHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const dbFailed = (operation: string, cause: unknown): DbHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new DbHandlerFailed({ operation, reason, message: reason })
}

const tryDb = <A>(operation: string, fn: () => A): Effect.Effect<A, DbHandlerFailed> =>
  Effect.try({
    try: fn,
    catch: (error) => dbFailed(operation, error)
  })

const noArgsSchema = z.tuple([])
const stringArgSchema = z.string()
const stringPairSchema = z.tuple([z.string(), z.string()])
const stringBooleanPairSchema = z.tuple([z.string(), z.boolean()])
const stringArraySchema = z.array(z.string())
const typedSchema = <A>(): z.ZodType<A> => z.custom<A>()

const worktreeModelSchema = z.object({
  worktreeId: z.string(),
  modelProviderId: z.string(),
  modelId: z.string(),
  modelVariant: z.string().nullable()
})

const worktreeAttachmentSchema = z.object({
  worktreeId: z.string(),
  attachment: z.object({
    type: z.enum(['jira', 'figma']),
    url: z.string(),
    label: z.string()
  })
})

const worktreeAttachmentIdSchema = z.object({
  worktreeId: z.string(),
  attachmentId: z.string()
})

const worktreePrSchema = z.object({
  worktreeId: z.string(),
  prNumber: z.number(),
  prUrl: z.string()
})

const worktreeIdSchema = z.object({ worktreeId: z.string() })
const worktreePinnedSchema = z.object({ worktreeId: z.string(), pinned: z.boolean() })

export function registerDatabaseHandlers(): void {
  log.info('Registering database handlers')

  // Settings
  defineHandler('db:setting:get', stringArgSchema, (key) =>
    tryDb('db:setting:get', () => getDatabase().getSetting(key))
  )

  defineHandler('db:setting:set', stringPairSchema, ([key, value]) =>
    tryDb('db:setting:set', () => {
      getDatabase().setSetting(key, value)
      return true
    })
  )

  defineHandler('db:setting:delete', stringArgSchema, (key) =>
    tryDb('db:setting:delete', () => {
      getDatabase().deleteSetting(key)
      return true
    })
  )

  defineHandler('db:setting:getAll', noArgsSchema, () =>
    tryDb('db:setting:getAll', () => getDatabase().getAllSettings())
  )

  // Projects
  defineHandler('db:project:create', typedSchema<ProjectCreate>(), (data) =>
    tryDb('db:project:create', () => {
      const db = getDatabase()
      const project = db.createProject(data)

      db.createWorktree({
        project_id: project.id,
        name: '(no-worktree)',
        branch_name: '',
        path: project.path,
        is_default: true
      })

      return project
    }).pipe(Effect.tap(() => Effect.sync(() => telemetryService.track('project_added', {}))))
  )

  defineHandler('db:project:get', stringArgSchema, (id) =>
    tryDb('db:project:get', () => getDatabase().getProject(id))
  )

  defineHandler('db:project:getByPath', stringArgSchema, (path) =>
    tryDb('db:project:getByPath', () => getDatabase().getProjectByPath(path))
  )

  defineHandler('db:project:getAll', noArgsSchema, () =>
    tryDb('db:project:getAll', () => getDatabase().getAllProjects())
  )

  defineHandler(
    'db:project:update',
    z.tuple([z.string(), typedSchema<ProjectUpdate>()]),
    ([id, data]) => tryDb('db:project:update', () => getDatabase().updateProject(id, data))
  )

  defineHandler('db:project:delete', stringArgSchema, (id) =>
    tryDb('db:project:delete', () => getDatabase().deleteProject(id))
  )

  defineHandler('db:project:touch', stringArgSchema, (id) =>
    tryDb('db:project:touch', () => {
      getDatabase().touchProject(id)
      return true
    })
  )

  defineHandler('db:project:reorder', stringArraySchema, (orderedIds) =>
    tryDb('db:project:reorder', () => {
      getDatabase().reorderProjects(orderedIds)
      return true
    })
  )

  defineHandler('db:project:sortByLastMessage', noArgsSchema, () =>
    tryDb('db:project:sortByLastMessage', () => getDatabase().getProjectIdsSortedByLastMessage())
  )

  // Worktrees
  defineHandler('db:worktree:create', typedSchema<WorktreeCreate>(), (data) =>
    tryDb('db:worktree:create', () => getDatabase().createWorktree(data))
  )

  defineHandler('db:worktree:get', stringArgSchema, (id) =>
    tryDb('db:worktree:get', () => getDatabase().getWorktree(id))
  )

  defineHandler('db:worktree:getByProject', stringArgSchema, (projectId) =>
    tryDb('db:worktree:getByProject', () => getDatabase().getWorktreesByProject(projectId))
  )

  defineHandler('db:worktree:getActiveByProject', stringArgSchema, (projectId) =>
    tryDb('db:worktree:getActiveByProject', () =>
      getDatabase().getActiveWorktreesByProject(projectId)
    )
  )

  defineHandler('db:worktree:getRecentlyActive', z.number(), (cutoffMs) =>
    tryDb('db:worktree:getRecentlyActive', () => getDatabase().getRecentlyActiveWorktrees(cutoffMs))
  )

  defineHandler(
    'db:worktree:update',
    z.tuple([z.string(), typedSchema<WorktreeUpdate>()]),
    ([id, data]) => tryDb('db:worktree:update', () => getDatabase().updateWorktree(id, data))
  )

  defineHandler('db:worktree:delete', stringArgSchema, (id) =>
    tryDb('db:worktree:delete', () => getDatabase().deleteWorktree(id))
  )

  defineHandler('db:worktree:archive', stringArgSchema, (id) =>
    tryDb('db:worktree:archive', () => getDatabase().archiveWorktree(id))
  )

  defineHandler('db:worktree:touch', stringArgSchema, (id) =>
    tryDb('db:worktree:touch', () => {
      getDatabase().touchWorktree(id)
      return true
    })
  )

  defineHandler('db:worktree:updateModel', worktreeModelSchema, (params) =>
    tryDb('db:worktree:updateModel', () => {
      getDatabase().updateWorktreeModel(
        params.worktreeId,
        params.modelProviderId,
        params.modelId,
        params.modelVariant ?? null
      )
      return { success: true }
    })
  )

  defineHandler(
    'db:worktree:appendSessionTitle',
    z.object({ worktreeId: z.string(), title: z.string() }),
    ({ worktreeId, title }) =>
      tryDb('db:worktree:appendSessionTitle', () => {
        getDatabase().appendSessionTitle(worktreeId, title)
        return { success: true }
      })
  )

  defineHandler(
    'db:worktree:addAttachment',
    worktreeAttachmentSchema,
    ({ worktreeId, attachment }) =>
      tryDb('db:worktree:addAttachment', () => getDatabase().addAttachment(worktreeId, attachment))
  )

  defineHandler(
    'db:worktree:removeAttachment',
    worktreeAttachmentIdSchema,
    ({ worktreeId, attachmentId }) =>
      tryDb('db:worktree:removeAttachment', () =>
        getDatabase().removeAttachment(worktreeId, attachmentId)
      )
  )

  defineHandler('db:worktree:attachPR', worktreePrSchema, ({ worktreeId, prNumber, prUrl }) =>
    tryDb('db:worktree:attachPR', () => getDatabase().attachPR(worktreeId, prNumber, prUrl))
  )

  defineHandler('db:worktree:detachPR', worktreeIdSchema, ({ worktreeId }) =>
    tryDb('db:worktree:detachPR', () => getDatabase().detachPR(worktreeId))
  )

  defineHandler('db:worktree:setPinned', worktreePinnedSchema, ({ worktreeId, pinned }) =>
    tryDb('db:worktree:setPinned', () => {
      getDatabase().updateWorktree(worktreeId, { pinned: pinned ? 1 : 0 })
      return { success: true }
    })
  )

  defineHandler('db:worktree:getPinned', noArgsSchema, () =>
    tryDb('db:worktree:getPinned', () => getDatabase().getPinnedWorktrees())
  )

  // Sessions
  defineHandler('db:session:create', typedSchema<SessionCreate>(), (data) =>
    tryDb('db:session:create', () => getDatabase().createSession(data))
  )

  defineHandler('db:session:get', stringArgSchema, (id) =>
    tryDb('db:session:get', () => getDatabase().getSession(id))
  )

  defineHandler('db:session:getByWorktree', stringArgSchema, (worktreeId) =>
    tryDb('db:session:getByWorktree', () => getDatabase().getSessionsByWorktree(worktreeId))
  )

  defineHandler('db:session:getByProject', stringArgSchema, (projectId) =>
    tryDb('db:session:getByProject', () => getDatabase().getSessionsByProject(projectId))
  )

  defineHandler('db:session:getActiveByWorktree', stringArgSchema, (worktreeId) =>
    tryDb('db:session:getActiveByWorktree', () =>
      getDatabase().getActiveSessionsByWorktree(worktreeId)
    )
  )

  defineHandler(
    'db:session:update',
    z.tuple([z.string(), typedSchema<SessionUpdate>()]),
    ([id, data]) => tryDb('db:session:update', () => getDatabase().updateSession(id, data))
  )

  defineHandler('db:session:delete', stringArgSchema, (id) =>
    tryDb('db:session:delete', () => getDatabase().deleteSession(id))
  )

  defineHandler('db:session:getByConnection', stringArgSchema, (connectionId) =>
    tryDb('db:session:getByConnection', () => getDatabase().getSessionsByConnection(connectionId))
  )

  defineHandler('db:session:getActiveByConnection', stringArgSchema, (connectionId) =>
    tryDb('db:session:getActiveByConnection', () =>
      getDatabase().getActiveSessionsByConnection(connectionId)
    )
  )

  defineHandler('db:session:setPinnedToBoard', stringBooleanPairSchema, ([sessionId, pinned]) =>
    tryDb('db:session:setPinnedToBoard', () =>
      getDatabase().updateSession(sessionId, { pinned_to_board: pinned })
    )
  )

  defineHandler('db:session:getPinnedSessions', stringArgSchema, (worktreeId) =>
    tryDb('db:session:getPinnedSessions', () => getDatabase().getPinnedSessions(worktreeId))
  )

  defineHandler('db:session:search', typedSchema<SessionSearchOptions>(), (options) =>
    tryDb('db:session:search', () => getDatabase().searchSessions(options))
  )

  defineHandler('db:session:getActiveBoardAssistant', stringArgSchema, (projectId) =>
    tryDb('db:session:getActiveBoardAssistant', () =>
      getDatabase().getActiveBoardAssistantByProject(projectId)
    )
  )

  defineHandler('db:session:getDraft', stringArgSchema, (sessionId) =>
    tryDb('db:session:getDraft', () => getDatabase().getSessionDraft(sessionId))
  )

  defineHandler(
    'db:session:updateDraft',
    z.tuple([z.string(), z.string().nullable()]),
    ([sessionId, draft]) =>
      tryDb('db:session:updateDraft', () => {
        getDatabase().updateSessionDraft(sessionId, draft)
      })
  )

  defineHandler('db:sessionMessage:list', stringArgSchema, (sessionId) =>
    tryDb('db:sessionMessage:list', () => getDatabase().getSessionMessages(sessionId))
  )

  defineHandler('db:sessionActivity:list', stringArgSchema, (sessionId) =>
    tryDb('db:sessionActivity:list', () => getDatabase().getSessionActivities(sessionId))
  )

  // Spaces
  defineHandler('db:space:list', noArgsSchema, () =>
    tryDb('db:space:list', () => getDatabase().listSpaces())
  )

  defineHandler('db:space:create', typedSchema<SpaceCreate>(), (data) =>
    tryDb('db:space:create', () => getDatabase().createSpace(data))
  )

  defineHandler(
    'db:space:update',
    z.tuple([z.string(), typedSchema<SpaceUpdate>()]),
    ([id, data]) => tryDb('db:space:update', () => getDatabase().updateSpace(id, data))
  )

  defineHandler('db:space:delete', stringArgSchema, (id) =>
    tryDb('db:space:delete', () => getDatabase().deleteSpace(id))
  )

  defineHandler('db:space:assignProject', stringPairSchema, ([projectId, spaceId]) =>
    tryDb('db:space:assignProject', () => {
      getDatabase().assignProjectToSpace(projectId, spaceId)
      return true
    })
  )

  defineHandler('db:space:removeProject', stringPairSchema, ([projectId, spaceId]) =>
    tryDb('db:space:removeProject', () => {
      getDatabase().removeProjectFromSpace(projectId, spaceId)
      return true
    })
  )

  defineHandler('db:space:getProjectIds', stringArgSchema, (spaceId) =>
    tryDb('db:space:getProjectIds', () => getDatabase().getProjectIdsForSpace(spaceId))
  )

  defineHandler('db:space:getAllAssignments', noArgsSchema, () =>
    tryDb('db:space:getAllAssignments', () => getDatabase().getAllProjectSpaceAssignments())
  )

  defineHandler('db:space:reorder', stringArraySchema, (orderedIds) =>
    tryDb('db:space:reorder', () => {
      getDatabase().reorderSpaces(orderedIds)
      return true
    })
  )

  // Diff Comments
  defineHandler('db:diffComment:create', typedSchema<DiffCommentCreate>(), (data) =>
    tryDb('db:diffComment:create', () => getDatabase().createDiffComment(data))
  )

  defineHandler('db:diffComment:list', stringArgSchema, (worktreeId) =>
    tryDb('db:diffComment:list', () => getDatabase().getDiffCommentsByWorktree(worktreeId))
  )

  defineHandler(
    'db:diffComment:update',
    z.tuple([z.string(), typedSchema<DiffCommentUpdate>()]),
    ([id, data]) => tryDb('db:diffComment:update', () => getDatabase().updateDiffComment(id, data))
  )

  defineHandler('db:diffComment:setOutdated', stringBooleanPairSchema, ([id, isOutdated]) =>
    tryDb('db:diffComment:setOutdated', () => getDatabase().setDiffCommentOutdated(id, isOutdated))
  )

  defineHandler('db:diffComment:delete', stringArgSchema, (id) =>
    tryDb('db:diffComment:delete', () => getDatabase().deleteDiffComment(id))
  )

  defineHandler('db:diffComment:clearAll', stringArgSchema, (worktreeId) =>
    tryDb('db:diffComment:clearAll', () => getDatabase().clearAllDiffComments(worktreeId))
  )

  // Utility
  defineHandler('db:schemaVersion', noArgsSchema, () =>
    tryDb('db:schemaVersion', () => getDatabase().getSchemaVersion())
  )

  defineHandler('db:tableExists', stringArgSchema, (tableName) =>
    tryDb('db:tableExists', () => getDatabase().tableExists(tableName))
  )

  defineHandler('db:getIndexes', noArgsSchema, () =>
    tryDb('db:getIndexes', () => getDatabase().getIndexes())
  )
}
