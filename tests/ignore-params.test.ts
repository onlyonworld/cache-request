import { describe, it, expect, vi } from 'vitest'
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

function setup(projectCode: string, ignoreParams: string[] = []) {
  const stores = createStores(projectCode)
  const { adapter: network, mock: networkMock } = makeNetwork()
  const state: ProjectState = {
    projectCode,
    stores,
    userId: null,
    enabled: true,
    ttl: TTL,
    ignoreParams,
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

describe('ignoreParams 忽略参数', () => {
  it('全局 ignoreParams：不同 v 的 GET 请求命中同一缓存', async () => {
    const { networkMock, adapter } = setup('ip-global', ['v'])
    await adapter(cfg({ cache: true, params: { a: 1, v: 'aaa' } }))
    await adapter(cfg({ cache: true, params: { a: 1, v: 'bbb' } }))
    expect(networkMock).toHaveBeenCalledOnce()
  })

  it('data 顶层的 v 在 POST 时同样被忽略', async () => {
    const { networkMock, adapter } = setup('ip-data', ['v'])
    await adapter(cfg({ cache: true, method: 'post', data: { a: 1, v: 'aaa' } }))
    await adapter(cfg({ cache: true, method: 'post', data: { a: 1, v: 'bbb' } }))
    expect(networkMock).toHaveBeenCalledOnce()
  })

  it('单请求 ignoreParams 生效', async () => {
    const { networkMock, adapter } = setup('ip-per')
    await adapter(cfg({ cache: true, ignoreParams: ['v'], params: { a: 1, v: 'aaa' } }))
    await adapter(cfg({ cache: true, ignoreParams: ['v'], params: { a: 1, v: 'bbb' } }))
    expect(networkMock).toHaveBeenCalledOnce()
  })

  it('全局与单请求取并集：全局 t + 请求 v，两者都被忽略', async () => {
    const { networkMock, adapter } = setup('ip-union', ['t'])
    await adapter(
      cfg({ cache: true, ignoreParams: ['v'], params: { a: 1, v: 'aaa', t: '111' } }),
    )
    await adapter(
      cfg({ cache: true, ignoreParams: ['v'], params: { a: 1, v: 'bbb', t: '222' } }),
    )
    expect(networkMock).toHaveBeenCalledOnce()
  })

  it('真实请求的 config 未被篡改：originalAdapter 收到的 params 仍含 v', async () => {
    const { networkMock, adapter } = setup('ip-raw', ['v'])
    const original = cfg({
      cache: true,
      ignoreParams: ['t'],
      params: { a: 1, v: 'aaa', t: '111' },
      data: { v: 'aaa' },
    })
    await adapter(original)
    expect(networkMock).toHaveBeenCalledOnce()
    const passed = networkMock.mock.calls[0][0] as InternalAxiosRequestConfig
    expect(passed.params).toBe(original.params)
    expect(passed.params).toEqual({ a: 1, v: 'aaa', t: '111' })
    expect(passed.data).toEqual({ v: 'aaa' })
    // 原 config 对象本身也未被修改
    expect(original.params).toEqual({ a: 1, v: 'aaa', t: '111' })
  })

  it('不忽略时，不同 v 不命中（2 次 network）', async () => {
    const { networkMock, adapter } = setup('ip-none')
    await adapter(cfg({ cache: true, params: { a: 1, v: 'aaa' } }))
    await adapter(cfg({ cache: true, params: { a: 1, v: 'bbb' } }))
    expect(networkMock).toHaveBeenCalledTimes(2)
  })

  it('嵌套对象内的 v 不被忽略（只删顶层）', async () => {
    const { networkMock, adapter } = setup('ip-nested', ['v'])
    await adapter(cfg({ cache: true, params: { a: { v: 'aaa' } } }))
    await adapter(cfg({ cache: true, params: { a: { v: 'bbb' } } }))
    expect(networkMock).toHaveBeenCalledTimes(2)
  })

  it('非对象 params/data（字符串 body、FormData）不处理，按原值参与 key', async () => {
    const { networkMock, adapter } = setup('ip-nonobj', ['v'])
    await adapter(cfg({ cache: true, method: 'post', data: 'body-aaa' }))
    await adapter(cfg({ cache: true, method: 'post', data: 'body-bbb' }))
    expect(networkMock).toHaveBeenCalledTimes(2)

    const form = setup('ip-form', ['v'])
    const fd1 = new FormData()
    fd1.append('v', 'aaa')
    const fd2 = new FormData()
    fd2.append('v', 'bbb')
    await form.adapter(cfg({ cache: true, method: 'post', data: fd1 }))
    await form.adapter(cfg({ cache: true, method: 'post', data: fd2 }))
    // FormData 不可稳定序列化 -> key 为 null -> 均透传
    expect(form.networkMock).toHaveBeenCalledTimes(2)
  })
})
