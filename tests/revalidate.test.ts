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

describe('静默刷新', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('命中后立即返回旧数据，后台请求新数据；不一致时触发 diff 事件并更新缓存', async () => {
    const { instance, network } = makeAxios('rev-diff', [
      { v: 1 },
      { v: 2 },
      { v: 2 },
    ])
    const events: unknown[] = []
    onDiff((e) => events.push(e))

    const first = await instance.get('/a', { cache: true, revalidate: true })
    expect(first.data).toEqual({ v: 1 })

    // 等待静默请求完成
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

    // 缓存已被新数据覆盖：再发一次命中返回新数据（静默请求返回相同数据，不再产生事件）
    const third = await instance.get('/a', { cache: true, revalidate: true })
    expect(third.data).toEqual({ v: 2 })
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(3))
    await new Promise((r) => setTimeout(r, 10))
    expect(events.length).toBe(1)
  })

  it('数据相同时不触发事件，且 TTL 被刷新', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { instance, network } = makeAxios('rev-same', [{ v: 1 }, { v: 1 }, { v: 1 }])
    const listener = vi.fn()
    onDiff(listener)

    await instance.get('/a', { cache: true, revalidate: true })
    // Date 被 mock 但定时器真实：等待后台静默请求落库
    await new Promise((r) => setTimeout(r, 10))
    expect(network).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(600)
    await instance.get('/a', { cache: true, revalidate: true })
    expect(network).toHaveBeenCalledTimes(2)
    expect(listener).not.toHaveBeenCalled()

    // 等待第二次命中的静默请求完成并刷新 TTL
    await new Promise((r) => setTimeout(r, 10))
    expect(network).toHaveBeenCalledTimes(3)

    // TTL 已被刷新：再推进 600（累计 1200 > TTL 1000），缓存仍有效
    vi.advanceTimersByTime(600)
    await instance.get('/a', { cache: true, revalidate: true })
    expect(network).toHaveBeenCalledTimes(3)
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
    onDiff(listener)

    await instance.get('/a', { cache: true, revalidate: true })
    await vi.waitFor(() => expect(call).toBe(2))
    await new Promise((r) => setTimeout(r, 10))
    expect(listener).not.toHaveBeenCalled()

    // 旧缓存仍在
    const res = await instance.get('/a', { cache: true })
    expect(res.data).toEqual({ v: 1 })
  })

  it('订阅回调抛错不影响其他订阅者', async () => {
    const { instance } = makeAxios('rev-throw', [{ v: 1 }, { v: 2 }, { v: 2 }])
    const bad = vi.fn(() => {
      throw new Error('listener boom')
    })
    const good = vi.fn()
    onDiff(bad)
    onDiff(good)

    await instance.get('/a', { cache: true, revalidate: true })
    await vi.waitFor(() => expect(good).toHaveBeenCalled())
    expect(bad).toHaveBeenCalled()
  })
})
