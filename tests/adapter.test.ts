import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { createStores } from '../src/storage'
import { createAdapter } from '../src/adapter'
import { registerState, type ProjectState } from '../src/state'

const TTL = 1000

function makeNetwork(): AxiosAdapter & { mock: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (config: InternalAxiosRequestConfig) => ({
    data: { url: config.url, params: config.params, body: config.data },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }) as AxiosResponse)
  return Object.assign(fn as unknown as AxiosAdapter, { mock: fn })
}

function setup(projectCode: string) {
  const stores = createStores(projectCode)
  const network = makeNetwork()
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
  return { stores, network, adapter }
}

function cfg(over: Partial<InternalAxiosRequestConfig>): InternalAxiosRequestConfig {
  return { method: 'get', url: '/x', ...over } as InternalAxiosRequestConfig
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('adapter 核心流程', () => {
  it('未配置 cache：纯透传，不写缓存', async () => {
    const { network, adapter } = setup('core-none')
    const res = await adapter(cfg({}))
    expect(network.mock).toHaveBeenCalledOnce()
    expect((res as AxiosResponse).fromCache).toBeUndefined()
  })

  it('cache:true 首次请求走网络并写入缓存', async () => {
    const { stores, network, adapter } = setup('core-miss')
    await adapter(cfg({ cache: true, params: { a: 1 } }))
    expect(network.mock).toHaveBeenCalledOnce()
    const keys = await stores.cache.keys()
    expect(keys.length).toBe(1)
  })

  it('相同请求第二次命中缓存，不再调用网络', async () => {
    const { network, adapter } = setup('core-hit')
    const config = cfg({ cache: true, params: { a: 1, b: 2 } })
    await adapter(config)
    const res = await adapter(cfg({ cache: true, params: { b: 2, a: 1 } }))
    expect(network.mock).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
    expect((res as AxiosResponse & { fromCache?: boolean }).fromCache).toBe(true)
  })

  it('参数不同 key 不同', async () => {
    const { network, adapter } = setup('core-diff')
    await adapter(cfg({ cache: true, params: { a: 1 } }))
    await adapter(cfg({ cache: true, params: { a: 2 } }))
    expect(network.mock).toHaveBeenCalledTimes(2)
  })

  it('TTL 过期后视为未命中', async () => {
    vi.useFakeTimers()
    const { network, adapter } = setup('core-ttl')
    await adapter(cfg({ cache: true }))
    vi.advanceTimersByTime(TTL + 1)
    await adapter(cfg({ cache: true }))
    expect(network.mock).toHaveBeenCalledTimes(2)
  })

  it('ttl:0 永不过期', async () => {
    vi.useFakeTimers()
    const stores = createStores('core-forever')
    const network = makeNetwork()
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
    await adapter(cfg({ cache: true }))
    vi.advanceTimersByTime(10 * 365 * 24 * 3600 * 1000)
    await adapter(cfg({ cache: true }))
    expect(network.mock).toHaveBeenCalledOnce()
  })

  it('force:true 强制走网络并覆盖缓存', async () => {
    const { network, adapter } = setup('core-force')
    await adapter(cfg({ cache: true }))
    await adapter(cfg({ cache: { force: true } }))
    expect(network.mock).toHaveBeenCalledTimes(2)
  })

  it('FormData 请求透传不缓存', async () => {
    const { network, adapter } = setup('core-form')
    await adapter(cfg({ cache: true, method: 'post', data: new FormData() }))
    expect(network.mock).toHaveBeenCalledOnce()
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
    const network = makeNetwork()
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
    expect(network.mock).toHaveBeenCalledOnce()
  })
})
