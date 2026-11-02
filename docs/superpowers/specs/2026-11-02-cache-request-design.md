# cache-request 设计文档

日期：2026-11-02

## 1. 概述与目标

`cache-request` 是一个劫持 axios GET/POST 请求的运行时库：使用请求的 method、api、参数计算 hash，以 hash 为 key 查询 IndexedDB（经 localforage 访问）。命中缓存则立即返回缓存响应；未命中则走真实 axios 请求，并在成功响应后将 hash 与响应数据写入缓存。

同时支持：

- 默认 TTL 过期（默认 1 天），支持永久缓存
- 发版时通过构建期替换随机串（cacheKey）检测版本变化，自动清空旧缓存，避免新旧接口数据结构不一致导致页面白屏
- 通过稳定的 userId 实现多账号缓存隔离，切换账号自动清缓存
- 按 projectCode 使用独立 IndexedDB，多项目共存互不影响
- 命中缓存后可选静默刷新（stale-while-revalidate），新旧数据 hash 不一致时通过订阅事件通知业务方

非目标：

- 不提供构建期替换 `{{{cacheKey}}}` 的插件，仅在 README 中建议业务方使用 Vite `define` / Webpack `DefinePlugin` 自行实现
- 不做跨浏览器标签页的缓存实时同步

技术约束：TypeScript 编写；运行时唯一依赖 `localforage`。

## 2. 对外 API

### 初始化

```ts
import axios from 'axios'
import { cacheRequest } from 'cache-request'

cacheRequest(axios, 'project-code', '{{{cacheKey}}}', {
  ttl: 24 * 60 * 60 * 1000, // 默认 1 天；0 表示永久
})
```

签名：

```ts
function cacheRequest(
  axiosInstance: AxiosStatic | AxiosInstance,
  projectCode: string,
  cacheKey: string,
  options?: { ttl?: number },
): void
```

- `projectCode` 必填，缺失时同步抛出 `TypeError`
- 首参不是 axios 实例时同步抛出 `TypeError`
- 修改传入实例的 `defaults.adapter`，包裹其原 adapter 作为网络回退
- 幂等：重复调用时先还原上一次保存的原 adapter 再重新包裹，避免多层嵌套
- 内部维护已初始化实例与项目的映射，支持单页面多个 axios 实例、多个 projectCode

### 具名导出的管理方法

业务方无需保存初始化返回值，直接具名导入。方法作用于最近一次初始化的项目（projectCode）：

```ts
import { setUserId, clearCache, onDiff, offDiff } from 'cache-request'

setUserId('u_123')
clearCache()

const unsubscribe = onDiff((event) => {})
offDiff(callback)
```

- `setUserId(id: string | number | null): Promise<void>`
  - 与当前项目 meta 中记录的 userId 比对，不一致（含从有到无）时清空该项目缓存并更新 userId
  - 异步执行；期间发出的请求等待该操作完成后再计算缓存 key，避免串号
- `clearCache(): Promise<void>`
  - 清空当前项目的缓存 store，meta（version/userId）保留
- `onDiff(callback): () => void`
  - 订阅静默刷新发现的数据不一致事件；返回取消订阅函数
- `offDiff(callback): void`
  - 取消指定订阅

### 请求级配置

**初始化只注入缓存能力，默认所有请求不缓存**，必须在请求 config 中显式开启：

```ts
http.get('/user/1', { cache: true })
http.post('/order', payload, { cache: true })

// 命中缓存后静默刷新；新旧数据不一致时通知 onDiff 订阅者
http.get('/feed', { cache: true, revalidate: true })

// 强制走网络，成功后覆盖写入缓存
http.get('/user/1', { cache: { force: true } })
```

config 扩展（扩展 axios 的类型声明）：

```ts
declare module 'axios' {
  interface AxiosRequestConfig {
    cache?: boolean | { force?: boolean }
    revalidate?: boolean
  }
}
```

