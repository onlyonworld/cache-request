import { describe, it, expect } from 'vitest'
import { createStores, initProject } from '../src/storage'

describe('initProject', () => {
  it('首次使用写入 meta，不清缓存', async () => {
    const stores = createStores('test-first')
    const result = await initProject(stores, 'v1')
    expect(result.cleared).toBe(false)
    expect(result.userId).toBeNull()
    expect(await stores.meta.getItem('meta')).toEqual({ version: 'v1', userId: null })
  })

  it('cacheKey 不变时不清缓存', async () => {
    const stores = createStores('test-same')
    await initProject(stores, 'v1')
    await stores.cache.setItem('k', { x: 1 })
    const result = await initProject(stores, 'v1')
    expect(result.cleared).toBe(false)
    expect(await stores.cache.getItem('k')).toEqual({ x: 1 })
  })

  it('cacheKey 变化（发版）清空 cache 并更新 version，保留 userId', async () => {
    const stores = createStores('test-version')
    await initProject(stores, 'v1')
    await stores.meta.setItem('meta', { version: 'v1', userId: 'u1' })
    await stores.cache.setItem('k', { x: 1 })
    const result = await initProject(stores, 'v2')
    expect(result.cleared).toBe(true)
    expect(result.userId).toBe('u1')
    expect(await stores.cache.getItem('k')).toBeNull()
    expect(await stores.meta.getItem('meta')).toEqual({ version: 'v2', userId: 'u1' })
  })

  it('不同 projectCode 使用不同数据库，互不影响', async () => {
    const a = createStores('project-a')
    const b = createStores('project-b')
    await initProject(a, 'v1')
    await initProject(b, 'v9')
    await a.cache.setItem('shared-key', { from: 'a' })
    expect(await b.cache.getItem('shared-key')).toBeNull()
  })
})
