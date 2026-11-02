# cache-request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个劫持 axios 请求的运行时库，按 method+url+params+data 计算 hash，将响应缓存于 IndexedDB（经 localforage），支持 TTL、发版清缓存、userId 隔离、静默刷新与差异订阅。

**Architecture:** `cacheRequest(axiosInstance, projectCode, cacheKey)` 修改实例的 `defaults.adapter`，包裹原 adapter。每个 projectCode 使用独立的 IndexedDB 数据库（`cache-request-${projectCode}`），内含 cache / meta 两个 store。hash 与稳定序列化零依赖、同步实现。

**Tech Stack:** TypeScript 5, axios 1.x (peer dep), localforage, Vitest, fake-indexeddb, tsup

## Global Constraints

- 运行时唯一第三方依赖：`localforage`；axios 为 peer dependency（`^1.0.0`）
- 默认 **所有请求不缓存**，必须请求 config 中显式 `cache: true`
- 默认 TTL = `24 * 60 * 60 * 1000`（1 天）；`ttl: 0` 表示永久缓存
- 只缓存 2xx 响应；包自身永不因缓存逻辑抛出影响业务请求的错误
- 含 FormData/File/Blob/ArrayBuffer/函数/Symbol/循环引用等不可稳定序列化参数的请求一律透传不缓存
- 不提供构建期替换 `{{{cacheKey}}}` 的插件，仅在 README 说明
- 环境：Node v20.12.2，npm 7.19.1，Windows + Git Bash

## File Structure

```
package.json
tsconfig.json
tsup.config.ts
vitest.config.ts
README.md
src/
  index.ts            # 对外导出：cacheRequest/setUserId/clearCache/onDiff/offDiff
  types.ts            # CacheEntry / MetaRecord / CacheDiffEvent + axios 类型扩展
  hash.ts             # stableStringify + hash + NonSerializableError
  storage.ts          # createStores / initProject
  state.ts            # ProjectState 注册表（多项目、current project）
  events.ts           # diff 事件订阅
  adapter.ts          # createAdapter：核心缓存逻辑
  test-helpers.ts     # 仅测试用（不导出到包入口）
tests/
  hash.test.ts
  storage.test.ts
  adapter.test.ts
  isolation.test.ts
  revalidate.test.ts
  degrade.test.ts
```

---

### Task 1: 项目脚手架 + hash/稳定序列化

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/hash.ts`, `src/types.ts`
- Test: `tests/hash.test.ts`

**Interfaces:**
- Produces:
  - `stableStringify(value: unknown): string`
  - `hash(input: string): string`（8 位 hex）
  - `class NonSerializableError extends Error`

- [ ] **Step 1: 创建脚手架文件**

`package.json`:

```json
{
  "name": "cache-request",
  "version": "0.1.0",
  "description": "劫持 axios 请求，将响应缓存于 IndexedDB",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "peerDependencies": {
    "axios": "^1.0.0"
  },
  "dependencies": {
    "localforage": "^1.10.0"
  }
}
```

devDependencies 由 Step 2 的 `npm install -D` 自动写入，不要手动添加其他条目。

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
})
```

`tests/setup.ts`:

```ts
import 'fake-indexeddb/auto'
```

- [ ] **Step 2: 安装依赖**

Run:

```bash
npm install
npm install -D axios typescript tsup vitest fake-indexeddb @types/node
```

Expected: 安装成功，`node_modules` 出现；确认 `package.json` 中 dependencies 只有 localforage、peerDependencies 为 axios。

- [ ] **Step 3: 编写失败测试**