- 不配置 `cache`（或为 false）：不读不写，纯透传
- `cache: true`：开启缓存，使用全局 TTL
- `cache: { force: true }`：强制请求，结果覆盖缓存

## 3. 存储设计（localforage + 按项目分库）

每个 projectCode 使用独立的 IndexedDB 数据库，库名 `cache-request-${projectCode}`，库内两个 localforage 实例：

```ts
const cacheStore = localforage.createInstance({
  name: `cache-request-${projectCode}`,
  storeName: 'cache',
})

const metaStore = localforage.createInstance({
  name: `cache-request-${projectCode}`,
  storeName: 'meta',
})
```

### cache store

一条接口缓存一条记录，key 为 hash：

```ts
interface CacheEntry {
  data: AxiosResponse // 完整响应（status/statusText/headers/data 等）
  createdAt: number
  expireAt: number // 过期时间戳；Infinity 表示永久
}

// cacheStore.getItem(key) / setItem(key, entry)
```

缓存 key 计算：

```ts
key = hash(stableStringify({ userId, method, url, params, data }))
```

- userId 纳入 hash，作为切换瞬间的二次隔离
- 单条读取只结构化克隆该条响应
- 不同 key 的并发写入天然互不覆盖

### meta store

固定单条记录，key 为 `'meta'`：

```ts
interface MetaRecord {
  version: string // 上次发版写入的 cacheKey
  userId: string | number | null
}
```

### 清理行为

localforage 的 `clear()` 只清当前 store，不碰同库其他 store：

| 场景 | 操作 |
|---|---|
| 发版（cacheKey 与 meta.version 不一致） | `cacheStore.clear()`，更新 meta.version |
| 切换用户（userId 不一致） | `cacheStore.clear()`，更新 meta.userId |
| `clearCache()` | `cacheStore.clear()`，meta 保留 |
| 首次使用（meta 不存在） | 写入 meta，不清理 |

其他项目是独立数据库，完全不受影响。

## 4. 请求处理流程

adapter 内部流程：

```
请求进入
  │
  ├─ config.cache 未开启 ───────────────→ 调用原 adapter，不读不写
  │
  ├─ params/data 不可结构化序列化
  │  （FormData/File/Blob/ArrayBuffer/函数/Symbol/DOM 节点/循环引用）
  │                                      → 调用原 adapter，不读不写
  │
  ├─ 计算缓存 key（见第 3 节）
  │
  ├─ cache.force: true ─────────────────→ 原 adapter 请求，成功后覆盖写入缓存
  │
  ├─ cacheStore.getItem(key)
  │    ├─ 读失败 ──────────────────────→ 视为未命中
  │    ├─ 未命中 / expireAt 已过期 ────→ 原 adapter 请求
  │    │                                   成功(2xx) → 写入缓存后返回
  │    │
  │    └─ 命中 ─→ 立即构造 AxiosResponse 返回，
  │               标记 response.fromCache = true
  │               └─ revalidate: true ─→ 异步调用原 adapter（不阻塞、
  │                     不改变已返回的 Promise）：
  │                       · 新旧响应 data 的 hash 相同 → 仅刷新 expireAt
  │                       · hash 不同 → 覆盖缓存（刷新 TTL）+ 触发 diff 事件
  │                       · 请求失败 → 静默忽略，保留旧缓存
  │
  └─ 原 adapter 抛错 ───────────────────→ 原样抛出，不吞错、不写缓存
```

要点：

1. TTL：`expireAt = now + ttl`；`ttl: 0` 表示永久（expireAt = Infinity）。过期等同未命中。
2. 只缓存成功响应：`status >= 200 && < 300`（业务方 `validateStatus` 决定的 resolve/reject 语义不变）。
3. 静默刷新与主流程完全隔离：后台请求失败、订阅回调抛错均不影响页面，也不改变已返回给业务方的数据。
4. 初始化异步完成（DB 打开 + meta 校验），但不阻塞业务方发请求；adapter 内部 await 一个 `readyPromise`，校验完成后才读缓存。

