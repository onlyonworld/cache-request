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
    ignoreParams: [],
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
      ignoreParams: [],
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
      ignoreParams: [],
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
      ignoreParams: [],
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
      ignoreParams: [],
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)
    const adapter = createAdapter(network, state)
    await adapter(cfg({ cache: true }))
    expect(networkMock).toHaveBeenCalledOnce()
  })

  it('写缓存首次配额失败：clear 后重试成功', async () => {
    const stores = createStores('core-retry')
    const { adapter: network, mock: networkMock } = makeNetwork()

    // 用可控 mock 替换 cache：首次 setItem 抛配额错误，重试成功
    const originalCache = stores.cache
    const clearSpy = vi.fn().mockResolvedValue(undefined)
    const setItemMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'))
      .mockResolvedValueOnce(undefined)
    // @ts-ignore - replace cache
    stores.cache = {
      ...originalCache,
      setItem: setItemMock,
      clear: clearSpy,
      keys: vi.fn().mockResolvedValue(['k1']),
    }

    const state: ProjectState = {
      projectCode: 'core-retry',
      stores,
      userId: null,
      enabled: true,
      ttl: TTL,
      ignoreParams: [],
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)

    const adapter = createAdapter(network, state)
    await adapter(cfg({ cache: true, params: { a: 1 } }))

    // network 一次；配额错误触发 clear 并重试（setItem 2 次）
    expect(networkMock).toHaveBeenCalledOnce()
    expect(clearSpy).toHaveBeenCalledOnce()
    expect(setItemMock).toHaveBeenCalledTimes(2)

    stores.cache = originalCache
  })

  it('DataCloneError 写入失败：直接放弃，不清库不重试', async () => {
    const stores = createStores('core-dataclone')
    const { adapter: network, mock: networkMock } = makeNetwork()

    const originalCache = stores.cache
    const mockCache = {
      ...originalCache,
      setItem: vi.fn().mockRejectedValue(new DOMException('clone fail', 'DataCloneError')),
      clear: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue([]),
    }
    // @ts-ignore - replace cache
    stores.cache = mockCache

    const state: ProjectState = {
      projectCode: 'core-dataclone',
      stores,
      userId: null,
      enabled: true,
      ttl: TTL,
      ignoreParams: [],
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)
    const adapter = createAdapter(network, state)

    const res = await adapter(cfg({ cache: true, params: { a: 1 } }))

    // 请求正常返回
    expect(networkMock).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
    // 只尝试一次写入，未 clear、未重试
    expect(mockCache.setItem).toHaveBeenCalledOnce()
    expect(mockCache.clear).not.toHaveBeenCalled()

    stores.cache = originalCache
  })

  it('写缓存遇非配额错误：放弃写入但请求正常返回', async () => {
    const stores = createStores('core-fail')
    const { adapter: network, mock: networkMock } = makeNetwork()

    // 替换 cache 的 setItem 为永远失败的函数（非配额错误）
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
      ignoreParams: [],
      ready: Promise.resolve(),
      userOp: null,
    }
    registerState(state)
    const adapter = createAdapter(network, state)

    const res = await adapter(cfg({ cache: true, params: { a: 1 } }))

    // verify network was called, request succeeded
    expect(networkMock).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)

    // 非配额错误：只尝试一次，不 clear、不重试
    expect(mockCache.setItem).toHaveBeenCalledOnce()
    expect(mockCache.clear).not.toHaveBeenCalled()
    const keys = await stores.cache.keys() // mock 无实际存储，返回空
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
      ignoreParams: [],
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

describe('损坏条目视为未命中（不抛 TypeError，回源修复）', () => {
  // 先发一次正常请求建立 key，再用残缺记录覆盖同 key
  async function seedCorrupt(projectCode: string, corruptEntry: unknown) {
    const { stores, networkMock, adapter } = setup(projectCode)
    const config = cfg({ cache: true, params: { a: 1 } })
    await adapter(config)
    expect(networkMock).toHaveBeenCalledOnce()
    const key = (await stores.cache.keys())[0] as string
    await stores.cache.setItem(key, corruptEntry as never)
    return { stores, networkMock, adapter, config }
  }

  it('a. { response: null } 残缺记录：回源正常返回，不抛错', async () => {
    const { networkMock, adapter, config } = await seedCorrupt('corrupt-null', {
      response: null,
      expireAt: Infinity,
      createdAt: 0,
    })
    const res = await adapter(config)
    expect(networkMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
    expect((res as AxiosResponse & { fromCache?: boolean }).fromCache).toBeUndefined()
  })

  it('b. response 缺 status：回源正常返回，不抛错', async () => {
    const { networkMock, adapter, config } = await seedCorrupt('corrupt-no-status', {
      response: { data: 1 },
      expireAt: Infinity,
      createdAt: 0,
    })
    const res = await adapter(config)
    expect(networkMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
  })

  it('c. 正常条目仍命中缓存', async () => {
    const { networkMock, adapter, config } = await seedCorrupt('corrupt-ok', {
      response: {
        data: { url: '/x', params: { a: 1 }, body: undefined },
        status: 200,
        statusText: 'OK',
        headers: {},
      },
      expireAt: Infinity,
      createdAt: 0,
    })
    const res = await adapter(config)
    expect(networkMock).toHaveBeenCalledOnce()
    expect((res as AxiosResponse & { fromCache?: boolean }).fromCache).toBe(true)
    expect(res.data).toEqual({ url: '/x', params: { a: 1 }, body: undefined })
  })
})
