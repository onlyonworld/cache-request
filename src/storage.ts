/**
 * 存储层：基于 localforage 访问 IndexedDB。
 *
 * 每个 projectCode 使用独立的 IndexedDB 数据库（cache-request-<code>），
 * 库内两个 store：cache（接口响应）与 meta（版本、用户信息）。
 * 不同项目的数据物理隔离，发版/切换账号时的清理互不影响。
 */
import localforage from 'localforage'
import type { MetaRecord } from './types'

export interface ProjectStores {
  projectCode: string
  cache: LocalForage
  meta: LocalForage
}

/** 为指定项目创建 cache / meta 两个 localforage 实例 */
export function createStores(projectCode: string): ProjectStores {
  const name = `cache-request-${projectCode}`
  return {
    projectCode,
    cache: localforage.createInstance({ name, storeName: 'cache' }),
    meta: localforage.createInstance({ name, storeName: 'meta' }),
  }
}

/**
 * 初始化项目：读取 meta，按 cacheKey 判断是否发版。
 * 返回当前 userId 以及是否发生了清缓存。
 */
export async function initProject(
  stores: ProjectStores,
  cacheKey: string,
): Promise<{ userId: string | number | null; cleared: boolean }> {
  const record = await stores.meta.getItem<MetaRecord>('meta')

  // 首次使用：写入初始 meta，不清理任何数据
  if (!record) {
    const initial: MetaRecord = { version: cacheKey, userId: null }
    await stores.meta.setItem('meta', initial)
    return { userId: null, cleared: false }
  }

  // 版本不一致（发版）：旧接口数据结构可能与新版不兼容，清空全部接口缓存，
  // 但保留 userId（账号未必变化），再更新版本号
  if (record.version !== cacheKey) {
    await stores.cache.clear()
    const next: MetaRecord = { ...record, version: cacheKey }
    await stores.meta.setItem('meta', next)
    return { userId: record.userId, cleared: true }
  }

  return { userId: record.userId, cleared: false }
}
