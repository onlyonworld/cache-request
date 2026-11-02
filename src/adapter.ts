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
import { emitDiff } from './events'

// 仅用于计算缓存 key：普通对象顶层浅拷贝并删除命中的 key，
// 返回新对象；非普通对象（null、数组、FormData、字符串 body 等）原样返回。
export function filterIgnored(value: unknown, ignore: Set<string>): unknown {
  if (ignore.size === 0) return value
  if (typeof value !== 'object' || value === null) return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (!ignore.has(key)) {
      out[key] = source[key]
    }
  }
  return out
}

function computeKey(state: ProjectState, config: InternalAxiosRequestConfig): string | null {
  try {
    const ignore = new Set<string>([
      ...state.ignoreParams,
      ...(config.ignoreParams ?? []),
    ])
    return hash(
      stableStringify({
        userId: state.userId,
        method: config.method,
        url: config.url,
        params: filterIgnored(config.params, ignore),
        data: filterIgnored(config.data, ignore),
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

// 网络成功路径的统一收尾：归一化 headers + 执行 transformResponse，
// 构造可缓存的 CachedResponse。非 2xx 返回 null（不缓存）。
// 同时清空 cfg.transformResponse，阻止 dispatchRequest 二次执行。
async function finalizeNetworkResponse(
  cfg: InternalAxiosRequestConfig,
  response: AxiosResponse,
): Promise<CachedResponse | null> {
  if (response.status < 200 || response.status >= 300) return null
  // 对齐 dispatchRequest：归一化 headers（transform 内可 headers.get），
  // 并临时挂载 cfg.response（JSON 解析失败时 AxiosError 需携带响应）
  const headersForTransform = AxiosHeaders.from(
    response.headers as unknown as Record<string, string>,
  ).normalize(true)
  const mutableConfig = cfg as InternalAxiosRequestConfig & {
    response?: AxiosResponse
  }
  mutableConfig.response = response
  try {
    response.data = applyTransformResponse(
      cfg,
      response.data,
      headersForTransform,
      response.status,
    )
  } finally {
    delete mutableConfig.response
  }
  // adapter 返回即最终数据，阻止 dispatchRequest 再次 transform
  cfg.transformResponse = []
  return {
    data: response.data,
    status: response.status,
    statusText: response.statusText,
    headers: headersToObject(response.headers),
  }
}

// 命中后的静默刷新：后台回源，对比新旧数据，一致则仅刷新 TTL，
// 不一致则覆盖缓存并发出 diff 事件。任何失败都被静默吞掉。
async function revalidateInBackground(
  state: ProjectState,
  cfg: InternalAxiosRequestConfig,
  originalAdapter: AxiosAdapter,
  key: string,
  oldEntry: CacheEntry,
): Promise<void> {
  try {
    const response = await originalAdapter(cfg)
    const cached = await finalizeNetworkResponse(cfg, response)
    if (!cached) return

    let same = false
    try {
      same =
        hash(stableStringify(cached.data)) ===
        hash(stableStringify(oldEntry.response.data))
    } catch {
      same = false // 无法比较时保守视为不一致
    }

    if (same) {
      const refreshed: CacheEntry = {
        ...oldEntry,
        expireAt: state.ttl === 0 ? Infinity : Date.now() + state.ttl,
      }
      await state.stores.cache.setItem(key, refreshed)
      return
    }

    await writeEntry(state, key, cached)
    emitDiff({
      method: cfg.method ?? 'get',
      url: cfg.url ?? '',
      params: cfg.params,
      data: cfg.data,
      oldData: oldEntry.response.data,
      newData: cached.data,
    })
  } catch {
    // 后台失败：静默保留旧缓存
  }
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

    // 异步调度后台刷新：复制 config 保留调用方原始 transformResponse
    // （网络/命中路径都会清空它）。setTimeout 让出当前调用栈；
    // revalidateInBackground 内部已兜底所有错误。
    const scheduleBackground = (
      cfg: InternalAxiosRequestConfig,
      oldEntry: CacheEntry,
    ): void => {
      setTimeout(() => {
        void revalidateInBackground(state, cfg, originalAdapter, key, oldEntry)
      }, 0)
    }

    const requestNetwork = async (): Promise<AxiosResponse> => {
      // revalidate 场景下首次回源写入后也要后台再校验一次（brief 用例要求）
      const bgConfig = config.revalidate
        ? ({
            ...config,
            transformResponse: config.transformResponse,
          } as InternalAxiosRequestConfig)
        : null
      const response = await originalAdapter(config)
      const cached = await finalizeNetworkResponse(config, response)
      if (cached) {
        await writeEntry(state, key, cached)
        if (bgConfig) {
          scheduleBackground(bgConfig, {
            response: cached,
            createdAt: Date.now(),
            expireAt: state.ttl === 0 ? Infinity : Date.now() + state.ttl,
          })
        }
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

    // 命中分支：先复制 config 保留原始 transformResponse（紧接着会被清空），
    // 再异步调度后台刷新。用 setTimeout 让出当前调用栈，使本次请求返回与
    // 后台回源互不影响；revalidate 内部已兜底所有错误。
    // 命中：先复制 config 保留原始 transformResponse（紧接着会被清空）
    const bgConfig = config.revalidate
      ? ({
          ...config,
          transformResponse: config.transformResponse,
        } as InternalAxiosRequestConfig)
      : null

    // adapter 返回即最终数据，阻止 dispatchRequest 再次 transform
    config.transformResponse = []

    if (bgConfig) {
      scheduleBackground(bgConfig, hit as CacheEntry)
    }

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