`tests/hash.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { stableStringify, hash, NonSerializableError } from '../src/hash'

describe('stableStringify', () => {
  it('对象 key 顺序不影响结果', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
  })

  it('嵌套对象同样按 key 排序', () => {
    expect(stableStringify({ z: { y: 1, x: 2 } })).toBe(
      stableStringify({ z: { x: 2, y: 1 } }),
    )
  })

  it('数组顺序敏感', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
  })

  it('区分 undefined 与缺失值的处理是稳定的', () => {
    expect(stableStringify({ a: undefined })).toBe(stableStringify({ a: undefined }))
  })

  it('遇到 FormData 抛 NonSerializableError', () => {
    expect(() => stableStringify({ fd: new FormData() })).toThrow(NonSerializableError)
  })

  it('遇到 Blob 抛 NonSerializableError', () => {
    expect(() => stableStringify({ b: new Blob(['x']) })).toThrow(NonSerializableError)
  })

  it('循环引用抛 NonSerializableError', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => stableStringify(a)).toThrow(NonSerializableError)
  })

  it('函数抛 NonSerializableError', () => {
    expect(() => stableStringify({ fn: () => 1 })).toThrow(NonSerializableError)
  })

  it('Map/Set 抛 NonSerializableError', () => {
    expect(() => stableStringify(new Map([['a', 1]]))).toThrow(NonSerializableError)
    expect(() => stableStringify(new Set([1]))).toThrow(NonSerializableError)
  })
})

describe('hash', () => {
  it('相同输入得到相同 hash', () => {
    expect(hash('hello')).toBe(hash('hello'))
  })

  it('不同输入大概率不同 hash', () => {
    expect(hash('hello')).not.toBe(hash('world'))
  })

  it('输出为 8 位 hex', () => {
    expect(hash('abc')).toMatch(/^[0-9a-f]{8}$/)
  })
})
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run tests/hash.test.ts`
Expected: FAIL，模块 `../src/hash` 不存在。

- [ ] **Step 5: 实现 types.ts 与 hash.ts**

`src/types.ts`:

```ts
import type { AxiosRequestConfig, AxiosResponse } from 'axios'

declare module 'axios' {
  interface AxiosRequestConfig {
    cache?: boolean | { force?: boolean }
    revalidate?: boolean
  }
}

export interface CacheEntry {
  data: AxiosResponse
  createdAt: number
  expireAt: number // Infinity 表示永久
}

export interface MetaRecord {
  version: string
  userId: string | number | null
}

export interface CacheDiffEvent {
  method: string
  url: string
  params?: AxiosRequestConfig['params']
  data?: unknown
  oldData: unknown
  newData: unknown
}
```

`src/hash.ts`:

```ts
export class NonSerializableError extends Error {
  constructor(message = 'value is not stably serializable') {
    super(message)
    this.name = 'NonSerializableError'
  }
}

type Seen = WeakSet<object>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isUnsupported(value: unknown): boolean {
  const g = globalThis as Record<string, unknown>
  if (typeof FormData !== 'undefined' && value instanceof FormData) return true
  if (typeof File !== 'undefined' && value instanceof File) return true
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return true
  void g
  return false
}

function stringifyValue(value: unknown, seen: Seen): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const t = typeof value
  if (t === 'string') return JSON.stringify(value)
  if (t === 'number' || t === 'boolean') return String(value)
  if (t === 'bigint') return `bigint:${(value as bigint).toString()}`
  if (t === 'function' || t === 'symbol') throw new NonSerializableError()

  const obj = value as object
  if (isUnsupported(value)) throw new NonSerializableError()
  if (!isPlainObject(value) && !Array.isArray(value)) {
    // Date / Map / Set / RegExp / DOM 节点等一律拒绝
    throw new NonSerializableError()
  }
  if (seen.has(obj)) throw new NonSerializableError('circular reference')
  seen.add(obj)

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyValue(item, seen)).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stringifyValue(value[k], seen)}`)
    .join(',')}}`
}

export function stableStringify(value: unknown): string {
  return stringifyValue(value, new WeakSet())
}

export function hash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/hash.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts tests/setup.ts tests/hash.test.ts src/hash.ts src/types.ts
git commit -m "feat: scaffold project and add stable stringify/hash utils"
```

