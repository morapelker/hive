// Completion data for the Mongo editors: collections and sampled field paths per database from
// `dataProjects.schema.completion` (the server samples ~100 documents per collection and caches
// the snapshot; for Mongo, a "table" is a collection and its "columns" are dotted field paths),
// the database list, the server version (operator filtering) and whether the deployment is
// Atlas (Atlas-only stages). One request per (project, database) is shared by every editor and
// kept for a few minutes; creating/dropping a collection or index invalidates it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DataCompletionSchema, DataProject } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import type { MongoCompletionData, MongoCompletionField } from './mongo-completion'
import { registerMongoCache } from './tab-caches'

const TTL_MS = 5 * 60_000

interface Entry {
  at: number
  promise: Promise<DataCompletionSchema | null>
}

const cache = new Map<string, Entry>()
const listeners = new Set<() => void>()
const keyOf = (projectId: string, database: string): string => `${projectId}\u0000${database}`

/** The (cached) completion snapshot of a database; null when it cannot be loaded. */
export function loadCompletionSchema(
  projectId: string,
  database: string,
  refresh = false
): Promise<DataCompletionSchema | null> {
  const key = keyOf(projectId, database)
  const hit = cache.get(key)
  if (hit && !refresh && Date.now() - hit.at < TTL_MS) return hit.promise
  const promise = dataProjectsApi
    .completionSchema(projectId, database || undefined, refresh)
    .catch(() => null)
  cache.set(key, { at: Date.now(), promise })
  return promise
}

/** Drops the snapshot (after DDL) so the editors reload it with the server cache refreshed. */
export function invalidateCompletionSchema(projectId: string, database?: string): void {
  for (const key of [...cache.keys()]) {
    if (
      key.startsWith(`${projectId}\u0000`) &&
      (database === undefined || key === keyOf(projectId, database))
    )
      cache.delete(key)
  }
  for (const listener of listeners) listener()
}

export function isAtlasProject(project: Pick<DataProject, 'config'>): boolean {
  const hosts = [project.config.host ?? '', ...(project.config.mongo?.hosts ?? [])]
  return hosts.some((h) => /\.mongodb\.net(:\d+)?$/i.test(h.trim()))
}

function toData(
  schema: DataCompletionSchema | null,
  ownCollection: string | null,
  serverVersion: string | undefined,
  atlas: boolean
): MongoCompletionData {
  const byName = new Map<string, MongoCompletionField[]>()
  for (const table of schema?.tables ?? []) {
    byName.set(
      table.name,
      table.columns.map((c) => ({ path: c.name, ...(c.type ? { type: c.type } : {}) }))
    )
  }
  return {
    databases: schema?.databases ?? [],
    collections: schema?.tables.map((t) => t.name) ?? [],
    fields: (collection) => byName.get(collection ?? ownCollection ?? '') ?? [],
    ...(serverVersion ? { serverVersion: serverVersion.replace(/[^\d.].*$/, '') } : {}),
    atlas
  }
}

/**
 * A stable getter of the latest completion data for `database` (editors read it lazily, so a
 * reload needs no editor reconfiguration). `ownCollection` answers field requests for the
 * editor's own collection (query bar, stages, dialogs).
 */
export function useMongoCompletionData(
  project: DataProject,
  database: string | undefined,
  ownCollection: string | null = null
): () => MongoCompletionData {
  const [schema, setSchema] = useState<DataCompletionSchema | null>(null)
  const [generation, setGeneration] = useState(0)
  const serverVersion = useDataProjectStore((s) => s.statuses[project.id]?.serverVersion)
  const atlas = isAtlasProject(project)

  useEffect(() => {
    const bump = (): void => setGeneration((g) => g + 1)
    listeners.add(bump)
    return () => {
      listeners.delete(bump)
    }
  }, [])

  useEffect(() => {
    let alive = true
    loadCompletionSchema(project.id, database ?? '').then((value) => {
      if (alive) setSchema(value)
    })
    return () => {
      alive = false
    }
  }, [project.id, database, generation])

  const data = useMemo(
    () => toData(schema, ownCollection, serverVersion, atlas),
    [schema, ownCollection, serverVersion, atlas]
  )
  const dataRef = useRef(data)
  dataRef.current = data
  return useCallback(() => dataRef.current, [])
}

/** Tests only. */
export function resetCompletionCache(): void {
  cache.clear()
}

registerMongoCache(({ projectId }) => {
  if (projectId === undefined) return
  for (const key of [...cache.keys()]) if (key.startsWith(`${projectId}\u0000`)) cache.delete(key)
})
