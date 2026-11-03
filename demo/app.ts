/**
 * Demo 页面入口（源码）。
 * 经 tsup 打包为浏览器可直接运行的 IIFE（内含 axios、localforage、本包）：
 *   npx tsup demo/app.ts --format iife --platform browser --target es2020 \
 *     --out-dir demo --out-name app.bundle
 * 产物 demo/app.bundle.js 由 index.html 以普通 script 标签引入。
 */
import axios from 'axios'
import { cacheRequest, setUserId, clearCache, onDiff } from '../src/index'

const logEl = document.getElementById('log') as HTMLElement

function log(type: string, message: string, payload?: unknown) {
  const time = new Date().toLocaleTimeString()
  const div = document.createElement('div')
  div.className = `log-${type}`
  div.textContent = payload
    ? `[${time}] ${message}\n${
        typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
      }`
    : `[${time}] ${message}`
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
}

// 初始化：cacheKey 用固定串 demo-v1。实际项目中由构建工具替换为每次发版的随机串。
cacheRequest(axios, 'demo-project', 'demo-v1', {
  ttl: 60 * 1000, // demo 中设为 60 秒，便于观察过期
  ignoreParams: ['t'],
})

void setUserId('user-1').then(() => {
  log('info', '初始化完成：cacheRequest + setUserId(user-1)')
})

// 订阅静默刷新发现的数据差异
onDiff((event) => {
  log(
    'diff',
    `onDiff 收到数据变化 ${event.method.toUpperCase()} ${event.url}`,
    { oldData: event.oldData, newData: event.newData },
  )
})

async function call(config: Record<string, unknown>) {
  const res = await axios.get('/api/user', config)
  const fromCache = (res as { fromCache?: boolean }).fromCache === true
  log(
    fromCache ? 'hit' : 'net',
    fromCache ? '命中缓存，立即返回' : '走网络请求返回',
    res.data,
  )
}

interface DemoWindow extends Window {
  plainRequest: () => Promise<void>
  cachedRequest: () => Promise<void>
  forceRequest: () => Promise<void>
  revalidateRequest: () => Promise<void>
  mutateServer: () => Promise<void>
  changeUser: () => Promise<void>
  clearAll: () => Promise<void>
}

const w = window as unknown as DemoWindow

w.plainRequest = () => call({})
w.cachedRequest = () => call({ cache: true, params: { t: Date.now() } }) // t 被 ignoreParams 忽略
w.forceRequest = () => call({ cache: { force: true } })
w.revalidateRequest = () => call({ cache: true, revalidate: true })

w.mutateServer = async () => {
  const res = await axios.post('/api/mutate')
  log('info', '服务器数据已修改', res.data.user)
}

w.changeUser = async () => {
  const input = document.getElementById('userId') as HTMLInputElement
  const id = input.value.trim()
  if (!id) {
    log('err', 'userId 不能为空')
    return
  }
  await setUserId(id)
  log('info', `setUserId("${id}") 完成，缓存已按规则处理`)
}

w.clearAll = async () => {
  await clearCache()
  log('info', 'clearCache() 完成，当前项目缓存已清空')
}
