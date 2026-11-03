# cache-request

劫持 axios 的 GET/POST 请求，将请求结果缓存在 IndexedDB 中。以 method + url + params + data 计算 hash 作为缓存 key；命中缓存直接返回，未命中走真实请求并写入缓存。支持 TTL 过期、发版清缓存、多账号隔离、静默刷新与数据差异订阅。

## 安装

```bash
npm install cache-request localforage axios
```

## 快速开始

```ts
import axios from 'axios'
import { cacheRequest, setUserId, onDiff } from 'cache-request'

// projectCode 必填：不同项目使用独立的 IndexedDB
// cacheKey：发版版本号，变化时自动清空该项目全部缓存
cacheRequest(axios, 'your-project-code', '{{{cacheKey}}}', {
  ttl: 24 * 60 * 60 * 1000, // 默认 1 天；0 表示永久
})

// 登录后设置 userId；切换账号时自动清空缓存
setUserId('user-123')
```

## 请求级配置

**默认所有请求不缓存**，需在 config 中显式开启：

```ts
// 开启缓存
http.get('/user/1', { cache: true })
http.post('/order', payload, { cache: true })

// 强制走网络，结果覆盖缓存
http.get('/user/1', { cache: { force: true } })

// 命中缓存后静默刷新；新旧数据不一致时通知订阅者
http.get('/feed', { cache: true, revalidate: true })

// 单请求忽略随机参数（与全局 ignoreParams 取并集）
http.get('/api', { cache: true, ignoreParams: ['v'] })
```

## 忽略参数（ignoreParams）

请求中带随机参数（如 v、t）会导致缓存永不命中。可在计算缓存 key 时忽略这些参数（仅删除 params/data 顶层 key，真实请求不被篡改；全局与单请求配置取并集）：

```ts
// 全局
cacheRequest(axios, 'project', '{{{cacheKey}}}', { ignoreParams: ['v', 't'] })

// 单请求
http.get('/api', { cache: true, ignoreParams: ['v'] })
```

## 监听数据变化

静默刷新发现新旧数据 hash 不一致时（缓存会自动更新为新数据），可订阅事件做自定义处理：

```ts
onDiff(({ method, url, params, data, oldData, newData }) => {
  // 自行对比新旧数据，提示用户或触发重新渲染
})
```

## API

- `cacheRequest(axiosInstance, projectCode, cacheKey, options?)`：初始化，幂等可重复调用
  - `options.ttl`：缓存有效期（毫秒），默认 1 天；`0` 表示永久
  - `options.ignoreParams`：计算缓存 key 时忽略的 params/data 顶层参数名
- `setUserId(id)`：设置当前用户；与库中不一致时清空缓存
- `clearCache()`：清空当前项目缓存（meta 保留）
- `onDiff(listener) / offDiff(listener)`：订阅/取消订阅数据差异事件

## 发版时自动清缓存（推荐做法）

本包不提供构建插件。建议在构建配置中把源码里的 `{{{cacheKey}}}` 替换为每次构建生成的随机串：

- Vite：使用 `define`
  ```ts
  // vite.config.ts
  export default {
    define: {
      '{{{cacheKey}}}': JSON.stringify(process.env.CACHE_KEY || Date.now().toString()),
    },
  }
  ```
- Webpack：使用 `DefinePlugin`
  ```js
  new webpack.DefinePlugin({ '{{{cacheKey}}}': JSON.stringify(cacheKey) })
  ```

运行时检测到 cacheKey 与 IndexedDB 中记录不一致，即判定发版，清空该项目全部接口缓存，避免新旧数据结构不一致导致渲染报错白屏。

## 说明

- 含 FormData/File/Blob 等不可序列化参数的请求自动透传，不缓存
- 只缓存 2xx 响应
- IndexedDB 不可用（隐私模式等）时静默降级为普通请求
