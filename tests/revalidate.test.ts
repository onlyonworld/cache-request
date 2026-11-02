import { describe, it, expect, vi, afterEach } from 'vitest'
import axios from 'axios'
import { cacheRequest, onDiff } from '../src/index'

function makeAxios(projectCode: string, responses: unknown[]) {
  const instance = axios.create()
  let i = 0
  const network = vi.fn(async (config) => {
    const data = responses[Math.min(i++, responses.length - 1)]
    return {
      data,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  })
  instance.defaults.adapter = network as never
  cacheRequest(instance, projectCode, 'v1', { ttl: 1000 })
  return { instance, network }
}

// 等待 50ms，用于确认没有任何额外的（后台）请求发生。
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50))
}

describe('静默刷新', () => {
  const unsubscribes: Array<() => void> = []
  function subscribe(listener: (event: unknown) => void): void {
    unsubscribes.push(onDiff(listener))
  }
  afterEach(() => {
    unsubscribes.forEach((off) => off())
    unsubscribes.length = 0
    vi.useRealTimers()
  })

  it('预热（miss）不触发后台请求；命中后后台刷新，不一致时发 diff 并更新缓存', async () => {
    const { instance, network } = makeAxios('rev-diff', [
      { v: 1 },
      { v: 2 },
      { v: 2 },
    ])
    const events: unknown[] = []
    subscribe((e) => events.push(e))

    // 预热：miss 回源仅 1 次，且不产生任何后台请求
    const warm = await instance.get('/a', { cache: true })
    expect(warm.data).toEqual({ v: 1 })
    expect(network).toHaveBeenCalledTimes(1)
    await settle()
    expect(network).toHaveBeenCalledTimes(1)

    // 命中 + revalidate：立即返回旧数据，后台拿到 {v:2}
    const second = await instance.get('/a', {
      cache: true,
      revalidate: true,
    })
    expect(second.data).toEqual({ v: 1 })
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(events.length).toBe(1))

    const event = events[0] as {
      method: string
      url: string
      oldData: unknown
      newData: unknown
    }
    expect(event.method).toBe('get')
    expect(event.url).toBe('/a')
    expect(event.oldData).toEqual({ v: 1 })
    expect(event.newData).toEqual({ v: 2 })

    // 缓存已被新数据覆盖：再次命中返回新数据（后台相同数据，无新事件）
    const third = await instance.get('/a', {
      cache: true,
      revalidate: true,
    })
    expect(third.data).toEqual({ v: 2 })
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(3))
    await settle()
    expect(events.length).toBe(1)
  })

  it('数据相同时不触发事件，且 TTL 被刷新', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { instance, network } = makeAxios('rev-same', [{ v: 1 }, { v: 1 }])
    const listener = vi.fn()
    subscribe(listener)

    // 预热
    await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledTimes(1)

    // Date 被 mock 但定时器真实：推进 600 后命中触发后台刷新
    vi.advanceTimersByTime(600)
    const hit = await instance.get('/a', { cache: true, revalidate: true })
    expect(hit.data).toEqual({ v: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(network).toHaveBeenCalledTimes(2)
    expect(listener).not.toHaveBeenCalled()

    // 再推进 600（累计 1200 > TTL 1000）：TTL 已被后台刷新，普通请求仍命中
    vi.advanceTimersByTime(600)
    const third = await instance.get('/a', { cache: true })
    expect(third.data).toEqual({ v: 1 })
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('后台请求失败时静默忽略，保留旧缓存', async () => {
    const instance = axios.create()
    let call = 0
    const network = vi.fn(async (config) => {
      call++
      if (call === 2) throw new Error('bg fail')
      return {
        data: { v: 1 },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })
    instance.defaults.adapter = network as never
    cacheRequest(instance, 'rev-fail', 'v1')

    const listener = vi.fn()
    subscribe(listener)

    // 预热
    await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledTimes(1)

    // 命中触发后台刷新，后台抛错
    await instance.get('/a', { cache: true, revalidate: true })
    await vi.waitFor(() => expect(call).toBe(2))
    await settle()
    expect(listener).not.toHaveBeenCalled()

    // 旧缓存仍在，且无额外请求
    const res = await instance.get('/a', { cache: true })
    expect(res.data).toEqual({ v: 1 })
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('订阅回调抛错不影响其他订阅者', async () => {
    const { instance, network } = makeAxios('rev-throw', [{ v: 1 }, { v: 2 }])
    const bad = vi.fn(() => {
      throw new Error('listener boom')
    })
    const good = vi.fn()
    subscribe(bad)
    subscribe(good)

    // 预热
    await instance.get('/a', { cache: true })

    // 命中触发后台刷新，两个订阅者都应被调用（bad 抛错不影响 good）
    await instance.get('/a', { cache: true, revalidate: true })
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(good).toHaveBeenCalled())
    expect(bad).toHaveBeenCalled()
  })
})
