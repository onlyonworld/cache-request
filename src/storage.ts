import localforage from 'localforage'
import type { MetaRecord } from './types'

export interface ProjectStores {
  projectCode: string
  cache: LocalForage
  meta: LocalForage
}

export function createStores(projectCode: string): ProjectStores {
  const name = `cache-request-${projectCode}`
  return {
    projectCode,
    cache: localforage.createInstance({ name, storeName: 'cache' }),
    meta: localforage.createInstance({ name, storeName: 'meta' }),
  }
}

export async function initProject(
  stores: ProjectStores,
  cacheKey: string,
): Promise<{ userId: string | number | null; cleared: boolean }> {
  const record = await stores.meta.getItem<MetaRecord>('meta')

  if (!record) {
    const initial: MetaRecord = { version: cacheKey, userId: null }
    await stores.meta.setItem('meta', initial)
    return { userId: null, cleared: false }
  }

  if (record.version !== cacheKey) {
    await stores.cache.clear()
    const next: MetaRecord = { ...record, version: cacheKey }
    await stores.meta.setItem('meta', next)
    return { userId: record.userId, cleared: true }
  }

  return { userId: record.userId, cleared: false }
}
