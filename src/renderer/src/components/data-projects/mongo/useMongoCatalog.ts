// Databases and collections of a Mongo data project for the explorer and the shell's database
// picker. Databases load once connected (and again after a reconnect or a connection-settings
// change); a database's collections load when it is expanded (or filtered), with counts, sizes
// and the collection type (collection / view / timeseries / capped). Users without the
// listDatabases privilege still see the connection's default database.
//
// Loads depend on the project's id and default database only: the project object is replaced
// on every pin, safe-mode change or touch, and that must not re-list a large cluster.
// `refreshMongoCollections` lets a view outside the explorer (Aggregations' "Create view") ask
// the mounted catalog to re-list a database it changed.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataDatabaseInfo, DataObjectInfo, DataProject } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { mongoErrorText } from './mongo-ui'

export interface CollectionsState {
  status: 'loading' | 'ok' | 'error'
  objects: DataObjectInfo[]
  error?: string
}

export interface MongoCatalog {
  databases: DataDatabaseInfo[] | null
  databasesError: string | null
  loadingDatabases: boolean
  collections: Record<string, CollectionsState>
  reloadDatabases: () => Promise<void>
  loadCollections: (database: string, force?: boolean) => Promise<void>
  /** Forget a dropped database's collections. */
  forgetDatabase: (database: string) => void
}

const SYSTEM_DATABASES = new Set(['admin', 'config', 'local'])

type CollectionsRefresher = (projectId: string, database: string) => void
const refreshers = new Set<CollectionsRefresher>()

/** Re-lists `database`'s collections in the project's mounted explorer (when it shows them). */
export function refreshMongoCollections(projectId: string, database: string): void {
  for (const refresh of refreshers) refresh(projectId, database)
}

export const isSystemDatabase = (info: Pick<DataDatabaseInfo, 'name' | 'isSystem'>): boolean =>
  info.isSystem === true || SYSTEM_DATABASES.has(info.name)

export function useMongoCatalog(project: DataProject): MongoCatalog {
  const projectId = project.id
  const defaultDatabase = project.config.database
  const [databases, setDatabases] = useState<DataDatabaseInfo[] | null>(null)
  const [databasesError, setDatabasesError] = useState<string | null>(null)
  const [loadingDatabases, setLoadingDatabases] = useState(false)
  const [collections, setCollections] = useState<Record<string, CollectionsState>>({})
  const collectionsRef = useRef(collections)
  collectionsRef.current = collections
  const dbSeq = useRef(0)
  const collSeq = useRef(new Map<string, number>())
  const connected = useDataProjectStore((s) => s.statuses[projectId]?.state === 'connected')
  const epoch = useDataProjectStore((s) => s.connectionEpoch?.[projectId] ?? 0)

  const reloadDatabases = useCallback(async (): Promise<void> => {
    const mine = ++dbSeq.current
    setLoadingDatabases(true)
    setDatabasesError(null)
    try {
      let list = await dataProjectsApi.databases(projectId)
      const fallback = defaultDatabase
      if (fallback && !list.some((d) => d.name === fallback)) list = [...list, { name: fallback }]
      list = [...list].sort((a, b) => {
        const sa = isSystemDatabase(a) ? 1 : 0
        const sb = isSystemDatabase(b) ? 1 : 0
        return sa - sb || a.name.localeCompare(b.name)
      })
      if (mine === dbSeq.current) setDatabases(list)
    } catch (e) {
      if (mine === dbSeq.current)
        setDatabasesError(mongoErrorText({ id: projectId }, e, 'Could not list the databases'))
    } finally {
      if (mine === dbSeq.current) setLoadingDatabases(false)
    }
  }, [projectId, defaultDatabase])

  const loadCollections = useCallback(
    async (database: string, force = false): Promise<void> => {
      const current = collectionsRef.current[database]
      if (!force && current && current.status !== 'error') return
      const mine = (collSeq.current.get(database) ?? 0) + 1
      collSeq.current.set(database, mine)
      setCollections((c) => ({
        ...c,
        [database]: { status: 'loading', objects: c[database]?.objects ?? [] }
      }))
      try {
        const listing = await dataProjectsApi.objects(projectId, database)
        if (collSeq.current.get(database) !== mine) return
        const objects = [...listing.objects].sort((a, b) => a.name.localeCompare(b.name))
        setCollections((c) => ({ ...c, [database]: { status: 'ok', objects } }))
      } catch (e) {
        if (collSeq.current.get(database) !== mine) return
        setCollections((c) => ({
          ...c,
          [database]: {
            status: 'error',
            objects: [],
            error: mongoErrorText({ id: projectId }, e, 'Could not list the collections')
          }
        }))
      }
    },
    [projectId]
  )

  const forgetDatabase = useCallback((database: string) => {
    setCollections((c) => {
      const { [database]: _drop, ...rest } = c
      return rest
    })
  }, [])

  useEffect(() => {
    const refresh: CollectionsRefresher = (id, database) => {
      if (id === projectId && collectionsRef.current[database]) void loadCollections(database, true)
    }
    refreshers.add(refresh)
    return () => {
      refreshers.delete(refresh)
    }
  }, [projectId, loadCollections])

  // Load when connected; reload after a reconnect / settings change (the epoch).
  useEffect(() => {
    if (!connected) return
    void reloadDatabases()
    // Re-list the collections of databases that were open before the reconnect.
    for (const db of Object.keys(collectionsRef.current)) void loadCollections(db, true)
  }, [connected, epoch, reloadDatabases, loadCollections])

  return {
    databases,
    databasesError,
    loadingDatabases,
    collections,
    reloadDatabases,
    loadCollections,
    forgetDatabase
  }
}
