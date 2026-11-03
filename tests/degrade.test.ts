import { describe, it, expect, vi } from 'vitest'
import axios from 'axios'

// 模拟 localforage 完全不可用（如隐私模式抛错）
vi.mock('localforage', () => {
  const broken = () => {
    throw new Error('indexeddb unavailable')
  }
  return {
    default: {
      createInstance: () => ({
        getItem: broken,
        setItem: broken,
        removeItem: broken,
        clear: broken,
        keys: broken,
      }),
    },
  }
})

import { cacheRequest, setUserId } from '../src/index'

function makeAxios() {
  const instance = axios.create()
  const network = vi.fn(async (config) => ({
    data: { ok: true },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }))
  instance.defaults.adapter = network as never
  return { instance, network }
}

describe('降级与幂等', () => {
  it('IndexedDB 不可用时缓存静默降级，请求正常透传', async () => {
    const { instance, network } = makeAxios()
    expect(() => cacheRequest(instance, 'deg-db', 'v1')).not.toThrow()
    const res = await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledOnce()
    expect(res.data).toEqual({ ok: true })
  })

  it('重复 cacheRequest 同一实例不会多层包裹 adapter', async () => {
    const { instance, network } = makeAxios()
    cacheRequest(instance, 'deg-idem', 'v1')
    cacheRequest(instance, 'deg-idem', 'v1')
    cacheRequest(instance, 'deg-idem', 'v2') // 发版重入也只包一层

    await instance.get('/a', { cache: true })
    expect(network).toHaveBeenCalledOnce()
  })

  it('IDB 降级时 setUserId 不 reject，仅内存生效', async () => {
    const { instance } = makeAxios()
    cacheRequest(instance, 'deg-setuser', 'v1')
    await expect(setUserId('u1')).resolves.toBeUndefined()
  })
})
