import { Effect } from 'effect'
import { z } from 'zod'
import { TICKET_LABEL_COLORS } from '../../../shared/lib/ticket-labels'
import type {
  SavedTicketLabel,
  SavedTicketLabelCreate,
  SavedTicketLabelMutationResult,
  SavedTicketLabelUpdate
} from '../../../main/db'
import type { RpcHandler } from '../router'

/**
 * The machine-wide catalog of saved ticket labels (shared/lib/ticket-labels.ts). Desktop-only:
 * these methods are not in the remote-access policy, so a phone or another Mac cannot reach
 * them (another Mac's tickets show their labels read-only).
 *
 * The DB rejects a name clash, an empty name and a full catalog with an Error whose message is
 * meant for the user ('A label named "X" already exists'); toRpcError keeps that message, so
 * the renderer's dialog shows it as is. A label name never goes into a log line here.
 */
export interface TicketLabelsRpcService {
  readonly list: () => Effect.Effect<SavedTicketLabel[], unknown, never>
  readonly create: (data: SavedTicketLabelCreate) => Effect.Effect<SavedTicketLabel, unknown, never>
  readonly update: (
    id: string,
    data: SavedTicketLabelUpdate
  ) => Effect.Effect<SavedTicketLabelMutationResult, unknown, never>
  readonly reorder: (ids: string[]) => Effect.Effect<SavedTicketLabelMutationResult, unknown, never>
  readonly delete: (id: string) => Effect.Effect<SavedTicketLabelMutationResult, unknown, never>
  /** Saved label id -> how many tickets carry it (both boards, archived included). */
  readonly usage: () => Effect.Effect<Record<string, number>, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])

// The bounds are generous on purpose: the DB normalises the name (NFKC, whitespace, cut to
// TICKET_LABEL_NAME_MAX) and owns the user-facing errors, including 'Label name is required'
// for a blank one, so the schema only turns away malformed or absurd input. Unlike a label on a
// ticket, a catalog colour must be one of the presets.
const labelIdSchema = z.string().min(1).max(64)
const labelNameSchema = z.string().min(1).max(64)
const labelColorSchema = z.enum(TICKET_LABEL_COLORS)

const ticketLabelCreateSchema = z
  .object({
    name: labelNameSchema,
    color: labelColorSchema
  })
  .strict() satisfies z.ZodType<SavedTicketLabelCreate>

const ticketLabelUpdateDataSchema = z
  .object({
    name: labelNameSchema.optional(),
    color: labelColorSchema.optional()
  })
  .strict() satisfies z.ZodType<SavedTicketLabelUpdate>

const ticketLabelUpdateParamsSchema = z
  .object({
    id: labelIdSchema,
    data: ticketLabelUpdateDataSchema
  })
  .strict()

// The catalog holds at most SAVED_TICKET_LABELS_MAX rows; the cap leaves room for a list built
// from a slightly stale catalog (the DB ignores ids it does not know).
const ticketLabelReorderParamsSchema = z.object({ ids: z.array(labelIdSchema).max(500) }).strict()

const ticketLabelIdParamsSchema = z.object({ id: labelIdSchema }).strict()

export const makeLiveTicketLabelsRpcService = (): TicketLabelsRpcService => ({
  list: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSavedTicketLabels()
      },
      catch: (cause) => cause
    }),
  create: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().createSavedTicketLabel(data)
      },
      catch: (cause) => cause
    }),
  update: (id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateSavedTicketLabel(id, data)
      },
      catch: (cause) => cause
    }),
  reorder: (ids) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().reorderSavedTicketLabels(ids)
      },
      catch: (cause) => cause
    }),
  delete: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().deleteSavedTicketLabel(id)
      },
      catch: (cause) => cause
    }),
  usage: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSavedTicketLabelUsage()
      },
      catch: (cause) => cause
    })
})

export const makeTicketLabelsRpcHandlers = (
  service: TicketLabelsRpcService = makeLiveTicketLabelsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'ticketLabels.list',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.list()
        })
    ],
    [
      'ticketLabels.create',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => ticketLabelCreateSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.create(data)
        })
    ],
    [
      'ticketLabels.update',
      (params) =>
        Effect.gen(function* () {
          const { id, data } = yield* Effect.try({
            try: () => ticketLabelUpdateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.update(id, data)
        })
    ],
    [
      'ticketLabels.reorder',
      (params) =>
        Effect.gen(function* () {
          const { ids } = yield* Effect.try({
            try: () => ticketLabelReorderParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.reorder(ids)
        })
    ],
    [
      'ticketLabels.delete',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => ticketLabelIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.delete(id)
        })
    ],
    [
      'ticketLabels.usage',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.usage()
        })
    ]
  ])
