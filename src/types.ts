import type { AxiosRequestConfig, AxiosResponse } from 'axios'

declare module 'axios' {
  interface AxiosRequestConfig {
    cache?: boolean | { force?: boolean }
    revalidate?: boolean
  }
}

export interface CacheEntry {
  data: AxiosResponse
  createdAt: number
  expireAt: number // Infinity 表示永久
}

export interface MetaRecord {
  version: string
  userId: string | number | null
}

export interface CacheDiffEvent {
  method: string
  url: string
  params?: AxiosRequestConfig['params']
  data?: unknown
  oldData: unknown
  newData: unknown
}
