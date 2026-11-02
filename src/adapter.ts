import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { hash, stableStringify } from './hash'
import type { CacheEntry } from './types'
import type { ProjectState } from './state'

function computeKey(state: ProjectState, config: InternalAxiosRequestConfig): string | null {
  try {
    return hash(
      stableStringify({
        userId: state.userId,
        method: config.method,
        url: config.url,
        params: config.params,
        data: config.data,
      }),
    )
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// IndexedDB structured clone 不支持函数（如 config.adapter / validateStatus），
// 持久化前递归剥离函数；Date/FormData/Blob 等内置类型保持原样
function stripFunctions(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'function') return undefined
  if (Array.isArray(value)) {
    return value.map((item) => stripFunctions(item, seen))
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return undefined
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value)) {
      const stripped = stripFunctions(value[k], seen)
      if (stripped !== undefined) out[k] = stripped
    }
    return out
  }
  return value
}

async function writeEntry(
  state: ProjectState,
  key: string,
  response: AxiosResponse,
): Promise<void> {
  const now = Date.now()
  const entry: CacheEntry = {
    data: stripFunctions(response, new WeakSet()) as AxiosResponse,
    createdAt: now,
    expireAt: state.ttl === 0 ? Infinity : now + state.ttl,
  }
  try {
    await state.stores.cache.setItem(key, entry)
  } catch {
    // 配额超限等：清库后重试一次
    try {
      await state.stores.cache.clear()
      await state.stores.cache.setItem(key, entry)
    } catch {
      /* 放弃写入 */
    }
  }
}

export function createAdapter(
  originalAdapter: AxiosAdapter,
  state: ProjectState,
): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    await state.ready
    if (state.userOp) await state.userOp

    const cacheOption = config.cache
    if (!state.enabled || !cacheOption) {
      return originalAdapter(config)
    }

    const key = computeKey(state, config)
    if (key === null) {
      return originalAdapter(config)
    }

    const force = typeof cacheOption === 'object' && cacheOption.force === true

    const requestNetwork = async (): Promise<AxiosResponse> => {
      const response = await originalAdapter(config)
      if (response.status >= 200 && response.status < 300) {
        await writeEntry(state, key, response)
      }
      return response
    }

    if (force) {
      return requestNetwork()
    }

    let hit: CacheEntry | null = null
    try {
      hit = await state.stores.cache.getItem<CacheEntry>(key)
    } catch {
      hit = null
    }

    if (!hit) {
      return requestNetwork()
    }

    const fresh = hit.expireAt === Infinity || hit.expireAt > Date.now()

    if (!fresh) {
      return requestNetwork()
    }

    const response = hit.data as AxiosResponse & { fromCache?: boolean }
    response.fromCache = true
    return response
  }
}
