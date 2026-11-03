/**
 * 缓存 adapter：本包的核心。替换 axios 实例的 defaults.adapter，包裹其原
 * adapter 作为网络回退。处理五条路径——
 * 1. 未开启 cache / IDB 降级：原样透传，不读不写
 * 2. 未命中或 TTL 过期：回源一次，2xx 响应写入缓存
 * 3. force：强制回源，结果覆盖缓存
 * 4. 命中：立即用缓存重建 AxiosResponse（config 取运行时 config）
 * 5. 命中且 revalidate：返回缓存的同时后台静默刷新，数据不一致则覆盖缓存，并发出 diff 事件
 */
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

// 判断是否为配额超限错误：DOMException 规范名或 W3C 旧版 code 22
function isQuotaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: unknown; code?: unknown }
  return e.name === 'QuotaExceededError' || e.code === 22
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
  } catch (err) {
    // 仅配额超限才清库重试；DataCloneError 等其它写入错误直接放弃，
    // 避免反复清空全部正常缓存。
    if (!isQuotaError(err)) return
    try {
      await state.stores.cache.clear()
      await state.stores.cache.setItem(key, entry)
    } catch {
      /* 放弃写入 */
    }
  }
}

// 条目结构校验：非对象、response 缺失/为 null、response 缺 data/status、
// expireAt 非数字均视为损坏（旧版本半成品写入、回写中断、结构升级等），
// 按 spec 第 6 节"读缓存失败/记录损坏视为未命中"处理。
function isUsableEntry(hit: unknown): hit is CacheEntry {
  if (typeof hit !== 'object' || hit === null) return false
  const e = hit as Partial<CacheEntry>
  const r = e.response as { data?: unknown; status?: unknown } | undefined
  return (
    typeof e.expireAt === 'number' &&
    !!r &&
    'data' in r &&
    typeof r.status === 'number'
  )
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

    // miss/过期/force 的回源路径严格为：回源一次 → 2xx 写缓存 → 返回，
    // 不做任何后台刷新。
    const requestNetwork = async (): Promise<AxiosResponse> => {
      const response = await originalAdapter(config)
      const cached = await finalizeNetworkResponse(config, response)
      if (cached) {
        await writeEntry(state, key, cached)
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

    // 结构校验：旧版本（整响应缓存）或损坏/残缺条目一律回源，不抛错
    if (!isUsableEntry(hit)) {
      return requestNetwork()
    }

    const fresh = hit.expireAt === Infinity || hit.expireAt > Date.now()

    if (!fresh) {
      return requestNetwork()
    }

    // 仅命中分支：在清空 transformResponse 之前浅拷贝 config 供后台请求使用。
    // headers 单独复制，避免与主 config 共享 AxiosHeaders 引用后被 mutate。
    let bgConfig: InternalAxiosRequestConfig | null = null
    if (config.revalidate) {
      bgConfig = {
        ...config,
        headers: AxiosHeaders.from(config.headers),
      } as InternalAxiosRequestConfig
      setTimeout(() => {
        void revalidateInBackground(
          state,
          bgConfig as InternalAxiosRequestConfig,
          originalAdapter,
          key,
          hit,
        )
      }, 0)
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
