import { AxiosHeaders } from 'axios'
import type {
  AxiosAdapter,
  AxiosResponse,
  AxiosResponseHeaders,
  InternalAxiosRequestConfig,
} from 'axios'
import { hash, stableStringify } from './hash'
import type { CachedResponse, CacheEntry } from './types'
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

function headersToObject(headers: AxiosResponse['headers']): Record<string, unknown> {
  if (headers && typeof (headers as { toJSON?: () => Record<string, unknown> }).toJSON === 'function') {
    return (headers as { toJSON: () => Record<string, unknown> }).toJSON()
  }
  return (headers ?? {}) as Record<string, unknown>
}

// 在缓存 adapter 内完成 transformResponse（axios 默认在 dispatchRequest 中、
// adapter 返回后执行）。这样写入缓存的与调用方拿到的数据一致，且通过清空
// config.transformResponse 避免 dispatchRequest 二次执行。
function applyTransformResponse(
  config: InternalAxiosRequestConfig,
  data: unknown,
  headers: unknown,
  status?: number,
): unknown {
  const fns = config.transformResponse
  if (!fns) return data
  const list = Array.isArray(fns) ? fns : [fns]
  let result = data
  for (const fn of list) {
    if (typeof fn === 'function') {
      result = fn.call(
        config,
        result,
        headers as unknown as AxiosResponseHeaders,
        status,
      )
    }
  }
  return result
}

async function writeEntry(
  state: ProjectState,
  key: string,
  response: CachedResponse,
): Promise<void> {
  const now = Date.now()
  const entry: CacheEntry = {
    response,
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
        // 对齐 dispatchRequest：归一化 headers（transform 内可 headers.get），
        // 并临时挂载 config.response（JSON 解析失败时 AxiosError 需携带响应）
        const headersForTransform = AxiosHeaders.from(
          response.headers as unknown as Record<string, string>,
        ).normalize(true)
        const mutableConfig = config as InternalAxiosRequestConfig & {
          response?: AxiosResponse
        }
        mutableConfig.response = response
        try {
          response.data = applyTransformResponse(
            config,
            response.data,
            headersForTransform,
            response.status,
          )
        } finally {
          delete mutableConfig.response
        }
        // adapter 返回即最终数据，阻止 dispatchRequest 再次 transform
        config.transformResponse = []
        await writeEntry(state, key, {
          data: response.data,
          status: response.status,
          statusText: response.statusText,
          headers: headersToObject(response.headers),
        })
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

    // 结构校验：旧版本（整响应缓存）或损坏条目回源
    if (!hit || typeof hit !== 'object' || !('response' in hit)) {
      return requestNetwork()
    }

    const fresh = hit.expireAt === Infinity || hit.expireAt > Date.now()

    if (!fresh) {
      return requestNetwork()
    }

    // adapter 返回即最终数据，阻止 dispatchRequest 再次 transform
    config.transformResponse = []
    const rebuilt: AxiosResponse = {
      data: hit.response.data,
      status: hit.response.status,
      statusText: hit.response.statusText,
      headers: hit.response.headers as AxiosResponse['headers'],
      config,
    } as AxiosResponse
    ;(rebuilt as AxiosResponse & { fromCache?: boolean }).fromCache = true
    return rebuilt
  }
}
