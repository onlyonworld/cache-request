/**
 * demo 用的极简服务器：纯 Node.js 内置 http 模块（无 express/koa）。
 *
 * 职责：
 * 1. 提供体验用的接口（GET /api/user、POST /api/order、POST /api/mutate）
 * 2. 托管 demo/index.html
 * 3. 把本地构建的 dist/index.js 和 localforage 作为静态资源提供给浏览器
 *
 * 启动：先在项目根目录执行 `npm run build`，再 `node demo/server.js`
 * 访问：http://127.0.0.1:5174
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5174

// 服务器内存中的“用户信息”：点页面上的“修改服务器数据”后 version 递增，
// 这样静默刷新（revalidate）能稳定观察到新旧数据差异。
const userInfo = { version: 1, name: 'Alice', role: 'admin' }

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) return resolve(null)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('request body must be valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function serveStatic(res, filePath, contentType) {
  const data = await readFile(filePath)
  res.writeHead(200, { 'content-type': contentType })
  res.end(data)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const { pathname } = url

  try {
    // ---------- 接口 ----------
    if (req.method === 'GET' && pathname === '/api/user') {
      // 延迟 300ms，方便观察“走网络”与“命中缓存”在速度上的差异
      setTimeout(() => sendJson(res, 200, { ...userInfo }), 300)
      return
    }

    if (req.method === 'POST' && pathname === '/api/order') {
      const body = await readBody(req)
      sendJson(res, 200, { orderId: Math.floor(Math.random() * 1e6), echo: body })
      return
    }

    if (req.method === 'POST' && pathname === '/api/mutate') {
      userInfo.version += 1
      console.log('[server] user info changed ->', userInfo)
      sendJson(res, 200, { ok: true, user: { ...userInfo } })
      return
    }

    // ---------- 静态资源 ----------
    if (req.method === 'GET' && pathname === '/') {
      await serveStatic(
        res,
        path.join(root, 'demo/index.html'),
        'text/html; charset=utf-8',
      )
      return
    }

    // demo 打包产物（IIFE，内含 axios/localforage/本包）
    if (req.method === 'GET' && pathname === '/app.bundle.global.js') {
      await serveStatic(
        res,
        path.join(root, 'demo/app.bundle.global.js'),
        'application/javascript',
      )
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[server] error:', err)
    sendJson(res, 500, { error: String(err && err.message) })
  }
})

server.listen(PORT, () => {
  console.log(`demo server running at http://127.0.0.1:${PORT}`)
  console.log('tip: 先在项目根目录执行 npm run build 生成 dist 产物')
})
