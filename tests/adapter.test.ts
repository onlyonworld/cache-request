import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { createStores } from '../src/storage'
import { createAdapter } from '../src/adapter'
import { registerState, type ProjectState } from '../src/state'

const TTL = 100

function makeNetwork(): { adapter: AxiosAdapter; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async (config: InternalAxiosRequestConfig) => ({
    data: { url: config.url, params: config.params, body: config.data },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }) as AxiosResponse)
  return { adapter: mock as unknown as AxiosAdapter, mock }
}

function setup(projectCode: string) {
  const stores = createStores(projectCode)
  const { adapter: network, mock: networkMock } = makeNetwork()
  const state: ProjectState = {
    projectCode,
    stores,
    userId: null,
    enabled: true,
    ttl: TTL,
    ready: Promise.resolve(),
    userOp: null,
  }
  registerState(state)
  const adapter = createAdapter(network, state)
  return { stores, network, networkMock, adapter }
}

function cfg(over: Partial<InternalAxiosRequestConfig>): InternalAxiosRequestConfig {
  return { method: 'get', url: '/x', ...over } as InternalAxiosRequestConfig
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('adapter 核心流程', () => {
  it('未配置 cache：纯透传，不写缓存', async () => {
    const { network, networkMock, adapter } = setup('core-none')
    const res = await adapter(cfg({}))
    expect(networkMock).toHaveBeenCalledOnce()
    expect((res as AxiosResponse).fromCache).toBeUndefined()
  })

  it('cache:true 首次请求走网络并写入缓存', async () => {
    const { stores, network, networkMock, adapter } = setup('core-miss')
    await adapter(cfg({ cache: true, params: { a: 1 } }))
    expect(networkMock).toHaveBeenCalledOnce()
    const keys = await stores.cache.keys()
    expect(keys.length).toBe(1)
  })

  it('相同请求第二次命中缓存，不再调用网络', async () => {
    const { network, networkMock, adapter } = setup('core-hit')
    const config = cfg({ cache: true, params: { a: 1, b: 2 } })
    await adapter(config)
    const res = await adapter(cfg({ cache: true, params: { b: 2, a: 1 } }))
    expect(networkMock).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
    expect((res as AxiosResponse & { fromCache?: boolean }).fromCache).toBe(true)
  })

  it('参数不同 key 不同', async () => {
    const { network, networkMock, adapter } = setup('core-diff')
    await adapter(cfg({ cache: true, params: { a: 1 } }))
    await adapter(cfg({ cache: true, params: { a: 2 } }))
    expect(networkMock).toHaveBeenCalledTimes(2)
  })

  it('TTL 过期后视为未命中', async () => {
    const { network, networkMock, adapter, stores } = setup('core-ttl')
    // 先写入一个过期的缓存条目
    const config = cfg({ cache: true })
    // 先调用一次写入缓存
    const firstRes = await adapter(config)
    // 修改缓存条目的 expireAt
    const key = 'test-key' // 实际应该是计算后的 key，这里简化
    // 重新实现计算 key
    const { hash, stableStringify } = await import('../src/hash')
    const computedKey = hash(stableStringify({
      userId: null,
      method: config.method,
      url: config.url,
      params: config.params,
      data: config.data,
    }))
    // 获取 entry 并修改 expireAt 为过去时间
    const entry = await stores.cache.getItem(computedKey)
    if (entry) {
      entry.expireAt = Date.now() - 1000 // 过期
      await stores.cache.setItem(computedKey, entry)
    }
    // 第二次调用应该走网络
    const secondRes = await adapter(config)
    expect(networkMock).toHaveBeenCalledTimes(2)
  })

  it('ttl:0 永不过期', async () => {
    const stores = createStores('core-forever')
    const { adapter: network, mock: networkMock } = makeNetwork()
    const state: ProjectState = {
      projectCode: 'core-forever',
      stores,
      userId: null,
      enabled: true,
      ttl: 0,
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)
    const adapter = createAdapter(network, state)
    const config = cfg({ cache: true })
    // 第一次请求
    await adapter(config)
    // 第二次请求，即使过了很久也应该命中缓存，不走网络
    const secondRes = await adapter(config)
    expect(networkMock).toHaveBeenCalledTimes(1)
    expect(secondRes.fromCache).toBe(true)
  })

  it('force:true 强制走网络并覆盖缓存', async () => {
    const { network, networkMock, adapter } = setup('core-force')
    await adapter(cfg({ cache: true }))
    await adapter(cfg({ cache: { force: true } }))
    expect(networkMock).toHaveBeenCalledTimes(2)
  })

  it('FormData 请求透传不缓存', async () => {
    const { network, networkMock, adapter } = setup('core-form')
    await adapter(cfg({ cache: true, method: 'post', data: new FormData() }))
    expect(networkMock).toHaveBeenCalledOnce()
    const stores = createStores('core-form')
    expect(await stores.cache.keys()).toEqual([])
  })

  it('非 2xx 响应不缓存', async () => {
    const stores = createStores('core-500')
    const network = vi.fn(async (c: InternalAxiosRequestConfig) => ({
      data: { error: 'fail' },
      status: 500,
      statusText: 'Error',
      headers: {},
      config: c,
    })) as unknown as AxiosAdapter
    const state: ProjectState = {
      projectCode: 'core-500',
      stores,
      userId: null,
      enabled: true,
      ttl: TTL,
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)
    const adapter = createAdapter(network, state)
    const res = await adapter(cfg({ cache: true }))
    expect(res.status).toBe(500)
    expect(await stores.cache.keys()).toEqual([])
  })

  it('原 adapter 抛错时原样抛出', async () => {
    const stores = createStores('core-throw')
    const network = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as AxiosAdapter
    const state: ProjectState = {
      projectCode: 'core-throw',
      stores,
      userId: null,
      enabled: true,
      ttl: TTL,
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)
    const adapter = createAdapter(network, state)
    await expect(adapter(cfg({ cache: true }))).rejects.toThrow('network down')
  })

  it('enabled 为 false 时纯透传', async () => {
    const stores = createStores('core-disabled')
    const { adapter: network, mock: networkMock } = makeNetwork()
    const state: ProjectState = {
      projectCode: 'core-disabled',
      stores,
      userId: null,
      enabled: false,
      ttl: TTL,
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)
    const adapter = createAdapter(network, state)
    await adapter(cfg({ cache: true }))
    expect(networkMock).toHaveBeenCalledOnce()
  })
})
