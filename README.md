# cache-request

劫持 axios 的 GET/POST 请求，将请求结果缓存在 IndexedDB 中。以 method + url + params + data 计算 hash 作为缓存 key；命中缓存直接返回，未命中走真实请求并写入缓存。支持 TTL 过期、发版清缓存、多账号隔离、静默刷新与数据差异订阅。

## 安装

在你的业务项目中安装本包：

```bash
npm install @only_on_world/axios-cache axios
```

其他包管理器：

```bash
pnpm add @only_on_world/axios-cache axios
yarn add @only_on_world/axios-cache axios
```

> 说明：
> - `axios` 是 peer dependency，需由宿主项目自行安装（支持 `axios@^1.0.0`）
> - `localforage` 是本包的运行时依赖，会自动安装，无需手动处理

## 快速开始

```ts
import axios from 'axios'
import { cacheRequest, setUserId, onDiff } from '@only_on_world/axios-cache'

// projectCode 必填：不同项目使用独立的 IndexedDB
// cacheKey：发版版本号，变化时自动清空该项目全部缓存
cacheRequest(axios, 'your-project-code', __AXIOS_CACHE_KEY__, {
  ttl: 24 * 60 * 60 * 1000, // 默认 1 天；0 表示永久
  ignoreParams: ['t'] ,
})

// 登录后设置 userId；切换账号时自动清空缓存，强烈建议设置
setUserId('user-123')
```

## 本地 Demo 快速体验

仓库内置一个可交互的 demo，包含一个**纯 Node.js 内置模块实现的接口服务器**（无 express/koa）。demo 逻辑经 tsup 打包为一个 IIFE（内含 axios、localforage、本包），页面无需任何 CDN：

```bash
npm install      # 仅首次
npm run demo     # 打包 demo 并启动服务器
```

浏览器打开 http://127.0.0.1:5174 ，可体验：缓存命中（秒回）/ 强制刷新 / 静默刷新与 onDiff 差异事件 / setUserId 切换清缓存 / clearCache。

> 注意：不要用 Live Server 直接打开 `demo/index.html`——接口与打包产物都由 demo 服务器提供。

## 请求级配置

**默认所有请求不缓存**，需在 config 中显式开启：

```ts
// 开启缓存
http.get('/user/1', { cache: true })
http.post('/order', payload, { cache: true })

// 强制走网络，结果覆盖缓存
http.get('/user/1', { cache: { force: true } })

// 命中缓存后静默刷新（即命中缓存后返回缓存内容，同时在后台另外发起请求，拿到请求回来的数据后与旧数据做对比，一致则覆盖数据缓存过期时间，不一致则通知订阅者，并覆盖indexedDB中的旧数据）
http.get('/feed', { cache: true, revalidate: true })

// 单请求忽略随机参数（与全局 ignoreParams 取并集）
http.get('/api', { cache: true, ignoreParams: ['v'] })
```

## 忽略参数（ignoreParams）

请求中带随机参数（如 v、t）会导致缓存永不命中。可在计算缓存 key 时忽略这些参数（仅删除 params/data 顶层 key，真实请求不被篡改；全局与单请求配置取并集）：

```ts
// 全局
cacheRequest(axios, 'project', __AXIOS_CACHE_KEY__, { ignoreParams: ['v', 't'] })

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

本包不提供构建插件。建议在构建配置中把源码里的 `__AXIOS_CACHE_KEY__` 替换为每次构建生成的随机串：

- Vite：使用 `define`
  ```ts
  // vite.config.ts
  import { defineConfig } from 'vite'

  function randomKey(len = 12) {
    let out = ''
    while (out.length < len) out += Math.random().toString(36).slice(2)
    return out.slice(0, len)
  }

  export default defineConfig(({ command }) => {
    const cacheKey = command === 'build' ? randomKey(12) : 'dev-cache-key'

    return {
      define: {
        __AXIOS_CACHE_KEY__: JSON.stringify(cacheKey),
      },
    }
  })
  ```
- Webpack：使用 `DefinePlugin`
  ```js
  // webpack.config.js
  const webpack = require('webpack')

  function randomKey(len = 12) {
    let out = ''
    while (out.length < len) out += Math.random().toString(36).slice(2)
    return out.slice(0, len)
  }

  module.exports = (env, argv) => {
    const isDev = argv.mode !== 'production'
    const cacheKey = isDev ? 'dev-cache-key' : randomKey(12)

    return {
      // ...其他配置
      plugins: [
        new webpack.DefinePlugin({
          __AXIOS_CACHE_KEY__: JSON.stringify(cacheKey),
        }),
      ],
    }
  }

  ```

运行时检测到 cacheKey 与 IndexedDB 中记录不一致，即判定发版，清空该项目全部接口缓存，避免新旧数据结构不一致导致渲染报错白屏。

## 说明

- 含 FormData/File/Blob 等不可序列化参数的请求自动透传，不缓存
- 只缓存 2xx 响应
- IndexedDB 不可用（隐私模式等）时静默降级为普通请求
