/**
 * 包入口：cacheRequest 初始化 + setUserId / clearCache 等全局管理方法。
 * 修改传入 axios 实例的 defaults.adapter，内部包裹其原 adapter。
 */
import type { AxiosAdapter, AxiosInstance, AxiosStatic } from 'axios'
import { createAdapter } from './adapter'
import { createStores, initProject } from './storage'
import { getState, registerState, type ProjectState } from './state'
import type { MetaRecord } from './types'

export type { CacheDiffEvent, CacheEntry, MetaRecord } from './types'

const DEFAULT_TTL = 24 * 60 * 60 * 1000

// 幂等：实例 -> 其原始 adapter
const originalAdapters = new WeakMap<object, AxiosAdapter>()

let currentProject: string | null = null

function isAxiosLike(value: unknown): value is AxiosInstance | AxiosStatic {
  return typeof value === 'function' && !!(value as AxiosInstance).defaults
}

function resolveOriginalAdapter(
  instance: AxiosInstance | AxiosStatic,
): AxiosAdapter {
  const configured = instance.defaults.adapter
  if (typeof configured === 'function') {
    return configured as AxiosAdapter
  }
  const withGetAdapter = instance as AxiosInstance & {
    getAdapter?: (adapter: unknown) => AxiosAdapter
  }
  if (typeof withGetAdapter.getAdapter === 'function') {
    return withGetAdapter.getAdapter(configured)
  }
  throw new TypeError('cache-request: cannot resolve original axios adapter')
}

export function cacheRequest(
  axiosInstance: AxiosInstance | AxiosStatic,
  projectCode: string,
  cacheKey: string,
  options: { ttl?: number; ignoreParams?: string[] } = {},
): void {
  if (!isAxiosLike(axiosInstance)) {
    throw new TypeError('cache-request: first argument must be an axios instance')
  }
  if (!projectCode) {
    throw new TypeError('cache-request: projectCode is required')
  }

  // 幂等：若该实例已被包裹，先还原原 adapter
  const previous = originalAdapters.get(axiosInstance as object)
  if (previous) {
    axiosInstance.defaults.adapter = previous
  }
  const originalAdapter = resolveOriginalAdapter(axiosInstance)
  originalAdapters.set(axiosInstance as object, originalAdapter)

  const ttl = options.ttl ?? DEFAULT_TTL
  const stores = createStores(projectCode)

  const state: ProjectState = {
    projectCode,
    stores,
    userId: null,
    enabled: true,
    ttl,
    ignoreParams: options.ignoreParams ?? [],
    ready: Promise.resolve(),
    userOp: null,
  }

  state.ready = (async () => {
    try {
      const result = await initProject(stores, cacheKey)
      state.userId = result.userId
      state.enabled = true
    } catch {
      state.enabled = false
    }
  })()

  registerState(state)
  currentProject = projectCode
  axiosInstance.defaults.adapter = createAdapter(originalAdapter, state)
}

function requireCurrentState(): ProjectState {
  if (!currentProject) {
    throw new Error('cache-request: call cacheRequest() before using cache controls')
  }
  // 每次从注册表取，确保拿到最新实例
  return getState(currentProject)
}

async function doSetUserId(state: ProjectState, id: string | number | null): Promise<void> {
  await state.ready
  // IDB 降级时不触碰存储（必然抛错），userId 仅内存生效——本就无缓存可读。
  // 保证"包永不抛出影响业务"。
  if (!state.enabled) {
    state.userId = id
    return
  }
  const record = await state.stores.meta.getItem<MetaRecord>('meta')
  if (!record || record.userId !== id) {
    await state.stores.cache.clear()
    const next: MetaRecord = {
      version: record?.version ?? '',
      userId: id,
    }
    await state.stores.meta.setItem('meta', next)
  }
  state.userId = id
}

// 并发 setUserId 串行化：模块级 promise 链
let userChain: Promise<void> = Promise.resolve()

export function setUserId(id: string | number | null): Promise<void> {
  const state = requireCurrentState()
  const run = userChain.then(() => doSetUserId(state, id))
  state.userOp = run
  userChain = run.catch(() => {})
  run.finally(() => {
    if (state.userOp === run) state.userOp = null
  })
  return run
}

export async function clearCache(): Promise<void> {
  const state = requireCurrentState()
  await state.ready
  if (state.enabled) {
    await state.stores.cache.clear()
  }
}

export { onDiff, offDiff } from './events'
