import { describe, it, expect, vi } from 'vitest'
import axios from 'axios'
import { cacheRequest, setUserId, clearCache } from '../src/index'

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
})
