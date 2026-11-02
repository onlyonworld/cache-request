import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { createStores } from '../src/storage'
import { createAdapter } from '../src/adapter'
import { registerState, type ProjectState } from '../src/state'

vi.setConfig({ testTimeout: 20000 })

const TTL = 1000

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
    expect((res as AxiosResponse & { fromCache?: boolean }).fromCache).toBeUndefined()
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
    vi.useFakeTimers({ toFake: ['Date'] })
    const { network, networkMock, adapter } = setup('core-ttl')
    const config = cfg({ cache: true })

    // 先写入缓存
    await adapter(config)
    // 前进时间超过 TTL
    vi.advanceTimersByTime(TTL + 1)
    // 第二次调用应该走网络
    await adapter(config)
    expect(networkMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('ttl:0 永不过期', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
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
    const adapter = createAdapter(network.adapter, state)

    await adapter(cfg({ cache: true }))
    vi.advanceTimersByTime(10 * 365 * 24 * 3600 * 1000)
    const second = await adapter(cfg({ cache: true }))
    expect(network.mock).toHaveBeenCalledOnce()
    expect((second as AxiosResponse & { fromCache?: boolean }).fromCache).toBe(true)
    vi.useRealTimers()
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

  it('写缓存首次失败：clear 后重试成功', async () => {
    const stores = createStores('core-retry')
    const { adapter: network, mock: networkMock } = makeNetwork()
    const state: ProjectState = {
      projectCode: 'core-retry',
      stores,
      userId: null,
      enabled: true,
      ttl: TTL,
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)

    // spy on setItem to fail once
    const originalSetItem = stores.cache.setItem
    stores.cache.setItem = vi.fn()
      .mockRejectedValueOnce(new Error('Quota exceeded'))
      .mockImplementation(originalSetItem)

    const adapter = createAdapter(network, state)
    await adapter(cfg({ cache: true, params: { a: 1 } }))

    // verify network was called once, and cache eventually has the key
    expect(networkMock).toHaveBeenCalledOnce()
    const keys = await stores.cache.keys()
    expect(keys.length).toBe(1)

    // restore original
    stores.cache.setItem = originalSetItem
  })

  it('写缓存持续失败：放弃写入但请求正常返回', async () => {
    const stores = createStores('core-fail')
    const { adapter: network, mock: networkMock } = makeNetwork()

    // 替换 cache 的 setItem 为永远失败的函数
    const originalCache = stores.cache
    const mockCache = {
      ...originalCache,
      setItem: vi.fn().mockRejectedValue(new Error('Permanent error')),
      clear: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue([]),
    }
    // @ts-ignore - replace cache
    stores.cache = mockCache

    const state: ProjectState = {
      projectCode: 'core-fail',
      stores,
      userId: null,
      enabled: true,
      ttl: TTL,
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)
    const adapter = createAdapter(network, state)

    const res = await adapter(cfg({ cache: true, params: { a: 1 } }))

    // verify network was called, request succeeded
    expect(networkMock).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)

    // 检查 setItem 被尝试了多次
    expect(mockCache.setItem).toHaveBeenCalledTimes(2) // initial + retry
    // 检查没有写入缓存
    const keys = await stores.cache.keys() // 可能返回空，因为 mock 没有实际存储
    expect(keys.length).toBe(0)

    // restore original
    stores.cache = originalCache
  })

  it('state.ready 延迟 resolve 时，等待完成后再发起请求', async () => {
    const stores = createStores('core-ready')
    const { adapter: network, mock: networkMock } = makeNetwork()

    // 创建延迟 resolve 的 ready promise
    let resolveReady: () => void
    const ready = new Promise<void>((resolve) => { resolveReady = resolve })

    const state: ProjectState = {
      projectCode: 'core-ready',
      stores,
      userId: null,
      enabled: true,
      ttl: TTL,
      ready,
      userOp: null,
    }
    registerState(state)
    const adapter = createAdapter(network, state)

    // 在 ready resolve 前调用 adapter
    const promise = adapter(cfg({ cache: true }))

    // 此时还未调用 network
    expect(networkMock).not.toHaveBeenCalled()

    // resolve ready
    resolveReady!()
    await promise

    // network 应该被调用
    expect(networkMock).toHaveBeenCalledOnce()
  })
})
