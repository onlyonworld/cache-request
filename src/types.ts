import type { AxiosRequestConfig, AxiosResponse } from 'axios'

/**
 * 扩展 axios 请求配置（本包新增的三个字段）：
 * - cache：是否开启缓存（默认全部不缓存，必须显式开启）；
 *   传 { force: true } 表示强制走网络并覆盖缓存
 * - revalidate：命中缓存后是否在后台静默刷新
 * - ignoreParams：计算缓存 key 时需要忽略的顶层参数名（如 v、t）
 */
declare module 'axios' {
  interface AxiosRequestConfig {
    cache?: boolean | { force?: boolean }
    revalidate?: boolean
    ignoreParams?: string[]
  }
}

/** 实际持久化的响应内容。config 不入库（含函数无法结构化克隆），
 *  命中时用业务方当次请求的运行时 config 重建 AxiosResponse。 */
export interface CachedResponse {
  data: unknown
  status: number
  statusText: string
  headers: unknown // 普通对象形式（AxiosHeaders.toJSON 的结果）
}

/** cache store 中的一条接口缓存 */
export interface CacheEntry {
  response: CachedResponse
  createdAt: number
  expireAt: number // 过期时间戳；Infinity 表示永久（ttl: 0）
}

/** meta store 中的项目元信息（固定 key 'meta'，每个项目 DB 一条） */
export interface MetaRecord {
  version: string // 上次写入的 cacheKey，不一致判定为发版
  userId: string | number | null
}

/** 静默刷新发现新旧数据不一致时抛出的事件结构 */
export interface CacheDiffEvent {
  method: string
  url: string
  params?: AxiosRequestConfig['params']
  data?: unknown // 请求参数（POST body）
  oldData: unknown // 旧响应的 data
  newData: unknown // 新响应的 data
}
