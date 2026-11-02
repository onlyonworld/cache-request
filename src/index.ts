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
  options: { ttl?: number } = {},
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

export async function setUserId(id: string | number | null): Promise<void> {
  const state = requireCurrentState()
  const op = (async () => {
    await state.ready
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
  })()
  state.userOp = op
  try {
    await op
  } finally {
    state.userOp = null
  }
}

export async function clearCache(): Promise<void> {
  const state = requireCurrentState()
  await state.ready
  if (state.enabled) {
    await state.stores.cache.clear()
  }
}

export { onDiff, offDiff } from './events'