---

### Task 2: 存储层（localforage 实例与初始化校验）

**Files:**
- Create: `src/storage.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Consumes: `MetaRecord`（`src/types.ts`）
- Produces:
  - `interface ProjectStores { projectCode: string; cache: LocalForage; meta: LocalForage }`
  - `createStores(projectCode: string): ProjectStores`
  - `initProject(stores: ProjectStores, cacheKey: string): Promise<{ userId: string | number | null; cleared: boolean }>`

- [ ] **Step 1: 编写失败测试**

`tests/storage.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createStores, initProject } from '../src/storage'

describe('initProject', () => {
  it('首次使用写入 meta，不清缓存', async () => {
    const stores = createStores('test-first')
    const result = await initProject(stores, 'v1')
    expect(result.cleared).toBe(false)
    expect(result.userId).toBeNull()
    expect(await stores.meta.getItem('meta')).toEqual({ version: 'v1', userId: null })
  })

  it('cacheKey 不变时不清缓存', async () => {
    const stores = createStores('test-same')
    await initProject(stores, 'v1')
    await stores.cache.setItem('k', { x: 1 })
    const result = await initProject(stores, 'v1')
    expect(result.cleared).toBe(false)
    expect(await stores.cache.getItem('k')).toEqual({ x: 1 })
  })

  it('cacheKey 变化（发版）清空 cache 并更新 version，保留 userId', async () => {
    const stores = createStores('test-version')
    await initProject(stores, 'v1')
    await stores.meta.setItem('meta', { version: 'v1', userId: 'u1' })
    await stores.cache.setItem('k', { x: 1 })
    const result = await initProject(stores, 'v2')
    expect(result.cleared).toBe(true)
    expect(result.userId).toBe('u1')
    expect(await stores.cache.getItem('k')).toBeNull()
    expect(await stores.meta.getItem('meta')).toEqual({ version: 'v2', userId: 'u1' })
  })

  it('不同 projectCode 使用不同数据库，互不影响', async () => {
    const a = createStores('project-a')
    const b = createStores('project-b')
    await initProject(a, 'v1')
    await initProject(b, 'v9')
    await a.cache.setItem('shared-key', { from: 'a' })
    expect(await b.cache.getItem('shared-key')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL，`../src/storage` 不存在。

- [ ] **Step 3: 实现 storage.ts**

`src/storage.ts`:

```ts
import localforage from 'localforage'
import type { MetaRecord } from './types'

export interface ProjectStores {
  projectCode: string
  cache: LocalForage
  meta: LocalForage
}

export function createStores(projectCode: string): ProjectStores {
  const name = `cache-request-${projectCode}`
  return {
    projectCode,
    cache: localforage.createInstance({ name, storeName: 'cache' }),
    meta: localforage.createInstance({ name, storeName: 'meta' }),
  }
}

export async function initProject(
  stores: ProjectStores,
  cacheKey: string,
): Promise<{ userId: string | number | null; cleared: boolean }> {
  const record = await stores.meta.getItem<MetaRecord>('meta')

  if (!record) {
    const initial: MetaRecord = { version: cacheKey, userId: null }
    await stores.meta.setItem('meta', initial)
    return { userId: null, cleared: false }
  }

  if (record.version !== cacheKey) {
    await stores.cache.clear()
    const next: MetaRecord = { ...record, version: cacheKey }
    await stores.meta.setItem('meta', next)
    return { userId: record.userId, cleared: true }
  }

  return { userId: record.userId, cleared: false }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/storage.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/storage.ts tests/storage.test.ts
git commit -m "feat: add localforage storage layer with version init check"
```

---

### Task 3: 项目状态注册表 + 缓存 adapter 核心流程

**Files:**
- Create: `src/state.ts`, `src/adapter.ts`
- Test: `tests/adapter.test.ts`

**Interfaces:**
- Consumes:
  - `createStores / ProjectStores`（Task 2）
  - `stableStringify / hash / NonSerializableError`（Task 1）
  - `CacheEntry`（`src/types.ts`）
- Produces:
  - `interface ProjectState { projectCode: string; stores: ProjectStores; userId: string | number | null; enabled: boolean; ttl: number; ready: Promise<void>; userOp: Promise<void> | null }`
  - `registerState(state: ProjectState): void`
  - `getState(projectCode: string): ProjectState`
  - `createAdapter(originalAdapter: AxiosAdapter, state: ProjectState): AxiosAdapter`

- [ ] **Step 1: 编写失败测试**

`tests/adapter.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/adapter.test.ts`
Expected: FAIL，`../src/state` / `../src/adapter` 不存在。

- [ ] **Step 3: 实现 state.ts**

`src/state.ts`:

```ts
import type { ProjectStores } from './storage'

export interface ProjectState {
  projectCode: string
  stores: ProjectStores
  userId: string | number | null
  enabled: boolean
  ttl: number
  ready: Promise<void>
  userOp: Promise<void> | null
}

const states = new Map<string, ProjectState>()

export function registerState(state: ProjectState): void {
  states.set(state.projectCode, state)
}

export function getState(projectCode: string): ProjectState {
  const state = states.get(projectCode)
  if (!state) throw new Error(`cache-request not initialized for project: ${projectCode}`)
  return state
}
```

- [ ] **Step 4: 实现 adapter.ts**

`src/adapter.ts`:

```ts
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { hash, stableStringify } from './hash'
import type { CacheEntry } from './types'
import type { ProjectState } from './state'

function computeKey(state: ProjectState, config: InternalAxiosRequestConfig): string | null {
  try {
    return hash(
      stableStringify({
        userId: state.userId,
        method: config.method,
        url: config.url,
        params: config.params,
        data: config.data,
      }),
    )
  } catch {
    return null
  }
}

async function writeEntry(
  state: ProjectState,
  key: string,
  response: AxiosResponse,
): Promise<void> {
  const now = Date.now()
  const entry: CacheEntry = {
    data: response,
    createdAt: now,
    expireAt: state.ttl === 0 ? Infinity : now + state.ttl,
  }
  try {
    await state.stores.cache.setItem(key, entry)
  } catch {
    // 配额超限等：清库后重试一次
    try {
      await state.stores.cache.clear()
      await state.stores.cache.setItem(key, entry)
    } catch {
      /* 放弃写入 */
    }
  }
}

export function createAdapter(
  originalAdapter: AxiosAdapter,
  state: ProjectState,
): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    await state.ready
    if (state.userOp) await state.userOp

    const cacheOption = config.cache
    if (!state.enabled || !cacheOption) {
      return originalAdapter(config)
    }

    const key = computeKey(state, config)
    if (key === null) {
      return originalAdapter(config)
    }

    const force = typeof cacheOption === 'object' && cacheOption.force === true

    const requestNetwork = async (): Promise<AxiosResponse> => {
      const response = await originalAdapter(config)
      if (response.status >= 200 && response.status < 300) {
        await writeEntry(state, key, response)
      }
      return response
    }

    if (force) {
      return requestNetwork()
    }

    let hit: CacheEntry | null = null
    try {
      hit = await state.stores.cache.getItem<CacheEntry>(key)
    } catch {
      hit = null
    }

    const fresh =
      hit !== null && (hit.expireAt === Infinity || hit.expireAt > Date.now())

    if (!fresh) {
      return requestNetwork()
    }

    const response = hit.data as AxiosResponse & { fromCache?: boolean }
    response.fromCache = true
    return response
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/adapter.test.ts`
Expected: PASS（全部 11 个用例）

- [ ] **Step 6: 提交**

```bash
git add src/state.ts src/adapter.ts tests/adapter.test.ts
git commit -m "feat: add cache adapter core flow with TTL and force refresh"
```

---

### Task 4: 入口初始化 + setUserId / clearCache + 隔离

**Files:**
- Create: `src/index.ts`
- Test: `tests/isolation.test.ts`

**Interfaces:**
- Consumes: 全部前序模块
- Produces（包公开 API）:
  - `cacheRequest(axiosInstance: AxiosInstance | AxiosStatic, projectCode: string, cacheKey: string, options?: { ttl?: number }): void`
  - `setUserId(id: string | number | null): Promise<void>`
  - `clearCache(): Promise<void>`
  - `onDiff / offDiff`（Task 5 才加入；本任务先导出占位，实际 Task 5 实现 events 后接入）

- [ ] **Step 1: 编写失败测试**

`tests/isolation.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/isolation.test.ts`
Expected: FAIL，`../src/index` 不存在。

- [ ] **Step 3: 实现 index.ts**

`src/index.ts`:

```ts
import type { AxiosAdapter, AxiosInstance, AxiosStatic } from 'axios'
import { createAdapter } from './adapter'
import { createStores, initProject } from './storage'
import { registerState, type ProjectState } from './state'
import type { MetaRecord } from './types'

export type { CacheDiffEvent, CacheEntry, MetaRecord } from './types'

const DEFAULT_TTL = 24 * 60 * 60 * 1000

// 幂等：实例 -> 其原始 adapter
const originalAdapters = new WeakMap<object, AxiosAdapter>()

let currentProject: string | null = null

function isAxiosLike(value: unknown): value is AxiosInstance | AxiosStatic {
  return typeof value === 'function' && !!(value as AxiosInstance).defaults
}

function resolveOriginalAdapter(
  instance: AxiosInstance | AxiosStatic,
): AxiosAdapter {
  const configured = instance.defaults.adapter
  if (typeof configured === 'function') {
    return configured as AxiosAdapter
  }
  const withGetAdapter = instance as AxiosInstance & {
    getAdapter?: (adapter: unknown) => AxiosAdapter
  }
  if (typeof withGetAdapter.getAdapter === 'function') {
    return withGetAdapter.getAdapter(configured)
  }
  throw new TypeError('cache-request: cannot resolve original axios adapter')
}

export function cacheRequest(
  axiosInstance: AxiosInstance | AxiosStatic,
  projectCode: string,
  cacheKey: string,
  options: { ttl?: number } = {},
): void {
  if (!isAxiosLike(axiosInstance)) {
    throw new TypeError('cache-request: first argument must be an axios instance')
  }
  if (!projectCode) {
    throw new TypeError('cache-request: projectCode is required')
  }

  // 幂等：若该实例已被包裹，先还原原 adapter
  const previous = originalAdapters.get(axiosInstance as object)
  if (previous) {
    axiosInstance.defaults.adapter = previous
  }
  const originalAdapter = resolveOriginalAdapter(axiosInstance)
  originalAdapters.set(axiosInstance as object, originalAdapter)

  const ttl = options.ttl ?? DEFAULT_TTL
  const stores = createStores(projectCode)

  const state: ProjectState = {
    projectCode,
    stores,
    userId: null,
    enabled: true,
    ttl,
    ready: Promise.resolve(),
    userOp: null,
  }

  state.ready = (async () => {
    try {
      const result = await initProject(stores, cacheKey)
      state.userId = result.userId
      state.enabled = true
    } catch {
      state.enabled = false
    }
  })()

  registerState(state)
  currentProject = projectCode
  axiosInstance.defaults.adapter = createAdapter(originalAdapter, state)
}

function requireCurrentState(): ProjectState {
  if (!currentProject) {
    throw new Error('cache-request: call cacheRequest() before using cache controls')
  }
  // 每次从注册表取，确保拿到最新实例
  const { getState } = require('./state') as typeof import('./state')
  return getState(currentProject)
}

export async function setUserId(id: string | number | null): Promise<void> {
  const state = requireCurrentState()
  const op = (async () => {
    await state.ready
    const record = await state.stores.meta.getItem<MetaRecord>('meta')
    if (!record || record.userId !== id) {
      await state.stores.cache.clear()
      const next: MetaRecord = {
        version: record?.version ?? '',
        userId: id,
      }
      await state.stores.meta.setItem('meta', next)
    }
    state.userId = id
  })()
  state.userOp = op
  try {
    await op
  } finally {
    state.userOp = null
  }
}

export async function clearCache(): Promise<void> {
  const state = requireCurrentState()
  await state.ready
  if (state.enabled) {
    await state.stores.cache.clear()
  }
}

// Task 5 将在此追加 onDiff / offDiff 导出
export { onDiff, offDiff } from './events'
```

注意：`require('./state')` 为 ESM 不支持的写法。实现时改为在文件顶部静态导入 `getState`：

```ts
import { getState, registerState, type ProjectState } from './state'
```

`requireCurrentState` 内直接调用 `getState(currentProject)`。events 模块在 Task 5 创建；本任务 Step 4 之前先创建最小的 `src/events.ts`：

```ts
import type { CacheDiffEvent } from './types'

type Listener = (event: CacheDiffEvent) => void
const listeners = new Set<Listener>()

export function onDiff(listener: Listener): () => void {
  listeners.add(listener)
  return () => offDiff(listener)
}

export function offDiff(listener: Listener): void {
  listeners.delete(listener)
}

export function emitDiff(event: CacheDiffEvent): void {
  listeners.forEach((listener) => {
    try {
      listener(event)
    } catch {
      /* 隔离订阅者错误 */
    }
  })
}
```

- [ ] **Step 4: 按注意事项修正 index.ts 导入并创建 events.ts，运行测试**

Run: `npx vitest run tests/isolation.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 运行全部测试**

Run: `npx vitest run`
Expected: PASS（全部已有测试）

- [ ] **Step 6: 提交**

```bash
git add src/index.ts src/events.ts tests/isolation.test.ts
git commit -m "feat: add cacheRequest init with setUserId/clearCache and project isolation"
```

---

### Task 5: 静默刷新（revalidate）与 diff 订阅事件

**Files:**
- Modify: `src/adapter.ts`（命中分支接入 revalidate）
- Test: `tests/revalidate.test.ts`

**Interfaces:**
- Consumes: `emitDiff(event: CacheDiffEvent)`（Task 4 已在 events.ts 中实现）
- Produces: 行为——`{ cache: true, revalidate: true }` 命中时后台刷新

- [ ] **Step 1: 编写失败测试**

`tests/revalidate.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
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
  cacheRequest(instance, projectCode, 'v1')
  return { instance, network }
}

describe('静默刷新', () => {
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
    vi.useFakeTimers()
    const { instance, network } = makeAxios('rev-same', [{ v: 1 }, { v: 1 }])
    const listener = vi.fn()
    onDiff(listener)

    await instance.get('/a', { cache: true, revalidate: true })
    vi.advanceTimersByTime(600)
    await instance.get('/a', { cache: true, revalidate: true })
    expect(network).toHaveBeenCalledTimes(2)
    expect(listener).not.toHaveBeenCalled()

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/revalidate.test.ts`
Expected: FAIL（后台刷新未实现，事件永不触发 / TTL 行为不符）

- [ ] **Step 3: 修改 adapter.ts**

在 `src/adapter.ts` 顶部增加导入：

```ts
import { emitDiff } from './events'
```

在 `writeEntry` 之后新增静默刷新函数：

```ts
async function revalidateInBackground(
  state: ProjectState,
  config: InternalAxiosRequestConfig,
  originalAdapter: AxiosAdapter,
  key: string,
  oldEntry: CacheEntry,
): Promise<void> {
  try {
    const response = await originalAdapter(config)
    if (response.status < 200 || response.status >= 300) return

    let same = false
    try {
      same =
        hash(stableStringify(response.data)) ===
        hash(stableStringify(oldEntry.data.data))
    } catch {
      same = false // 无法比较时保守视为不一致
    }

    if (same) {
      // 仅刷新 TTL
      const refreshed: CacheEntry = {
        ...oldEntry,
        expireAt: state.ttl === 0 ? Infinity : Date.now() + state.ttl,
      }
      await state.stores.cache.setItem(key, refreshed)
      return
    }

    await writeEntry(state, key, response)
    emitDiff({
      method: config.method ?? 'get',
      url: config.url ?? '',
      params: config.params,
      data: config.data,
      oldData: oldEntry.data.data,
      newData: response.data,
    })
  } catch {
    // 后台失败：静默保留旧缓存
  }
}
```

修改命中分支，将：

```ts
    const response = hit.data as AxiosResponse & { fromCache?: boolean }
    response.fromCache = true
    return response
```

改为：

```ts
    if (config.revalidate) {
      void revalidateInBackground(state, config, originalAdapter, key, hit)
    }
    const response = hit.data as AxiosResponse & { fromCache?: boolean }
    response.fromCache = true
    return response
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/revalidate.test.ts`
Expected: PASS（4 个用例；"数据相同刷新 TTL"若因 fake timer 下 setTimeout 行为偶发，用 `vi.useRealTimers()` 收尾或在该用例结束时还原）

- [ ] **Step 5: 运行全部测试**

Run: `npx vitest run`
Expected: PASS（全部测试）

- [ ] **Step 6: 提交**

```bash
git add src/adapter.ts tests/revalidate.test.ts
git commit -m "feat: add stale-while-revalidate with diff event subscription"
```

---

### Task 6: 降级场景与初始化幂等性

**Files:**
- Test: `tests/degrade.test.ts`

**Interfaces:**
- Consumes: 全部公开 API
- Produces: 无新接口（验证既有行为）

- [ ] **Step 1: 编写失败测试**

`tests/degrade.test.ts`:

```ts
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

import { cacheRequest } from '../src/index'

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
})
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run tests/degrade.test.ts`
Expected: 两个用例均 PASS（若幂等用例失败，检查 index.ts 中 previous 还原逻辑）

- [ ] **Step 3: 运行全部测试**

Run: `npx vitest run`
Expected: PASS（全部测试文件）

- [ ] **Step 4: 提交**

```bash
git add tests/degrade.test.ts
git commit -m "test: cover storage degradation and idempotent initialization"
```

---

### Task 7: 构建配置与 README

**Files:**
- Create: `tsup.config.ts`
- Modify: `README.md`

- [ ] **Step 1: 创建 tsup.config.ts**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2020',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
})
```

- [ ] **Step 2: 构建并校验产物**

Run:

```bash
npm run build
ls dist
```

Expected: 生成 `index.js`、`index.cjs`、`index.d.ts`（及 map）。无 TS 报错。

- [ ] **Step 3: 冒烟验证 CJS 产物可被 require、ESM 产物可被 import**

Run:

```bash
node -e "const m = require('./dist/index.cjs'); console.log(typeof m.cacheRequest, typeof m.setUserId, typeof m.clearCache, typeof m.onDiff)"
node --input-type=module -e "import('./dist/index.js').then(m => console.log(typeof m.cacheRequest))"
```

Expected: 两行均输出 `function function function function`。

- [ ] **Step 4: 重写 README.md**

```markdown
# cache-request

劫持 axios 的 GET/POST 请求，将请求结果缓存在 IndexedDB 中。以 method + url + params + data 计算 hash 作为缓存 key；命中缓存直接返回，未命中走真实请求并写入缓存。支持 TTL 过期、发版清缓存、多账号隔离、静默刷新与数据差异订阅。

## 安装

\`\`\`bash
npm install cache-request localforage axios
\`\`\`

## 快速开始

\`\`\`ts
import axios from 'axios'
import { cacheRequest, setUserId, onDiff } from 'cache-request'

// projectCode 必填：不同项目使用独立的 IndexedDB
// cacheKey：发版版本号，变化时自动清空该项目全部缓存
cacheRequest(axios, 'your-project-code', '{{{cacheKey}}}', {
  ttl: 24 * 60 * 60 * 1000, // 默认 1 天；0 表示永久
})

// 登录后设置 userId；切换账号时自动清空缓存
setUserId('user-123')
\`\`\`

## 请求级配置

**默认所有请求不缓存**，需在 config 中显式开启：

\`\`\`ts
// 开启缓存
http.get('/user/1', { cache: true })
http.post('/order', payload, { cache: true })

// 强制走网络，结果覆盖缓存
http.get('/user/1', { cache: { force: true } })

// 命中缓存后静默刷新；新旧数据不一致时通知订阅者
http.get('/feed', { cache: true, revalidate: true })
\`\`\`

## 监听数据变化

静默刷新发现新旧数据 hash 不一致时（缓存会自动更新为新数据），可订阅事件做自定义处理：

\`\`\`ts
onDiff(({ method, url, params, data, oldData, newData }) => {
  // 自行对比新旧数据，提示用户或触发重新渲染
})
\`\`\`

## API

- `cacheRequest(axiosInstance, projectCode, cacheKey, options?)`：初始化，幂等可重复调用
- `setUserId(id)`：设置当前用户；与库中不一致时清空缓存
- `clearCache()`：清空当前项目缓存（meta 保留）
- `onDiff(listener) / offDiff(listener)`：订阅/取消订阅数据差异事件

## 发版时自动清缓存（推荐做法）

本包不提供构建插件。建议在构建配置中把源码里的 `{{{cacheKey}}}` 替换为每次构建生成的随机串：

- Vite：使用 `define`
  \`\`\`ts
  // vite.config.ts
  export default {
    define: {
      '{{{cacheKey}}}': JSON.stringify(process.env.CACHE_KEY || Date.now().toString()),
    },
  }
  \`\`\`
- Webpack：使用 `DefinePlugin`
  \`\`\`js
  new webpack.DefinePlugin({ '{{{cacheKey}}}': JSON.stringify(cacheKey) })
  \`\`\`

运行时检测到 cacheKey 与 IndexedDB 中记录不一致，即判定发版，清空该项目全部接口缓存，避免新旧数据结构不一致导致渲染报错白屏。

## 说明

- 含 FormData/File/Blob 等不可序列化参数的请求自动透传，不缓存
- 只缓存 2xx 响应
- IndexedDB 不可用（隐私模式等）时静默降级为普通请求
```

- [ ] **Step 5: 提交**

```bash
git add tsup.config.ts README.md
git commit -m "chore: add tsup build config and README with usage guide"
```

---

## Self-Review 记录

- **Spec coverage：** 对外 API（§2）→ Task 4/5；存储设计（§3）→ Task 2/4；请求流程（§4）→ Task 3/5；hash（§5）→ Task 1；错误降级（§6）→ Task 3（写失败重试、enabled、抛错）、Task 6（IDB 不可用）；构建替换建议（§7）→ Task 7 README；测试策略（§8）→ 各任务测试文件，一一覆盖。
- **Task 1 package.json 的 devDependencies 占位说明**已在步骤中注明由 npm install -D 实际生成，执行者不应保留 `@vitest/coverage-vtsite` 这一错误条目。
- **类型一致性：** `ProjectState`（Task 3 定义，Task 4 使用）、`CacheEntry`（Task 1 定义）、`emitDiff`（Task 4 创建，Task 5 消费）、`getState`（Task 3 定义，Task 4 消费）签名已核对一致。
- **index.ts 已知修正点**（`require()` 非法、events 导入）已在 Task 4 Step 3/4 显式写明。
