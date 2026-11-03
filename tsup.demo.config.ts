import { defineConfig } from 'tsup'

/**
 * demo 专用打包配置：把 demo/app.ts 连同 axios、localforage、本包
 * 打成一个浏览器 IIFE（app.bundle.js），页面以普通 script 引入，零 CDN。
 * 与主构建（tsup.config.ts）互不影响。
 */
export default defineConfig({
  // key 即产物名（无扩展名）：输出 demo/app.bundle.js
  entry: { 'app.bundle': 'demo/app.ts' },
  format: ['iife'],
  platform: 'browser',
  target: 'es2020',
  outDir: 'demo',
  globalName: 'CacheRequestDemo',
  clean: false,
  sourcemap: false,
  loader: { '.ts': 'ts' },
})