### diff 事件结构

```ts
interface CacheDiffEvent {
  method: string
  url: string
  params?: unknown
  data?: unknown // 请求参数（POST body）
  oldData: unknown // 旧响应的 data
  newData: unknown // 新响应的 data
}
```

## 5. Hash 与序列化

包内零依赖、同步实现两个工具：

### stableStringify(value)

- 普通对象的 key 按字典序递归排序后序列化：`{a:1,b:2}` 与 `{b:2,a:1}` 结果相同
- 数组保持原顺序（顺序是参数语义的一部分）
- `undefined` / `null` 按固定规则处理
- 遇到 FormData / File / Blob / ArrayBuffer / 函数 / Symbol / DOM 节点 / 循环引用时抛出内部标记错误，adapter 捕获后对该请求透传不缓存

### hash(string)

djb2 变体，输出 hex 字符串。同步执行（Web Crypto 的 digest 为异步，不适合 adapter 内同步算 key）。输入空间为同项目内的接口参数，碰撞风险可接受。

两处用途：

```ts
key = hash(stableStringify({ userId, method, url, params, data }))
dataHash = hash(stableStringify(response.data)) // 静默刷新对比
```

响应数据若无法稳定序列化（极少），静默刷新时保守地视为"不一致"：更新缓存并通知订阅者，不漏掉任何变化。

## 6. 错误处理与降级

| 情况 | 行为 |
|---|---|
| IndexedDB/localforage 不可用（隐私模式、浏览器不支持） | 标记 `enabled = false`，全部请求静默走原 adapter，包永不抛出影响业务 |
| 初始化 DB 打开 / meta 校验失败 | 同上，降级纯透传 |
| 读单条缓存失败（记录损坏） | 视为未命中 |
| 写缓存失败（配额超限等） | 尝试 `cacheStore.clear()` 后重写一次；仍失败则放弃写入，不影响返回 |
| 静默刷新后台请求失败 | 静默忽略，保留旧缓存，不触发 diff |
| onDiff 回调内部抛错 | 捕获隔离，不影响其他订阅者与缓存逻辑 |
| 原 adapter 请求失败 | 原样抛出，不写缓存 |
| projectCode 缺失 / 首参非 axios 实例 | 初始化阶段同步抛 TypeError（接入错误早暴露） |
| 非 2xx 响应 | 不缓存 |

## 7. 构建期 cacheKey 替换（非本包范围）

README 中建议业务方：

- Vite：使用 `define` 将 `{{{cacheKey}}}` 替换为每次构建生成的随机串/hash
- Webpack：使用 `DefinePlugin` 做等价替换

运行时 `cacheRequest(axios, projectCode, cacheKey)` 在初始化阶段比对传入 cacheKey 与 meta.version；不一致即判定发版，清空该项目全部接口缓存后写入新 version。

## 8. 测试策略

Vitest + fake-indexeddb，不依赖真实浏览器：

1. **序列化/hash 单测**：key 顺序无关、数组顺序敏感、嵌套对象、不可序列化识别、循环引用
2. **adapter 流程**（mock 原 adapter）：
   - 默认不缓存；`cache: true` 首次写入、二次命中
   - TTL 过期视为未命中；`ttl: 0` 永不过期
   - `force: true` 覆盖写入
   - FormData 等不可序列化请求透传
   - 非 2xx 不缓存；原 adapter 报错原样抛出
3. **隔离与清理**：cacheKey 变化清库；setUserId 不一致清库；多 projectCode 使用不同 DB 互不影响
4. **静默刷新**：命中立即返回旧数据；数据相同仅刷新 TTL；数据不同覆盖缓存且 diff 回调收到完整 event；后台失败不影响主流程；多订阅者与回调抛错隔离
5. **降级**：localforage 抛错时全部请求正常透传
6. **幂等性**：重复调用 `cacheRequest` 不产生多层 adapter 嵌套
