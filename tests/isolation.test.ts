import { describe, it, expect, vi } from 'vitest'
import axios, { AxiosHeaders } from 'axios'
import type { AxiosResponseHeaders, InternalAxiosRequestConfig } from 'axios'
import { cacheRequest, setUserId, clearCache } from '../src/index'
import { createStores } from '../src/storage'
import { hash, stableStringify } from '../src/hash'

function makeAxios(projectCode: string) {
  const instance = axios.create()
  const network = vi.fn(async (config) => ({
    data: { ok: true, url: config.url },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }))
  instance.defaults.adapter = network as never
  return { instance, network }
}

describe('版本与用户隔离', () => {
  it('cache:true 首次请求后命中缓存', async () => {
    const { instance, network } = makeAxios('iso-basic')
    cacheRequest(instance, 'iso-basic', 'v1')
    await instance.get('/a', { cache: true })
    await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledOnce()
  })

  it('发版（cacheKey 变化）后旧缓存失效', async () => {
    const first = makeAxios('iso-release')
    cacheRequest(first.instance, 'iso-release', 'v1')
    await first.instance.get('/a', { cache: true })

    const second = makeAxios('iso-release')
    cacheRequest(second.instance, 'iso-release', 'v2')
    await second.instance.get('/a', { cache: true })
    expect(second.network).toHaveBeenCalledOnce()
  })

  it('setUserId 不一致时清空缓存', async () => {
    const { instance, network } = makeAxios('iso-user')
    cacheRequest(instance, 'iso-user', 'v1')
    await setUserId('u1')
    await instance.get('/a', { cache: true })

    await setUserId('u2')
    await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('相同 userId 不清缓存', async () => {
    const { instance, network } = makeAxios('iso-user-same')
    cacheRequest(instance, 'iso-user-same', 'v1')
    await setUserId('u1')
    await instance.get('/a', { cache: true })
    await setUserId('u1')
    await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledOnce()
  })

  it('clearCache 清空缓存后重新请求', async () => {
    const { instance, network } = makeAxios('iso-clear')
    cacheRequest(instance, 'iso-clear', 'v1')
    await instance.get('/a', { cache: true })
    await clearCache()
    await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('不同 projectCode 的缓存互不影响', async () => {
    const a = makeAxios('iso-proj-a')
    const b = makeAxios('iso-proj-b')
    cacheRequest(a.instance, 'iso-proj-a', 'v1')
    cacheRequest(b.instance, 'iso-proj-b', 'v1')
    await a.instance.get('/shared', { cache: true })
    await b.instance.get('/shared', { cache: true })
    expect(a.network).toHaveBeenCalledOnce()
    expect(b.network).toHaveBeenCalledOnce()
  })

  it('projectCode 缺失时同步抛错', () => {
    const { instance } = makeAxios('iso-throw')
    expect(() => cacheRequest(instance, '', 'v1')).toThrow(TypeError)
  })

  it('非幂等 transformResponse 只执行一次，命中数据与首次一致', async () => {
    const instance = axios.create()
    let calls = 0
    instance.defaults.transformResponse = [
      (d) => {
        calls++
        return { wrapped: d }
      },
    ]
    const network = vi.fn(async (config) => ({
      data: { raw: 1 },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }))
    instance.defaults.adapter = network as never
    cacheRequest(instance, 'iso-transform', 'v1')
    const first = await instance.get('/a', { cache: true })
    expect(calls).toBe(1)
    const second = await instance.get('/a', { cache: true })
    expect(calls).toBe(1)
    expect(second.data).toEqual(first.data)
    expect(second.data).toEqual({ wrapped: { raw: 1 } })
  })

  it('命中响应携带运行时 config（含函数与 url）', async () => {
    const { instance } = makeAxios('iso-runtime-config')
    cacheRequest(instance, 'iso-runtime-config', 'v1')
    await instance.get('/a', { cache: true })
    const res = await instance.get('/a', { cache: true })
    expect(res.config.url).toBe('/a')
    expect(typeof res.config.adapter).toBe('function')
  })

  it('命中响应保留 headers（AxiosHeaders 转普通对象可访问）', async () => {
    const instance = axios.create()
    const network = vi.fn(async (config) => ({
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: AxiosHeaders.from({ 'x-test': 'yes' }),
      config,
    }))
    instance.defaults.adapter = network as never
    cacheRequest(instance, 'iso-headers', 'v1')
    const first = await instance.get('/a', { cache: true })
    expect((first.headers as AxiosResponseHeaders).get('x-test')).toBe('yes')
    const second = await instance.get('/a', { cache: true })
    expect((second.headers as AxiosResponseHeaders).get('x-test')).toBe('yes')
    expect(second.config.url).toBe('/a')
  })

  it('首参为普通对象时抛 TypeError', () => {
    expect(() => cacheRequest({} as never, 'iso-bad-arg', 'v1')).toThrow(TypeError)
  })

  it('同一实例重复 cacheRequest 幂等：单层包裹，transform 只执行一次', async () => {
    const instance = axios.create()
    let transforms = 0
    instance.defaults.transformResponse = [
      (d) => {
        transforms++
        return d
      },
    ]
    const network = vi.fn(async (config) => ({
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }))
    instance.defaults.adapter = network as never
    cacheRequest(instance, 'iso-idem', 'v1')
    cacheRequest(instance, 'iso-idem', 'v1')
    await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledOnce()
    expect(transforms).toBe(1)
  })

  it('miss 路径 transform 内 headers 为归一化 AxiosHeaders，命中后业务侧 headers.get 可用', async () => {
    const instance = axios.create()
    const seen: string[] = []
    instance.defaults.transformResponse = [
      (d: unknown, headers: AxiosResponseHeaders) => {
        seen.push(String(headers.get('x-test')))
        return d
      },
    ]
    const network = vi.fn(async (config) => ({
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: { 'X-Test': 'yes' },
      config,
    }))
    instance.defaults.adapter = network as never
    cacheRequest(instance, 'iso-norm-headers', 'v1')
    const first = await instance.get('/a', { cache: true })
    expect(seen).toEqual(['yes'])
    expect((first.headers as AxiosResponseHeaders).get('x-test')).toBe('yes')
    const second = await instance.get('/a', { cache: true })
    // 命中不再执行 transform
    expect(seen).toEqual(['yes'])
    expect(typeof (second.headers as AxiosResponseHeaders).get).toBe('function')
    expect((second.headers as AxiosResponseHeaders).get('x-test')).toBe('yes')
  })

  it('transform 执行期间 config.response 可访问，结束后清除', async () => {
    const instance = axios.create()
    let observed: { status: number; config: { response?: unknown } } | null = null
    instance.defaults.transformResponse = [
      function (this: InternalAxiosRequestConfig, d: unknown) {
        observed = (this as { response?: typeof observed }).response ?? null
        return d
      },
    ]
    const network = vi.fn(async (config) => ({
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }))
    instance.defaults.adapter = network as never
    cacheRequest(instance, 'iso-transform-response', 'v1')
    await instance.get('/a', { cache: true })
    expect(observed).not.toBeNull()
    const obs = observed as unknown as {
      status: number
      config: { response?: unknown }
    }
    expect(obs.status).toBe(200)
    // finally 中 delete config.response
    expect(obs.config.response).toBeUndefined()
  })

  it('旧结构缓存条目（整响应）回源而非返回残缺响应', async () => {
    const { instance, network } = makeAxios('iso-stale-entry')
    cacheRequest(instance, 'iso-stale-entry', 'v1')
    const stores = createStores('iso-stale-entry')
    // 等待初始化完成
    await stores.meta.getItem('meta')
    const key = hash(
      stableStringify({
        userId: null,
        method: 'get',
        url: '/a',
        params: undefined,
        data: undefined,
      }),
    )
    await stores.cache.setItem(key, {
      data: { stale: true },
      createdAt: 0,
      expireAt: Infinity,
    })
    const res = await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledOnce()
    expect(res.data).toEqual({ ok: true, url: '/a' })
  })
})
